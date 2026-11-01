// Battleship-Engine: Wahrscheinlichkeiten, Entropie, Schussauswahl.
// Läuft im Browser (Web Worker) und in Node (Benchmark/Tests).
//
// Kernidee: Wir betrachten ganze Flottenaufstellungen (alle Schiffe gleichzeitig),
// die zu allen bisherigen Beobachtungen passen. Jede solche Aufstellung ist gleich
// wahrscheinlich (zufällige Aufstellung). Daraus ergibt sich für jedes Feld
//   - P(Schiff)          -> Trefferwahrscheinlichkeit
//   - P(Versenkt)        -> Wahrscheinlichkeit, dass ein Schuss dort ein Schiff versenkt
//   - Entropie           -> wie viel Information der Schuss im Mittel liefert
// Ist die Zahl der Aufstellungen klein genug, wird exakt gezählt, sonst per
// gewichteter Zufallsstichprobe (Sequential Importance Sampling) geschätzt.

export const UNKNOWN = 0;
export const MISS = 1;
export const HIT = 2;
export const SUNK = 3;
export const BLOCKED = 4; // automatisch Wasser (Rand um ein versenktes Schiff)

export const DEFAULT_CONFIG = {
  rows: 9,
  cols: 9,
  fleet: [
    { length: 4, count: 3 },
    { length: 3, count: 5 },
  ],
  diagonalTouch: false, // false = Schiffe dürfen sich auch diagonal nicht berühren
};

// ---------------------------------------------------------------------------
// Geometrie: alle möglichen Schiffspositionen als Bitmasken
// ---------------------------------------------------------------------------

const geometryCache = new Map();

export function getGeometry(rows, cols, diagonalTouch, lengths) {
  const key = `${rows}x${cols}:${diagonalTouch ? 1 : 0}:${[...lengths].sort().join(',')}`;
  let g = geometryCache.get(key);
  if (!g) {
    g = buildGeometry(rows, cols, diagonalTouch, lengths);
    geometryCache.set(key, g);
  }
  return g;
}

function buildGeometry(rows, cols, diagonalTouch, lengths) {
  const n = rows * cols;
  const W = Math.ceil(n / 32);
  const uniqueLengths = [...new Set(lengths)].sort((a, b) => b - a);

  const neighbors = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const list = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          if (diagonalTouch && dr && dc) continue;
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) list.push(rr * cols + cc);
        }
      }
      neighbors.push(list);
    }
  }

  // Positionen je Länge
  const byLength = new Map();
  for (const len of uniqueLengths) {
    const cellsList = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (c + len <= cols) {
          const cells = [];
          for (let i = 0; i < len; i++) cells.push(r * cols + c + i);
          cellsList.push(cells);
        }
        if (len > 1 && r + len <= rows) {
          const cells = [];
          for (let i = 0; i < len; i++) cells.push((r + i) * cols + c);
          cellsList.push(cells);
        }
      }
    }
    const P = cellsList.length;
    const cellMask = new Int32Array(P * W);
    const ringMask = new Int32Array(P * W);
    const haloMask = new Int32Array(P * W); // Zellen + Rand
    const cellIdx = new Int16Array(P * len);
    const byCell = Array.from({ length: n }, () => []);
    cellsList.forEach((cells, p) => {
      const own = new Set(cells);
      cells.forEach((x, i) => {
        cellIdx[p * len + i] = x;
        cellMask[p * W + (x >>> 5)] |= 1 << (x & 31);
        byCell[x].push(p);
      });
      for (const x of cells) {
        for (const y of neighbors[x]) {
          if (!own.has(y)) ringMask[p * W + (y >>> 5)] |= 1 << (y & 31);
        }
      }
      for (let w = 0; w < W; w++) haloMask[p * W + w] = cellMask[p * W + w] | ringMask[p * W + w];
    });
    byLength.set(len, {
      len,
      count: P,
      cellMask,
      ringMask,
      haloMask,
      cellIdx,
      byCell: byCell.map((a) => Int32Array.from(a)),
    });
  }
  return { rows, cols, n, W, diagonalTouch, neighbors, byLength, lengths: uniqueLengths };
}

// ---------------------------------------------------------------------------
// Spielzustand
// ---------------------------------------------------------------------------

export function newGame(config = DEFAULT_CONFIG) {
  const cfg = normalizeConfig(config);
  return {
    config: cfg,
    cells: new Uint8Array(cfg.rows * cfg.cols),
    remaining: Object.fromEntries(cfg.fleet.map((f) => [f.length, f.count])),
    sunkShips: [], // [{length, cells}]
    shots: 0,
    misses: 0,
  };
}

