// Korrektheitstests für die Engine.
//  1. Exakte Zählung der Engine == naive Brute-Force-Zählung (unabhängige Implementierung)
//  2. Stichprobe (Sampling) ~= exakte Zählung
//  3. Spielablauf: Versenken sperrt den Rand, Flotte wird reduziert
// Aufruf: node test/validate.mjs

import * as E from '../src/engine.js';

let failures = 0;
const check = (cond, msg) => {
  if (!cond) {
    failures++;
    console.error('  FEHLER:', msg);
  }
};

// ---------------------------------------------------------------------------
// Naive Referenz: alle Aufstellungen aufzählen und direkt gegen die
// Beobachtungen (welche Felder beschossen wurden) prüfen.
// ---------------------------------------------------------------------------
function allPlacements(rows, cols, len) {
  const out = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (c + len <= cols) out.push(Array.from({ length: len }, (_, i) => r * cols + c + i));
      if (len > 1 && r + len <= rows) out.push(Array.from({ length: len }, (_, i) => (r + i) * cols + c));
    }
  return out;
}

function touches(a, b, cols, touch) {
  for (const x of a)
    for (const y of b) {
      const dr = Math.abs(Math.floor(x / cols) - Math.floor(y / cols));
      const dc = Math.abs((x % cols) - (y % cols));
      if (dr === 0 && dc === 0) return true;
      if (touch === 'any') continue; // nur Überlappen verboten
      if (touch === 'diagonal' ? dr + dc === 1 : dr <= 1 && dc <= 1) return true;
    }
  return false;
}

function naiveFleets(cfg) {
  const lens = [];
  for (const f of cfg.fleet) for (let i = 0; i < f.count; i++) lens.push(f.length);
  const pl = Object.fromEntries([...new Set(lens)].map((l) => [l, allPlacements(cfg.rows, cfg.cols, l)]));
  const fleets = [];
  const cur = [];
  const curIdx = [];
  (function rec(i) {
    if (i === lens.length) {
      fleets.push(cur.map((s) => s.slice()));
      return;
    }
    const L = pl[lens[i]];
    const start = i > 0 && lens[i - 1] === lens[i] ? curIdx[i - 1] + 1 : 0; // ununterscheidbar
    for (let p = start; p < L.length; p++) {
      if (cur.some((s) => touches(s, L[p], cfg.cols, cfg.touch))) continue;
      cur.push(L[p]);
      curIdx.push(p);
      rec(i + 1);
      cur.pop();
      curIdx.pop();
    }
  })(0);
  return fleets;
}

/** Was hätte man gesehen, wenn diese Flotte die echte wäre? */
function consistent(fleet, shotCells, g) {
  const shot = new Set(shotCells);
  const ofCell = new Map();
  fleet.forEach((s, i) => s.forEach((x) => ofCell.set(x, i)));
  for (const x of shotCells) {
    const v = g.cells[x];
    const has = ofCell.has(x);
    if (v === E.MISS && has) return false;
    if ((v === E.HIT || v === E.SUNK) && !has) return false;
    if (has) {
      const sunk = fleet[ofCell.get(x)].every((y) => shot.has(y));
      if (v === E.HIT && sunk) return false;
      if (v === E.SUNK && !sunk) return false;
    }
  }
  // Gemeldete versenkte Schiffe müssen genau die Schiffe dieser Flotte sein
  const key = (s) => [...s].sort((a, b) => a - b).join(',');
  const sunkNow = new Set(fleet.filter((s) => s.every((y) => shot.has(y))).map(key));
  const reported = new Set(g.sunkShips.map((s) => key(s.cells)));
  if (sunkNow.size !== reported.size) return false;
  for (const k of reported) if (!sunkNow.has(k)) return false;
  return true;
}

function naiveMarginals(g, fleets, shotCells) {
  const n = g.cells.length;
  const occ = new Float64Array(n), sunk = new Float64Array(n);
  let total = 0;
  const shot = new Set(shotCells);
  for (const f of fleets) {
    if (!consistent(f, shotCells, g)) continue;
    total++;
    for (const s of f) {
      const open = s.filter((y) => !shot.has(y));
      for (const y of open) occ[y]++;
      if (open.length === 1) sunk[open[0]]++;
    }
  }
  return { total, occ, sunk };
}

