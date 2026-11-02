import * as E from './engine.js?v=7';

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------
const store = {
  get(k, d) { try { const v = localStorage.getItem('bsh:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bsh:' + k, JSON.stringify(v)); } catch { /* egal */ } },
};

const S = {
  mode: 'real',
  config: store.get('config', E.DEFAULT_CONFIG),
  samples: store.get('samples', 30000),
  strategy: store.get('strategy', 'infoPerMiss'),
  evil: store.get('evil', false),
  unleash: store.get('unleash', false), // Evil-Modus fürs laufende Spiel beendet ("Alles abfeuern")
  view: 'prob',
  showParity: true,
  showNumbers: true,
  game: null,
  history: [],
  selected: -1,
  manualSelect: false,
  analysis: null,
  choice: null,
  ms: 0,
  reqId: 0,
  busy: false,
  truth: null,     // Demo: echte Aufstellung
  reveal: false,
  auto: false,
};

const $ = (id) => document.getElementById(id);
const colName = (c) => String.fromCharCode(65 + c);
const cellName = (x) => colName(x % S.game.config.cols) + (Math.floor(x / S.game.config.cols) + 1);
const pct = (v) => (v * 100).toFixed(v > 0 && v < 0.01 ? 1 : 0) + ' %';

// ---------------------------------------------------------------------------
// Rechnen (Web Worker, Fallback im Hauptthread)
// ---------------------------------------------------------------------------
let worker = null;
try {
  worker = new Worker(new URL('./worker.js?v=7', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => onResult(e.data);
  worker.onerror = () => { worker = null; recompute(); };
} catch { worker = null; }

function recompute() {
  const id = ++S.reqId;
  S.busy = true;
  document.body.classList.add('busy');
  const payload = { id, game: S.game, strategy: S.strategy, samples: S.samples, evil: evilActive() };
  if (worker) {
    worker.postMessage(payload);
  } else {
    setTimeout(() => {
      const t0 = performance.now();
      const analysis = E.analyze(S.game, { samples: S.samples });
      const choice = E.chooseShot(S.game, analysis, S.strategy, { evil: evilActive() });
      onResult({ id, analysis, choice, ms: performance.now() - t0 });
    }, 10);
  }
}

function onResult({ id, analysis, choice, ms }) {
  if (id !== S.reqId) return; // veraltet
  S.analysis = analysis;
  S.choice = choice;
  S.ms = ms;
  S.busy = false;
  document.body.classList.remove('busy');
  if (!S.manualSelect || S.selected < 0 || S.game.cells[S.selected] !== E.UNKNOWN) {
    S.selected = choice.cell;
    S.manualSelect = false;
  }
  if (analysis.contradiction && !E.isFinished(S.game)) {
    msg('Widerspruch: Keine Aufstellung passt zu den Eingaben. Bitte prüfen (Rückgängig).', 'err');
  }
  render();
  if (S.auto) setTimeout(autoStep, 250);
}

// ---------------------------------------------------------------------------
// Spielaktionen
// ---------------------------------------------------------------------------
const evilActive = () => S.evil && !S.unleash;

function setUnleash(v) {
  S.unleash = v;
  if (S.mode === 'real') store.set('unleash', v);
  S.manualSelect = false;
  if (v) msg('🔥 Feuer frei: erst alle gemerkten Treffer, dann normal weiter.', 'ok');
  else msg('😈 Zurück im Evil-Modus.');
  recompute();
  render();
}

function newGame() {
  S.pendingSunk = null;
  S.game = E.newGame(S.config);
  S.unleash = false;
  if (S.mode === 'real') store.set('unleash', false);
  S.history = [];
  S.analysis = null;
  S.choice = null;
  S.selected = -1;
  S.manualSelect = false;
  S.reveal = false;
  stopAuto();
  if (S.mode === 'demo') {
    try { S.truth = E.randomFleet(S.config); } catch (e) { msg(e.message, 'err'); S.truth = null; }
  } else {
    S.truth = null;
  }
  buildBoard();
  saveGame();
  msg('');
  recompute();
  render();
}

const STATE_NAME = { [E.MISS]: 'Wasser', [E.HIT]: 'Treffer', [E.SUNK]: 'Versenkt', [E.BLOCKED]: 'Gesperrt', [E.UNKNOWN]: 'leer' };
const RESULT_STATE = { miss: E.MISS, hit: E.HIT, sunk: E.SUNK, clear: E.UNKNOWN };

/** Mehrere Schiffe möglich (Schiffe dürfen sich berühren): Nutzer fragen. */
function askSunk(x, isEdit, candidates) {
  S.pendingSunk = { x, isEdit, candidates };
  msg('Mehrere Möglichkeiten – welches Schiff wurde versenkt?');
  render();
}

function renderSunkChoice() {
  const box = $('sunk-choice');
  const p = S.pendingSunk;
  box.hidden = !p;
  if (!p) { box.innerHTML = ''; return; }
  box.innerHTML = '';
  for (const cells of p.candidates) {
    const b = document.createElement('button');
    b.className = 'btn sunk';
    const sorted = [...cells].sort((a, c) => a - c);
    b.textContent = `${cellName(sorted[0])}–${cellName(sorted[sorted.length - 1])} (${cells.length}er)`;
    const mark = (on) => cells.forEach((y) => cellEls[y].classList.toggle('cand', on));
    b.onmouseenter = b.onfocus = () => mark(true);
    b.onmouseleave = b.onblur = () => mark(false);
    b.onclick = () => {
      mark(false);
      S.pendingSunk = null;
      if (p.isEdit) editCell(p.x, 'sunk', cells);
      else shoot(p.x, 'sunk', cells);
    };
    box.appendChild(b);
  }
  const cancel = document.createElement('button');
  cancel.className = 'btn ghost';
  cancel.textContent = 'Abbrechen';
  cancel.onclick = () => { S.pendingSunk = null; msg(''); render(); };
  box.appendChild(cancel);
}

/** Bereits markiertes Feld ändern oder leeren (nur im echten Spiel). */
function editCell(x, result, shipCells) {
  S.pendingSunk = null;
  const v = S.game.cells[x];
  if (v === RESULT_STATE[result]) return msg(`${cellName(x)} ist schon ${STATE_NAME[v]}.`);
  const before = E.cloneGame(S.game);
  const r = E.editCell(S.game, x, result, shipCells);
  if (!r.ok && r.ambiguous) return askSunk(x, true, r.candidates);
  if (!r.ok) return msg(r.error, 'err');
  S.history.push(before);
  S.manualSelect = true;
  msg(`${cellName(x)} geändert: ${STATE_NAME[v]} → ${result === 'sunk' ? `${r.sunkLength}er versenkt` : STATE_NAME[RESULT_STATE[result]]}.`, 'ok');
  saveGame();
  recompute();
  render();
}

function clearSelected() {
  const x = S.selected;
  if (x < 0) return msg('Erst ein Feld auswählen.', 'err');
  if (S.game.cells[x] === E.UNKNOWN) return msg(`${cellName(x)} ist schon leer.`);
  editCell(x, 'clear');
}

function shoot(x, result, shipCells) {
  S.pendingSunk = null;
  if (x < 0) return msg('Erst ein Feld auswählen.', 'err');
  const v = S.game.cells[x];
  if (S.mode === 'real' && (v === E.MISS || v === E.HIT || v === E.SUNK)) return editCell(x, result, shipCells);
  if (E.isFinished(S.game)) return msg('Spiel ist vorbei – „Neues Spiel“ starten.', 'err');
  const before = E.cloneGame(S.game);
  const r = E.applyShot(S.game, x, result, shipCells);
  if (!r.ok && r.ambiguous) return askSunk(x, false, r.candidates);
  if (!r.ok) return msg(r.error, 'err');
  S.history.push(before);
  S.manualSelect = false;
  if (result === 'sunk') {
    msg(`${cellName(x)}: ${r.sunkLength}er versenkt${S.game.config.touch === 'any' ? '' : ' – Rand gesperrt'}.`, 'ok');
  } else {
    msg(`${cellName(x)}: ${result === 'hit' ? 'Treffer' : 'Wasser'}.`, result === 'hit' ? 'ok' : '');
  }
  if (E.isFinished(S.game)) {
    msg(`Alle Schiffe versenkt! ${S.game.shots} Schüsse, davon ${S.game.misses} Fehlschüsse.`, 'ok');
    stopAuto();
  }
  saveGame();
  recompute();
  render();
}

function undo() {
  if (!S.history.length) return;
  S.pendingSunk = null;
  S.game = S.history.pop();
  S.manualSelect = false;
  msg('Rückgängig gemacht.');
  saveGame();
  recompute();
  render();
}

function demoShoot(x) {
  if (!S.truth) return;
  const cur = S.game.cells[x];
  if (cur !== E.UNKNOWN && cur !== E.BLOCKED) return msg('Feld wurde schon beschossen.', 'err');
  const res = E.resolveShot(S.game, S.truth, x);
  shoot(x, res, res === 'sunk' ? E.shipAt(S.truth, x) : undefined);
}

function botMove() {
  if (S.busy || !S.choice || S.choice.cell < 0) return;
  demoShoot(S.choice.cell);
}

function autoStep() {
  if (!S.auto) return;
  if (E.isFinished(S.game)) return stopAuto();
  if (!S.busy) botMove();
}
function stopAuto() {
  S.auto = false;
  const b = $('demo-auto');
  if (b) b.textContent = 'Auto ▶';
}

function saveGame() {
  if (S.mode !== 'real') return;
  const g = S.game;
  store.set('game', { config: g.config, cells: Array.from(g.cells), remaining: g.remaining, sunkShips: g.sunkShips, shots: g.shots, misses: g.misses });
}

function loadGame() {
  const saved = store.get('game', null);
  if (!saved || JSON.stringify(E.normalizeConfig(saved.config)) !== JSON.stringify(E.normalizeConfig(S.config))) return false;
  const g = E.newGame(saved.config);
  g.cells.set(saved.cells);
  Object.assign(g, { remaining: saved.remaining, sunkShips: saved.sunkShips, shots: saved.shots, misses: saved.misses });
  S.game = g;
  return true;
}

// ---------------------------------------------------------------------------
// Darstellung
// ---------------------------------------------------------------------------
let cellEls = [];

function buildBoard() {
  const { rows, cols } = S.game.config;
  const board = $('board');
  board.style.setProperty('--n-cols', cols);
  board.innerHTML = '';
  board.appendChild(document.createElement('div'));
  for (let c = 0; c < cols; c++) {
    const l = document.createElement('div');
    l.className = 'lab';
    l.textContent = colName(c);
    board.appendChild(l);
  }
  cellEls = [];
  for (let r = 0; r < rows; r++) {
    const l = document.createElement('div');
    l.className = 'lab';
    l.textContent = r + 1;
    board.appendChild(l);
    for (let c = 0; c < cols; c++) {
      const x = r * cols + c;
      const b = document.createElement('button');
      b.className = 'cell';
      b.dataset.x = x;
      b.innerHTML = '<span class="num"></span>';
      b.addEventListener('click', () => onCellClick(x));
      b.addEventListener('dblclick', () => { if (S.mode === 'demo') demoShoot(x); });
      board.appendChild(b);
      cellEls.push(b);
    }
  }
}

function onCellClick(x) {
  S.selected = x;
  S.manualSelect = true;
  render();
}

const HEAT = { prob: '#f59e0b', entropy: '#8b5cf6' };

function render() {
  const g = S.game;
  const a = S.analysis;
  const n = g.cells.length;
  const parity = new Set(S.showParity && a ? a.parity.cells : []);
  const best = S.choice?.cell ?? -1;
  const remembered = new Set(S.choice?.remembered || []);
  const ranks = new Map((S.choice?.ranking || []).slice(0, 5).map((r, i) => [r.cell, i + 1]));
  const truthCells = new Set(S.reveal && S.truth ? S.truth.flat() : []);
  // Farbskala relativ zum aktuell stärksten Feld (sonst sieht alles gleich aus)
  let maxEnt = 0, maxP = 0;
  if (a) for (let x = 0; x < n; x++) { maxEnt = Math.max(maxEnt, a.entropy[x]); maxP = Math.max(maxP, a.pShip[x]); }

  for (let x = 0; x < n; x++) {
    const el = cellEls[x];
    const v = g.cells[x];
    const cls = ['cell'];
    let bg = '';
    let text = '';
    if (v === E.MISS) cls.push('miss');
    else if (v === E.HIT) cls.push('hit');
    else if (v === E.SUNK) cls.push('sunk');
    else if (v === E.BLOCKED) cls.push('blocked');
    else if (a && !a.contradiction) {
      const val = S.view === 'prob' ? (maxP > 0 ? a.pShip[x] / maxP : 0) : (maxEnt > 0 ? a.entropy[x] / maxEnt : 0);
      const p = Math.round(val * val * 90); // quadratisch: Unterschiede oben deutlicher
      bg = `color-mix(in oklab, ${HEAT[S.view]} ${p}%, var(--cell-unknown))`;
      if (p > 55) cls.push('dark-text');
      if (a.pShip[x] <= 1e-9) cls.push('zero');
      if (S.showNumbers) {
        text = S.view === 'prob' ? String(Math.round(a.pShip[x] * 100)) : a.entropy[x].toFixed(2).replace(/^0/, '');
      }
      if (parity.has(x)) cls.push('parity');
    }
    if (x === best && v === E.UNKNOWN) cls.push('best');
    if (remembered.has(x) && x !== best && v === E.UNKNOWN) cls.push('remembered');
    if (x === S.selected) cls.push('selected');
    if (truthCells.has(x) && v !== E.SUNK) cls.push('reveal-ship');
    el.className = cls.join(' ');
    el.style.background = bg;
    el.style.color = bg && cls.includes('dark-text') ? '#141821' : '';
    el.firstChild.textContent = text;
    const rk = ranks.get(x);
    let rankEl = el.querySelector('.rank');
    if (rk && rk > 1 && v === E.UNKNOWN && S.showNumbers) {
      if (!rankEl) { rankEl = document.createElement('span'); rankEl.className = 'rank'; el.appendChild(rankEl); }
      rankEl.textContent = rk;
    } else if (rankEl) rankEl.remove();
    el.setAttribute('aria-label', `${cellName(x)}${text ? ' ' + text + ' Prozent' : ''}`);
  }

  // Abfeuern-Knopf (nur im Evil-Modus)
  const done = E.isFinished(g);
  const fire = $('fire');
  fire.hidden = !S.evil || done;
  fire.classList.toggle('unleashed', S.unleash);
  const nRem = S.choice?.remembered?.length || 0;
  fire.innerHTML = S.unleash
    ? '😈 Zurück zum Evil-Modus <kbd>F</kbd>'
    : `🔥 Alles abfeuern${nRem ? ` (${nRem} 💀)` : ''} <kbd>F</kbd>`;

  // Empfehlung
  if (done) {
    $('rec-cell').textContent = '🎉';
    $('rec-cell').classList.remove('finale');
    $('rec-stats').textContent = `Fertig: ${g.shots} Schüsse, ${g.misses} Fehlschüsse.`;
  } else if (a && best >= 0) {
    const r = S.choice.ranking[0];
    $('rec-cell').textContent = cellName(best);
    $('rec-cell').classList.toggle('finale', !!S.choice.finale);
    $('rec-stats').innerHTML =
      `Treffer ${pct(r.p)} · Versenkt ${pct(r.pSunk)} · Info ${r.entropy.toFixed(2)} bit` +
      (S.choice.sure ? '<br>Sicherer Treffer – kostet keinen Zug.' : '') +
      (S.choice.finale ? `<br>😈 Finale: alle ${S.choice.remembered.length} gemerkten Felder jetzt nacheinander abschießen!` :
        evilActive() && S.choice.remembered.length ? `<br>😈 ${S.choice.remembered.length} sichere Treffer gemerkt.` : '') +
      (S.evil && S.unleash ? '<br>🔥 Feuer frei – Evil-Modus für dieses Spiel beendet.' : '');
  } else {
    $('rec-cell').textContent = '…';
    $('rec-stats').textContent = 'rechne …';
  }

  // Auswahl
  const sel = S.selected;
  $('sel-cell').textContent = sel >= 0 ? cellName(sel) : '–';
  let hint = '';
  const sv = sel >= 0 ? g.cells[sel] : -1;
  if (sv === E.UNKNOWN && a) hint = `(Treffer ${pct(a.pShip[sel])})`;
  else if (S.mode === 'real' && (sv === E.MISS || sv === E.HIT || sv === E.SUNK)) {
    hint = `(${STATE_NAME[sv]} – zum Ändern anderen Knopf drücken oder leeren)`;
  } else if (sv === E.BLOCKED) hint = '(automatisch gesperrt)';
  $('sel-hint').textContent = hint;
  const clr = $('clear-cell');
  clr.hidden = S.mode !== 'real';
  clr.disabled = !(sv === E.MISS || sv === E.HIT || sv === E.SUNK);
  $('undo').disabled = !S.history.length;

  renderSunkChoice();
  renderFleet();
  renderStats();
}

function renderFleet() {
  const g = S.game;
  const el = $('fleet');
  el.innerHTML = '';
  const found = S.analysis?.found || [];
  for (const f of g.config.fleet) {
    const left = g.remaining[f.length] || 0;
    const nFound = Math.min(left, found.filter((s) => s.length === f.length).length);
    const searching = left - nFound;
    const row = document.createElement('div');
    row.className = 'ship-row';
    const ships = Array.from({ length: f.count }, (_, i) =>
      `<span class="ship ${i < searching ? '' : i < left ? 'found' : 'gone'}"${i >= searching && i < left ? ' title="Position sicher bekannt"' : ''}>${'<i></i>'.repeat(f.length)}</span>`).join('');
    const label = nFound
      ? `${f.length}er: ${searching} gesucht · ${nFound} 💀`
      : `${f.length}er: ${left}/${f.count}`;
    row.innerHTML = `<span class="label">${label}</span><span class="ships">${ships}</span>`;
    el.appendChild(row);
  }
  if (found.length) {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = `💀 = Position sicher bekannt, aber noch nicht versenkt. Zählt nicht mehr für die Suche.`;
    el.appendChild(note);
  }
  const p = S.analysis?.parity;
  if (p && !p.k && found.length && !E.isFinished(g)) {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = 'Alle Schiffe gefunden – nur noch abschießen!';
    el.appendChild(note);
  }
  if (p && p.k === 1) {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = 'Raster: entfällt, solange 1er-Schiffe gesucht werden (die passen in jede Lücke).';
    el.appendChild(note);
  }
  if (p && p.k > 1) {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = `Raster: jedes ${p.k}. Feld (kürzestes gesuchtes Schiff = ${p.k}, also ${p.k - 1} ${p.k - 1 === 1 ? 'Lücke' : 'Lücken'} dazwischen).`;
    el.appendChild(note);
  }
}

function renderStats() {
  const a = S.analysis;
  const g = S.game;
  const fmtCount = (c) => {
    if (c < 1e6) return Math.round(c).toLocaleString('de-DE');
    const e = Math.floor(Math.log10(c));
    return `≈ ${(c / 10 ** e).toFixed(1).replace('.', ',')}·10^${e}`;
  };
  const rows = [
    ['Schüsse', g.shots],
    ['Fehlschüsse', g.misses],
    ['Mögliche Aufstellungen', a ? fmtCount(a.configCount) : '…'],
    ['Methode', a ? (a.method === 'exact' ? 'exakt gezählt' : `Stichprobe (${S.samples.toLocaleString('de-DE')})`) : '…'],
    ['Effektive Stichprobe', a && a.method !== 'exact' ? Math.round(a.ess).toLocaleString('de-DE') : '–'],
    ['Rechenzeit', a ? `${Math.round(S.ms)} ms` : '…'],
  ];
  $('stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  const top = (S.choice?.ranking || []).slice(0, 6);
  if (!top.length) { $('top-list').innerHTML = ''; return; }
  $('top-list').innerHTML =
    '<table><thead><tr><th>Feld</th><th>Treffer</th><th>Versenkt</th><th>Info</th><th>Score</th></tr></thead><tbody>' +
    top.map((r) => `<tr data-x="${r.cell}"><td>${cellName(r.cell)}${r.parity ? ' •' : ''}</td><td>${pct(r.p)}</td><td>${pct(r.pSunk)}</td><td>${r.entropy.toFixed(2)}</td><td>${r.score.toFixed(2)}</td></tr>`).join('') +
    '</tbody></table>';
  $('top-list').querySelectorAll('tr[data-x]').forEach((tr) =>
    tr.addEventListener('click', () => onCellClick(+tr.dataset.x)));
}

function msg(text, kind = '') {
  const el = $('msg');
  el.textContent = text;
  el.className = 'msg ' + kind;
}

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------
const PRESETS = [
  { name: 'Unser Spiel (9×9)', rows: 9, cols: 9, fleet: { 4: 3, 3: 5 }, touch: 'none' },
  { name: 'Klassisch (10×10, 5-4-3-3-2)', rows: 10, cols: 10, fleet: { 5: 1, 4: 1, 3: 2, 2: 1 }, touch: 'any' },
  { name: 'Schiffe versenken (10×10, 1-2-3-4)', rows: 10, cols: 10, fleet: { 5: 1, 4: 2, 3: 3, 2: 4 }, touch: 'none' },
  { name: 'Seeschlacht mit 1ern (10×10)', rows: 10, cols: 10, fleet: { 4: 1, 3: 2, 2: 3, 1: 4 }, touch: 'none' },
];
const SHIP_LENGTHS = [1, 2, 3, 4, 5];
const MIN_SIZE = 4, MAX_SIZE = 12, MAX_COUNT = 9;
let draft = null; // { rows, cols, counts: {len: n}, touch }

function draftFromConfig(cfg) {
  const counts = Object.fromEntries(SHIP_LENGTHS.map((l) => [l, 0]));
  for (const f of cfg.fleet) counts[f.length] = (counts[f.length] || 0) + f.count;
  return { rows: cfg.rows, cols: cfg.cols, counts, touch: cfg.touch };
}

function draftConfig() {
  const fleet = Object.entries(draft.counts).filter(([, c]) => c > 0).map(([length, count]) => ({ length: +length, count }));
  return E.normalizeConfig({ rows: draft.rows, cols: draft.cols, fleet, touch: draft.touch });
}

function fillSettings() {
  draft = draftFromConfig(S.config);
  $('cfg-samples').value = S.samples;
  renderSettings();
}

function stepper(el, value, min, max, onChange) {
  el.innerHTML = `<button type="button" aria-label="weniger">−</button><output>${value}</output><button type="button" aria-label="mehr">+</button>`;
  const [minus, plus] = el.querySelectorAll('button');
  minus.disabled = value <= min;
  plus.disabled = value >= max;
  minus.onclick = () => onChange(Math.max(min, value - 1));
  plus.onclick = () => onChange(Math.min(max, value + 1));
}

function renderSettings() {
  // Vorlagen
  const cur = JSON.stringify(draftConfig());
  const pre = $('cfg-presets');
  pre.innerHTML = '';
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.className = 'btn ghost';
    b.type = 'button';
    b.textContent = p.name;
    const pd = { rows: p.rows, cols: p.cols, counts: { ...Object.fromEntries(SHIP_LENGTHS.map((l) => [l, 0])), ...p.fleet }, touch: p.touch };
    const saved = draft;
    draft = pd;
    const isActive = JSON.stringify(draftConfig()) === cur;
    draft = saved;
    b.classList.toggle('active', isActive);
    b.onclick = () => {
      draft = { ...pd, counts: { ...pd.counts } };
      renderSettings();
      msg(`Vorlage „${p.name}“ geladen – „Übernehmen“ drücken.`);
    };
    pre.appendChild(b);
  }
  // Berühren
  const TOUCH_HINT = {
    none: 'Um jedes Schiff bleibt ein Feld Abstand – auch über Eck. Nach „Versenkt“ wird der Rand gesperrt.',
    diagonal: 'Über Eck dürfen sich Schiffe berühren, direkt daneben nicht.',
    any: 'Schiffe dürfen direkt aneinander liegen. Nach „Versenkt“ wird nichts gesperrt; ist unklar, welches Schiff versenkt wurde, fragt die App nach.',
  };
  document.querySelectorAll('#cfg-touch [data-touch]').forEach((b) => {
    b.classList.toggle('active', b.dataset.touch === draft.touch);
    b.setAttribute('aria-checked', b.dataset.touch === draft.touch);
    b.onclick = () => { draft.touch = b.dataset.touch; renderSettings(); };
  });
  $('cfg-touch-hint').textContent = TOUCH_HINT[draft.touch];
  // Feldgröße
  stepper($('cfg-rows'), draft.rows, MIN_SIZE, MAX_SIZE, (v) => { draft.rows = v; renderSettings(); });
  stepper($('cfg-cols'), draft.cols, MIN_SIZE, MAX_SIZE, (v) => { draft.cols = v; renderSettings(); });
  // Schiffe
  const el = $('cfg-fleet');
  el.innerHTML = '';
  const lengths = [...new Set([...SHIP_LENGTHS, ...Object.keys(draft.counts).map(Number)])].sort((a, b) => b - a);
  for (const len of lengths) {
    const n = draft.counts[len] || 0;
    const line = document.createElement('div');
    line.className = 'step-line' + (n ? '' : ' off');
    line.innerHTML = `<span class="ship-pre"><span class="ship">${'<i></i>'.repeat(len)}</span>${len}er</span><span class="stepper"></span>`;
    stepper(line.querySelector('.stepper'), n, 0, MAX_COUNT, (v) => { draft.counts[len] = v; renderSettings(); });
    el.appendChild(line);
  }
  const shipCells = Object.entries(draft.counts).reduce((s, [l, c]) => s + l * c, 0);
  const ships = Object.values(draft.counts).reduce((a, b) => a + b, 0);
  const total = draft.rows * draft.cols;
  $('cfg-summary').textContent = `${ships} Schiffe · ${shipCells} von ${total} Feldern belegt (${Math.round((shipCells / total) * 100)} %)`;
}

function applySettings() {
  const cfg = draftConfig();
  if (!cfg.fleet.length) return msg('Mindestens ein Schiff angeben.', 'err');
  if (cfg.fleet.some((f) => f.length > Math.max(cfg.rows, cfg.cols))) return msg('Ein Schiff ist länger als das Feld.', 'err');
  const test = E.analyze(E.newGame(cfg), { samples: 3000 });
  if (test.contradiction) return msg('Diese Flotte passt nicht aufs Feld.', 'err');
  if (S.mode === 'real' && S.game.shots > 0 && !E.isFinished(S.game) && !confirm('Laufendes Spiel verwerfen?')) return;
  S.config = cfg;
  S.samples = Math.max(1000, Math.min(200000, +$('cfg-samples').value || 30000));
  store.set('config', cfg);
  store.set('samples', S.samples);
  fillSettings();
  newGame();
  msg('Einstellungen übernommen – neues Spiel gestartet.', 'ok');
}

// ---------------------------------------------------------------------------
// Ereignisse
// ---------------------------------------------------------------------------
function setMode(mode) {
  S.mode = mode;
  $('mode-real').classList.toggle('active', mode === 'real');
  $('mode-demo').classList.toggle('active', mode === 'demo');
  $('real-actions').hidden = mode !== 'real';
  $('demo-actions').hidden = mode !== 'demo';
  S.unleash = mode === 'real' ? store.get('unleash', false) : false;
  if (mode === 'real' && loadGame()) {
    S.history = [];
    S.truth = null;
    stopAuto();
    buildBoard();
    recompute();
    render();
    msg('Gespeichertes Spiel geladen.');
  } else {
    newGame();
  }
}

function init() {
  const sel = $('strategy');
  for (const [k, v] of Object.entries(E.STRATEGIES)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = v.name + (k === 'infoPerMiss' ? ' (Standard)' : '');
    sel.appendChild(o);
  }
  if (!E.STRATEGIES[S.strategy]) S.strategy = 'infoPerMiss';
  sel.value = S.strategy;
  $('strategy-desc').textContent = E.STRATEGIES[S.strategy].desc;
  sel.addEventListener('change', () => {
    S.strategy = sel.value;
    store.set('strategy', S.strategy);
    $('strategy-desc').textContent = E.STRATEGIES[S.strategy].desc;
    S.manualSelect = false;
    recompute();
  });

  document.querySelectorAll('input[name=view]').forEach((r) =>
    r.addEventListener('change', () => { S.view = r.value; render(); }));
  $('evil').checked = S.evil;
  $('legend-evil').hidden = !S.evil;
  $('fire').addEventListener('click', () => setUnleash(!S.unleash));
  $('evil').addEventListener('change', (e) => {
    S.evil = e.target.checked;
    store.set('evil', S.evil);
    $('legend-evil').hidden = !S.evil;
    S.manualSelect = false;
    recompute();
  });
  $('show-parity').addEventListener('change', (e) => { S.showParity = e.target.checked; render(); });
  $('show-numbers').addEventListener('change', (e) => { S.showNumbers = e.target.checked; render(); });

  document.querySelectorAll('#real-actions [data-res]').forEach((b) =>
    b.addEventListener('click', () => shoot(S.selected, b.dataset.res)));
  $('undo').addEventListener('click', undo);
  $('new-game').addEventListener('click', () => {
    if (S.mode === 'real' && S.game.shots > 0 && !E.isFinished(S.game) && !confirm('Laufendes Spiel verwerfen?')) return;
    newGame();
  });
  $('mode-real').addEventListener('click', () => S.mode !== 'real' && setMode('real'));
  $('mode-demo').addEventListener('click', () => S.mode !== 'demo' && setMode('demo'));
  $('demo-shoot').addEventListener('click', () => demoShoot(S.selected));
  $('demo-bot').addEventListener('click', botMove);
  $('demo-auto').addEventListener('click', () => {
    if (S.auto) return stopAuto();
    if (E.isFinished(S.game)) newGame();
    S.auto = true;
    $('demo-auto').textContent = 'Stopp ⏸';
    autoStep();
  });
  $('demo-reveal').addEventListener('click', () => { S.reveal = !S.reveal; render(); });

  $('clear-cell').addEventListener('click', clearSelected);
  $('cfg-apply').addEventListener('click', applySettings);
  $('cfg-reset').addEventListener('click', () => {
    draft = draftFromConfig(E.normalizeConfig(E.DEFAULT_CONFIG));
    $('cfg-samples').value = 30000;
    renderSettings();
    msg('Standardwerte geladen – „Übernehmen“ drücken.');
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const { rows, cols } = S.game.config;
    const moves = { arrowup: -cols, arrowdown: cols, arrowleft: -1, arrowright: 1 };
    if (moves[k] !== undefined) {
      e.preventDefault();
      let x = S.selected < 0 ? 0 : S.selected;
      const r = Math.floor(x / cols), c = x % cols;
      if (k === 'arrowup' && r > 0) x -= cols;
      if (k === 'arrowdown' && r < rows - 1) x += cols;
      if (k === 'arrowleft' && c > 0) x -= 1;
      if (k === 'arrowright' && c < cols - 1) x += 1;
      onCellClick(x);
      return;
    }
    if (k === 'z') return undo();
    if (k === 'f' && S.evil && !E.isFinished(S.game)) return setUnleash(!S.unleash);
    if (S.mode === 'real') {
      if (k === 'l' || k === 'backspace' || k === 'delete') { e.preventDefault(); clearSelected(); }
      else if (k === 'w') shoot(S.selected, 'miss');
      else if (k === 't') shoot(S.selected, 'hit');
      else if (k === 'v') shoot(S.selected, 'sunk');
    } else {
      if (k === ' ' || k === 'enter') { e.preventDefault(); demoShoot(S.selected); }
      else if (k === 'b') botMove();
    }
  });

  S.config = E.normalizeConfig(S.config);
  fillSettings();
  setMode('real');
}

init();