export function normalizeConfig(config) {
  const fleet = config.fleet
    .filter((f) => f.count > 0 && f.length > 0)
    .map((f) => ({ length: f.length | 0, count: f.count | 0 }))
    .sort((a, b) => b.length - a.length);
  return { rows: config.rows | 0, cols: config.cols | 0, fleet, diagonalTouch: !!config.diagonalTouch };
}

export function cloneGame(g) {
  return {
    config: g.config,
    cells: g.cells.slice(),
    remaining: { ...g.remaining },
    sunkShips: g.sunkShips.map((s) => ({ length: s.length, cells: s.cells.slice() })),
    shots: g.shots,
    misses: g.misses,
  };
}

export function remainingShipCount(g) {
  return Object.values(g.remaining).reduce((a, b) => a + b, 0);
}

export function isFinished(g) {
  return remainingShipCount(g) === 0;
}

function neighborsOf(g, x) {
  const { rows, cols, diagonalTouch } = g.config;
  return getGeometry(rows, cols, diagonalTouch, g.config.fleet.map((f) => f.length)).neighbors[x];
}

/** Orthogonal zusammenhängende Treffer-Gruppe, zu der Feld x gehört. */
export function hitComponent(g, x) {
  const { cols } = g.config;
  const seen = new Set([x]);
  const stack = [x];
  while (stack.length) {
    const y = stack.pop();
    const r = Math.floor(y / cols), c = y % cols;
    const cand = [];
    if (r > 0) cand.push(y - cols);
    if (r < g.config.rows - 1) cand.push(y + cols);
    if (c > 0) cand.push(y - 1);
    if (c < cols - 1) cand.push(y + 1);
    for (const z of cand) {
      if (!seen.has(z) && g.cells[z] === HIT) {
        seen.add(z);
        stack.push(z);
      }
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Trägt ein Schussergebnis ein. result: 'miss' | 'hit' | 'sunk'.
 * Gibt {ok:true} oder {ok:false, error} zurück (Zustand bleibt dann unverändert).
 */
export function applyShot(g, x, result) {
  const cur = g.cells[x];
  if (result === 'miss') {
    if (cur !== UNKNOWN && cur !== BLOCKED) return { ok: false, error: 'Feld ist schon belegt.' };
    g.cells[x] = MISS;
    g.shots++;
    g.misses++;
    return { ok: true };
  }
  if (cur !== UNKNOWN && !(result === 'sunk' && cur === HIT)) {
    return { ok: false, error: 'Feld wurde schon beschossen.' };
  }
  const prev = g.cells[x];
  g.cells[x] = HIT;
  if (result === 'hit') {
    g.shots++;
    return { ok: true };
  }
  // versenkt
  const comp = hitComponent(g, x);
  const { cols } = g.config;
  const rowsSet = new Set(comp.map((y) => Math.floor(y / cols)));
  const colsSet = new Set(comp.map((y) => y % cols));
  const straight = rowsSet.size === 1 || colsSet.size === 1;
  const len = comp.length;
  if (!straight) {
    g.cells[x] = prev;
    return { ok: false, error: 'Die Treffer bilden keine gerade Linie.' };
  }
  if (!g.remaining[len]) {
    g.cells[x] = prev;
    const left = Object.entries(g.remaining).filter(([, c]) => c > 0).map(([l]) => l).join(', ');
    return {
      ok: false,
      error: `Ein ${len}er-Schiff ist nicht (mehr) in der Flotte. Übrig: ${left || 'nichts'}.`,
    };
  }
  if (prev === UNKNOWN) g.shots++;
  for (const y of comp) g.cells[y] = SUNK;
  for (const y of comp) {
    for (const z of neighborsOf(g, y)) {
      if (g.cells[z] === UNKNOWN) g.cells[z] = BLOCKED;
    }
  }
  g.remaining[len]--;
  g.sunkShips.push({ length: len, cells: comp });
  return { ok: true, sunkLength: len, cells: comp };
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function buildContext(g) {
  const { rows, cols, diagonalTouch } = g.config;
  const lengths = g.config.fleet.map((f) => f.length);
  const geo = getGeometry(rows, cols, diagonalTouch, lengths);
  const { W, n } = geo;
  const forbidden = new Int32Array(W); // Wasser, versenkte Schiffe und deren Rand
  const hits = new Int32Array(W); // Treffer, die noch zu keinem versenkten Schiff gehören
  for (let x = 0; x < n; x++) {
    const v = g.cells[x];
    if (v === MISS || v === SUNK || v === BLOCKED) forbidden[x >>> 5] |= 1 << (x & 31);
    else if (v === HIT) hits[x >>> 5] |= 1 << (x & 31);
  }
  for (const s of g.sunkShips) {
    for (const y of s.cells) for (const z of geo.neighbors[y]) forbidden[z >>> 5] |= 1 << (z & 31);
  }
  const types = geo.lengths
    .filter((len) => g.remaining[len] > 0)
    .map((len) => ({ len, count: g.remaining[len], geo: geo.byLength.get(len) }));
  return { geo, W, n, forbidden, hits, types };
}

/**
 * Darf Position p (vom Typ t) gelegt werden?
 *  - keine Überschneidung mit Wasser/versenkt/Rand/bereits gelegten Schiffen (F)
 *  - kein fremder Treffer direkt daneben (der gehörte sonst zu einem berührenden Schiff)
 *  - nicht nur aus Treffern bestehen (dann wäre es schon als versenkt gemeldet worden)
 */
function legal(t, p, F, H, W) {
  const base = p * W;
  let anyFree = 0;
  for (let w = 0; w < W; w++) {
    const cm = t.cellMask[base + w];
    if (cm & F[w]) return false;
    if (t.ringMask[base + w] & H[w]) return false;
    anyFree |= cm & ~H[w];
  }
  return anyFree !== 0;
}

function firstBit(M, W) {
  for (let w = 0; w < W; w++) {
    const v = M[w];
    if (v) return (w << 5) + (31 - Math.clz32(v & -v));
  }
  return -1;
}

const FACT = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800, 39916800];
const fact = (k) => (k < FACT.length ? FACT[k] : k * fact(k - 1));

/**
 * Accumulator für eine Aufstellung (Liste von [Typ, Position]) mit Gewicht w.
 * occ[x]  += w, wenn auf x ein Schiff liegt
 * sunk[x] += w, wenn ein Schuss auf x ein Schiff versenken würde
 */
function accumulate(acc, placed, w, ctx) {
  const { W, hits } = ctx;
  for (let i = 0; i < placed.length; i += 2) {
    const t = placed[i], p = placed[i + 1];
    const len = t.len;
    let unknownCount = 0, lastUnknown = -1;
    for (let k = 0; k < len; k++) {
      const x = t.cellIdx[p * len + k];
      if (!(hits[x >>> 5] & (1 << (x & 31)))) {
        unknownCount++;
        lastUnknown = x;
        acc.occ[x] += w;
      }
    }
    if (unknownCount === 1) acc.sunk[lastUnknown] += w;
  }
  acc.total += w;
  acc.totalSq += w * w;
}

/** Gewichtete Zufallsstichprobe (Sequential Importance Sampling). */
function sample(ctx, samples, rng, acc) {
  const { W, forbidden, hits, types } = ctx;
  const F = new Int32Array(W);
  const U = new Int32Array(W);
  const counts = new Int32Array(types.length);
  const opts = new Int32Array(4096);
  const optType = new Int32Array(4096);
  const placed = [];
  let valid = 0;
  for (let s = 0; s < samples; s++) {
    F.set(forbidden);
    U.set(hits);
    for (let i = 0; i < types.length; i++) counts[i] = types[i].count;
    placed.length = 0;
    let w = 1;
    let dead = false;

    // Phase 1: jeden offenen Treffer mit genau einem Schiff abdecken.
    // (Das Schiff, das den "ersten" offenen Treffer abdeckt, ist eindeutig ->
    //  jede Aufstellung wird über genau einen Pfad erzeugt.)
    let h;
    while ((h = firstBit(U, W)) >= 0) {
      let m = 0;
      for (let i = 0; i < types.length; i++) {
        if (!counts[i]) continue;
        const t = types[i].geo;
        const list = t.byCell[h];
        for (let j = 0; j < list.length; j++) {
          if (legal(t, list[j], F, hits, W)) {
            opts[m] = list[j];
            optType[m++] = i;
          }
        }
      }
      if (!m) { dead = true; break; }
      const k = (rng() * m) | 0;
      const ti = optType[k], p = opts[k], t = types[ti].geo;
      w *= m;
      counts[ti]--;
      for (let x = 0; x < W; x++) {
        F[x] |= t.haloMask[p * W + x];
        U[x] &= ~t.cellMask[p * W + x];
      }
      placed.push(t, p);
    }
    if (dead) { acc.total += 0; acc.drawn++; continue; }

    // Phase 2: restliche Schiffe frei platzieren (gleiche Schiffe sind
    // ununterscheidbar -> am Ende durch k! teilen).
    for (let i = 0; i < types.length && !dead; i++) {
      const t = types[i].geo;
      const k0 = counts[i];
      for (let c = 0; c < k0; c++) {
        let m = 0;
        for (let p = 0; p < t.count; p++) {
          const base = p * W;
          let ok = true;
          for (let x = 0; x < W; x++) if (t.cellMask[base + x] & F[x]) { ok = false; break; }
          if (ok) opts[m++] = p;
        }
        if (!m) { dead = true; break; }
        const p = opts[(rng() * m) | 0];
        w *= m;
        for (let x = 0; x < W; x++) F[x] |= t.haloMask[p * W + x];
        placed.push(t, p);
      }
      w /= fact(k0);
    }
    acc.drawn++;
    if (dead) continue;
    valid++;
    accumulate(acc, placed, w, ctx);
  }
  return valid;
}

/** Exakte Aufzählung aller passenden Aufstellungen (mit Abbruch-Budget). */
function enumerate(ctx, budget, acc) {
  const { W, forbidden, hits, types } = ctx;
  const counts = types.map((t) => t.count);
  const placed = [];
  let nodes = 0;
  let aborted = false;
  const Fstack = [Int32Array.from(forbidden)];
  const Ustack = [Int32Array.from(hits)];

  function phase2(depth, ti, minP) {
    if (aborted) return;
    while (ti < types.length && counts[ti] === 0) { ti++; minP = 0; }
    if (ti >= types.length) {
      accumulate(acc, placed, 1, ctx);
      return;
    }
    const t = types[ti].geo;
    const F = Fstack[depth];
    const F2 = Fstack[depth + 1] || (Fstack[depth + 1] = new Int32Array(W));
    for (let p = minP; p < t.count; p++) {
      if (++nodes > budget) { aborted = true; return; }
      const base = p * W;
      let ok = true;
      for (let x = 0; x < W; x++) if (t.cellMask[base + x] & F[x]) { ok = false; break; }
      if (!ok) continue;
      for (let x = 0; x < W; x++) F2[x] = F[x] | t.haloMask[base + x];
      counts[ti]--;
      placed.push(t, p);
      phase2(depth + 1, ti, p + 1);
      placed.length -= 2;
      counts[ti]++;
      if (aborted) return;
    }
  }

  function phase1(depth) {
    if (aborted) return;
    const U = Ustack[depth];
    const h = firstBit(U, W);
    if (h < 0) {
      phase2(depth, 0, 0);
      return;
    }
    const F = Fstack[depth];
    const F2 = Fstack[depth + 1] || (Fstack[depth + 1] = new Int32Array(W));
    const U2 = Ustack[depth + 1] || (Ustack[depth + 1] = new Int32Array(W));
    for (let i = 0; i < types.length; i++) {
      if (!counts[i]) continue;
      const t = types[i].geo;
      const list = t.byCell[h];
      for (let j = 0; j < list.length; j++) {
        if (++nodes > budget) { aborted = true; return; }
        const p = list[j];
        if (!legal(t, p, F, hits, W)) continue;
        for (let x = 0; x < W; x++) {
          F2[x] = F[x] | t.haloMask[p * W + x];
          U2[x] = U[x] & ~t.cellMask[p * W + x];
        }
        counts[i]--;
        placed.push(t, p);
        phase1(depth + 1);
        placed.length -= 2;
        counts[i]++;
        if (aborted) return;
      }
    }
  }

  phase1(0);
  return !aborted;
}

function newAcc(n) {
  return { occ: new Float64Array(n), sunk: new Float64Array(n), total: 0, totalSq: 0, drawn: 0 };
}

function entropy3(a, b, c) {
  let h = 0;
  if (a > 1e-12) h -= a * Math.log2(a);
  if (b > 1e-12) h -= b * Math.log2(b);
  if (c > 1e-12) h -= c * Math.log2(c);
  return h;
}

/**
 * Analysiert den Spielstand.
 * options: { samples, exactBudget, exactThreshold, seed }
 * Ergebnis: pro Feld pShip, pSunk, entropy + Metadaten.
 */
export function analyze(g, options = {}) {
  const samples = options.samples ?? 20000;
  const exactBudget = options.exactBudget ?? 3_000_000;
  const exactThreshold = options.exactThreshold ?? 300_000;
  const rng = makeRng(options.seed ?? (Math.random() * 2 ** 32));
  const ctx = buildContext(g);
  const n = ctx.n;

  let acc = newAcc(n);
  let method = 'sampling';
  let configCount = 0;
  let ess = 0;

  if (ctx.types.length === 0) {
    return emptyResult(g, n);
  }

  sample(ctx, samples, rng, acc);
  configCount = acc.total / Math.max(1, acc.drawn);
  ess = acc.totalSq > 0 ? (acc.total * acc.total) / acc.totalSq : 0;

  // Wenig Möglichkeiten (oder Stichprobe unzuverlässig) -> exakt zählen.
  if (configCount < exactThreshold || ess < samples * 0.02) {
    const exact = newAcc(n);
    if (enumerate(ctx, exactBudget, exact)) {
      acc = exact;
      method = 'exact';
      configCount = exact.total;
      ess = exact.total;
    }
  }

  const pShip = new Float64Array(n);
  const pSunk = new Float64Array(n);
  const ent = new Float64Array(n);
  const contradiction = acc.total <= 0;
  if (!contradiction) {
    for (let x = 0; x < n; x++) {
      if (g.cells[x] !== UNKNOWN) continue;
      pShip[x] = acc.occ[x] / acc.total;
      pSunk[x] = acc.sunk[x] / acc.total;
      ent[x] = entropy3(1 - pShip[x], pShip[x] - pSunk[x], pSunk[x]);
    }
  }
  return {
    pShip,
    pSunk,
    entropy: ent,
    method,
    configCount,
    ess,
    samples: method === 'exact' ? configCount : samples,
    contradiction,
    parity: parityInfo(g, pShip),
  };
}

function emptyResult(g, n) {
  return {
    pShip: new Float64Array(n),
    pSunk: new Float64Array(n),
    entropy: new Float64Array(n),
    method: 'exact',
    configCount: 1,
    ess: 1,
    samples: 1,
    contradiction: false,
    parity: parityInfo(g, new Float64Array(n)),
  };
}

// ---------------------------------------------------------------------------
// Schachbrett-/Paritätsraster
// ---------------------------------------------------------------------------

/**
 * Kürzestes verbleibendes Schiff = k  ->  jedes Schiff trifft mindestens ein Feld
 * mit (Zeile + Spalte) % k == Klasse. Wir wählen die Klasse, auf der noch die
 * meiste Trefferwahrscheinlichkeit liegt.
 */
export function parityInfo(g, pShip) {
  const lens = Object.entries(g.remaining).filter(([, c]) => c > 0).map(([l]) => +l);
  if (!lens.length) return { k: 0, cls: -1, cells: [] };
  const k = Math.min(...lens);
  const { rows, cols } = g.config;
  const mass = new Array(k).fill(0);
  const open = new Array(k).fill(0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = r * cols + c;
      if (g.cells[x] !== UNKNOWN) continue;
      mass[(r + c) % k] += pShip[x];
      open[(r + c) % k]++;
    }
  }
  let cls = 0;
  for (let i = 1; i < k; i++) {
    if (mass[i] > mass[cls] + 1e-9 || (Math.abs(mass[i] - mass[cls]) <= 1e-9 && open[i] < open[cls])) cls = i;
  }
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = r * cols + c;
      if (g.cells[x] === UNKNOWN && (r + c) % k === cls) cells.push(x);
    }
  }
  return { k, cls, cells };
}