// ---------------------------------------------------------------------------
console.log('Test 1: exakte Engine-Zählung vs. naive Brute-Force');
for (const cfg of [
  { rows: 6, cols: 6, fleet: [{ length: 3, count: 2 }, { length: 2, count: 1 }], touch: 'none' },
  { rows: 6, cols: 6, fleet: [{ length: 4, count: 1 }, { length: 3, count: 1 }, { length: 2, count: 1 }], touch: 'diagonal' },
  { rows: 7, cols: 6, fleet: [{ length: 4, count: 1 }, { length: 3, count: 2 }], touch: 'none' },
  { rows: 5, cols: 5, fleet: [{ length: 3, count: 2 }, { length: 2, count: 1 }], touch: 'any' },
]) {
  const fleets = naiveFleets(cfg);
  const rng = E.makeRng(12345);
  let states = 0;
  for (let game = 0; game < 12; game++) {
    const truth = fleets[(rng() * fleets.length) | 0];
    const g = E.newGame(cfg);
    const shotCells = [];
    const order = [...g.cells.keys()].sort(() => rng() - 0.5);
    for (const x of order) {
      if (E.isFinished(g)) break;
      if (g.cells[x] !== E.UNKNOWN && g.cells[x] !== E.BLOCKED) continue;
      const res = E.resolveShot(g, truth, x);
      const ar = E.applyShot(g, x, res, res === 'sunk' ? E.shipAt(truth, x) : undefined);
      check(ar.ok, 'Schuss eintragen: ' + ar.error);
      shotCells.push(x);
      // Nur echte Schüsse sind Beobachtungen; gesperrte Randfelder sind eine
      // Schlussfolgerung der Engine und werden hier bewusst NICHT mitgegeben.
      if (rng() < 0.6) continue; // nicht jeden Zwischenstand prüfen
      const ref = naiveMarginals(g, fleets, shotCells);
      const a = E.analyze(g, { exactThreshold: Infinity, exactBudget: 1e9 });
      states++;
      check(a.method === 'exact', 'erwartet exakte Zählung');
      check(Math.abs(a.configCount - ref.total) < 1e-6, `Anzahl ${a.configCount} != ${ref.total}`);
      for (let y = 0; y < g.cells.length; y++) {
          if (g.cells[y] !== E.UNKNOWN) continue;
        const pRef = ref.occ[y] / ref.total, sRef = ref.sunk[y] / ref.total;
        if (Math.abs(a.pShip[y] - pRef) > 1e-9 || Math.abs(a.pSunk[y] - sRef) > 1e-9) {
          check(false, `Feld ${y}: P ${a.pShip[y]} vs ${pRef}, Versenkt ${a.pSunk[y]} vs ${sRef}`);
          break;
        }
      }
    }
  }
  console.log(`  ${cfg.rows}x${cfg.cols}, ${fleets.length} Aufstellungen, ${states} Spielstände geprüft`);
}

// ---------------------------------------------------------------------------
console.log('Test 2: Stichprobe vs. exakt (9x9 Standardspiel, Spielmitte)');
{
  const rng = E.makeRng(777);
  let worst = 0, compared = 0;
  for (let game = 0; game < 6; game++) {
    const truth = E.randomFleet(E.DEFAULT_CONFIG, rng);
    const g = E.newGame();
    const order = [...g.cells.keys()].sort(() => rng() - 0.5);
    for (const x of order) {
      if (E.isFinished(g)) break;
      if (g.cells[x] !== E.UNKNOWN) continue;
      const res = E.resolveShot(g, truth, x);
      E.applyShot(g, x, res, res === 'sunk' ? E.shipAt(truth, x) : undefined);
      const exact = E.analyze(g, { samples: 2000, exactThreshold: Infinity, exactBudget: 2e6 });
      if (exact.method !== 'exact' || exact.configCount < 2000) continue;
      const smp = E.analyze(g, { samples: 60000, exactThreshold: 0, exactBudget: 0, seed: compared + 1 });
      compared++;
      for (let y = 0; y < g.cells.length; y++) worst = Math.max(worst, Math.abs(smp.pShip[y] - exact.pShip[y]));
      if (compared % 4 === 0) break;
    }
  }
  console.log(`  ${compared} Spielstände, größte Abweichung ${(worst * 100).toFixed(2)} %-Punkte`);
  check(compared > 0, 'keine vergleichbaren Spielstände gefunden');
  check(worst < 0.05, 'Stichprobe weicht zu stark ab');
}