// ---------------------------------------------------------------------------
// Schussauswahl
// ---------------------------------------------------------------------------

export const STRATEGIES = {
  entropy: {
    name: 'Max. Entropie',
    desc: 'Schuss, der im Mittel die meiste Information liefert (Unsicherheit sinkt am stärksten).',
  },
  infoPerMiss: {
    name: 'Info pro Fehlschuss',
    desc: 'Information geteilt durch Fehlschuss-Risiko. Treffer kosten keinen Zug, nur Fehlschüsse.',
  },
  probability: {
    name: 'Max. Trefferwahrscheinlichkeit',
    desc: 'Klassisch: Feld mit der höchsten Trefferwahrscheinlichkeit.',
  },
};

const EPS = 1e-9;

/** Bewertung eines Feldes nach Strategie (höher = besser). */
export function scoreCell(analysis, x, strategy) {
  const p = analysis.pShip[x];
  const h = analysis.entropy[x];
  switch (strategy) {
    case 'probability':
      return p;
    case 'entropy':
      return h;
    case 'infoPerMiss':
    default:
      return h / Math.max(1e-6, 1 - p);
  }
}

/**
 * Wählt den nächsten Schuss.
 * Regeln (für alle Strategien):
 *  1. Felder mit P = 0 sind sicher Wasser -> nie schießen.
 *  2. Sichere Treffer (P = 1) zuerst: Sie kosten keinen Zug und müssen ohnehin
 *     irgendwann geschossen werden. Unter ihnen das informativste.
 *  3. Sonst nach Strategie; bei (fast) Gleichstand gewinnt ein Feld auf dem
 *     Paritätsraster, dann die höhere Trefferwahrscheinlichkeit.
 */