// ---------------------------------------------------------------------------
console.log('Test 3: Spielablauf');
{
  const g = E.newGame();
  // 3er senkrecht in Spalte 0, Zeilen 0-2
  check(E.applyShot(g, 0, 'hit').ok, 'Treffer');
  check(E.applyShot(g, 9, 'hit').ok, 'Treffer');
  const r = E.applyShot(g, 18, 'sunk');
  check(r.ok && r.sunkLength === 3, 'versenkt 3er');
  check(g.remaining[3] === 4, 'Flotte reduziert');
  for (const x of [1, 10, 19, 27, 28]) check(g.cells[x] === E.BLOCKED, `Rand ${x} gesperrt`);
  const bad = E.applyShot(g, 40, 'sunk');
  check(!bad.ok, '1er-Schiff gibt es nicht');
  const a = E.analyze(g, { samples: 5000 });
  check(a.parity.k === 3, 'Paritätsabstand 3');
  for (let i = 0; i < 4; i++) g.remaining[3] = 0;
  check(E.parityInfo(g, a.pShip).k === 4, 'nur noch 4er -> Abstand 4');
}

// ---------------------------------------------------------------------------
console.log('Test 4: Gefundene (sichere, nicht versenkte) Schiffe');
{
  const c = (s) => (+s.slice(1) - 1) * 9 + (s.charCodeAt(0) - 65);
  let g = E.newGame();
  for (const s of ['A1', 'B1', 'C1', 'A9', 'B9', 'C9']) E.applyShot(g, c(s), 'hit');
  let a = E.analyze(g, { samples: 20000, seed: 3 });
  check(a.found.length === 2 && a.found.every((f) => f.length === 4), 'zwei 4er gefunden');
  g = E.newGame({ rows: 9, cols: 9, fleet: [{ length: 4, count: 1 }, { length: 3, count: 1 }] });
  E.applyShot(g, c('A1'), 'hit');
  E.applyShot(g, c('B1'), 'hit');
  E.applyShot(g, c('D1'), 'miss');
  a = E.analyze(g, { samples: 20000, seed: 3 });
  check(a.found.length === 1 && a.found[0].length === 3, '3er gefunden');
  check(a.parity.k === 4, 'nur noch 4er gesucht -> Raster 4');
}

// ---------------------------------------------------------------------------
console.log('Test 5: Versenkt, wenn sich Schiffe berühren dürfen');
{
  const cfg = { rows: 5, cols: 5, fleet: [{ length: 3, count: 2 }], touch: 'any' };
  const c = (s) => (+s.slice(1) - 1) * 5 + (s.charCodeAt(0) - 65);
  const g = E.newGame(cfg);
  for (const s of ['B1', 'C1', 'A2', 'A3']) E.applyShot(g, c(s), 'hit');
  const amb = E.applyShot(g, c('A1'), 'sunk');
  check(!amb.ok && amb.ambiguous && amb.candidates.length === 2, 'A1 versenkt ist mehrdeutig (A1–C1 oder A1–A3)');
  check(g.cells[c('A1')] === E.UNKNOWN, 'bei Mehrdeutigkeit bleibt alles unverändert');
  const ok = E.applyShot(g, c('A1'), 'sunk', [c('A1'), c('B1'), c('C1')]);
  check(ok.ok && g.cells[c('A2')] === E.HIT && g.cells[c('B2')] === E.UNKNOWN, 'A1–C1 versenkt, kein Sperr-Rand');
  const a = E.analyze(g, { samples: 5000 });
  check(!a.contradiction && a.found.length === 1, 'restlicher 3er (A2–A4) gefunden');
}

if (failures) {
  console.error(`\n${failures} Fehler`);
  process.exit(1);
}
console.log('\nAlle Tests bestanden.');