export function chooseShot(g, analysis, strategy = 'infoPerMiss', opts = {}) {
  const n = g.cells.length;
  const paritySet = new Set(analysis.parity.cells);
  const candidates = [];
  for (let x = 0; x < n; x++) {
    if (g.cells[x] !== UNKNOWN) continue;
    if (analysis.pShip[x] <= EPS) continue;
    candidates.push(x);
  }
  if (!candidates.length) return { cell: -1, ranking: [] };

  const sure = candidates.filter((x) => analysis.pShip[x] >= 1 - 1e-7);
  const unsure = candidates.filter((x) => analysis.pShip[x] < 1 - 1e-7);
  let pool, strat, finale = false;
  if (opts.evil) {
    // Evil-Modus 😈: sichere Treffer nur merken, erst weitersuchen und ganz am
    // Ende alle auf einmal abschießen (Treffer = nochmal schießen -> eine Serie).
    if (unsure.length) {
      pool = unsure;
      strat = strategy;
    } else {
      pool = sure;
      strat = 'entropy';
      finale = true;
    }
  } else {
    pool = sure.length ? sure : candidates;
    strat = sure.length ? 'entropy' : strategy;
  }

  const ranking = pool
    .map((x) => ({
      cell: x,
      score: scoreCell(analysis, x, strat),
      p: analysis.pShip[x],
      pSunk: analysis.pSunk[x],
      entropy: analysis.entropy[x],
      parity: paritySet.has(x),
    }))
    .sort((a, b) => {
      const d = b.score - a.score;
      if (Math.abs(d) > 1e-6 * Math.max(1, Math.abs(a.score))) return d;
      if (a.parity !== b.parity) return a.parity ? -1 : 1;
      return b.p - a.p;
    });
  return {
    cell: ranking[0].cell,
    ranking,
    sure: !opts.evil && sure.length > 0,
    remembered: opts.evil ? sure : [], // Evil-Modus: gemerkte sichere Treffer
    finale,
  };
}

// ---------------------------------------------------------------------------
// Hilfen für Simulation / Benchmark
// ---------------------------------------------------------------------------

/**
 * Zufällige Aufstellung, exakt gleichverteilt (Verwerfungsmethode: alle Schiffe
 * unabhängig zufällig legen, bei Konflikt komplett neu).
 */
export function randomFleet(config = DEFAULT_CONFIG, rng = Math.random) {
  const cfg = normalizeConfig(config);
  const geo = getGeometry(cfg.rows, cfg.cols, cfg.diagonalTouch, cfg.fleet.map((f) => f.length));
  const { W } = geo;
  const F = new Int32Array(W);
  for (let attempt = 0; attempt < 5_000_000; attempt++) {
    F.fill(0);
    const ships = [];
    let ok = true;
    outer: for (const f of cfg.fleet) {
      const t = geo.byLength.get(f.length);
      for (let i = 0; i < f.count; i++) {
        const p = (rng() * t.count) | 0;
        for (let x = 0; x < W; x++) if (t.cellMask[p * W + x] & F[x]) { ok = false; break outer; }
        for (let x = 0; x < W; x++) F[x] |= t.haloMask[p * W + x];
        ships.push(Array.from(t.cellIdx.subarray(p * t.len, (p + 1) * t.len)));
      }
    }
    if (ok) return ships;
  }
  throw new Error('Keine gültige Aufstellung gefunden – passt die Flotte aufs Feld?');
}

/** Ergebnis eines Schusses gegen eine bekannte Aufstellung. */
export function resolveShot(g, ships, x) {
  const ship = ships.find((s) => s.includes(x));
  if (!ship) return 'miss';
  const allHit = ship.every((y) => y === x || g.cells[y] === HIT);
  return allHit ? 'sunk' : 'hit';
}

export { makeRng };
