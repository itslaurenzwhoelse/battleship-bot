import * as E from './engine.js?v=8';

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
  truth: null,     // Demo/Training: echte Aufstellung
  reveal: false,
  auto: false,
  blind: store.get('blind', false), // echtes Spiel ohne Hilfe, Auswertung am Ende
  trainHelp: false,
  queued: [],      // Schüsse, die auf die laufende Rechnung warten (Reihenfolge bleibt)
  lastRating: null,
  flash: null,     // {mine, best} kurz markieren
  botResult: null, // Training: Bot auf derselben Aufstellung
};

/** Darf die App gerade Hilfe (Heatmap, Empfehlung) zeigen? */
const helpVisible = () => S.mode === 'demo' || (S.mode === 'real' && !S.blind) || (S.mode === 'train' && S.trainHelp);
/** Werden Züge bewertet und protokolliert? */
const rating = () => S.mode === 'train' || S.mode === 'real';

const $ = (id) => document.getElementById(id);
const colName = (c) => String.fromCharCode(65 + c);
const cellName = (x) => colName(x % S.game.config.cols) + (Math.floor(x / S.game.config.cols) + 1);
const pct = (v) => (v * 100).toFixed(v > 0 && v < 0.01 ? 1 : 0) + ' %';

// ---------------------------------------------------------------------------
// Rechnen (Web Worker, Fallback im Hauptthread)
// ---------------------------------------------------------------------------
let worker = null;
try {
  worker = new Worker(new URL('./worker.js?v=8', import.meta.url), { type: 'module' });
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
  // Auswahl auf die Empfehlung setzen – aber nur, wenn Hilfe sichtbar ist (sonst Spoiler)
  if (helpVisible() && (!S.manualSelect || S.selected < 0 || S.game.cells[S.selected] !== E.UNKNOWN)) {
    S.selected = choice.cell;
    S.manualSelect = false;
  }
  if (analysis.contradiction && !E.isFinished(S.game)) {
    msg('Widerspruch: Keine Aufstellung passt zu den Eingaben. Bitte prüfen (Rückgängig).', 'err');
  }
  render();
  if (S.auto) setTimeout(autoStep, 250);
  if (S.queued.length) {
    S.draining = true;
    shoot(...S.queued.shift());
    S.draining = false;
  }
}

// Bot-Vergleich im Training: eigener Worker, damit die Analyse nicht wartet
let botWorker = null;
function runBotGame(ships, config, done) {
  try {
    if (!botWorker) botWorker = new Worker(new URL('./worker.js?v=8', import.meta.url), { type: 'module' });
    botWorker.onmessage = (e) => { if (e.data.type === 'botgame') done(e.data.result); };
    botWorker.postMessage({ type: 'botgame', id: 1, config, ships, samples: 8000 });
  } catch {
    setTimeout(() => done(E.simulateBotGame(config, ships, { samples: 4000 })), 20);
  }
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
  S.queued = [];
  S.lastRating = null;
  S.flash = null;
  S.botResult = null;
  stopAuto();
  if (S.mode === 'demo' || S.mode === 'train') {
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
  const li = S.game.log.findIndex((e) => e.cell === x);
  if (li >= 0) {
    if (result === 'clear') S.game.log.splice(li, 1);
    else S.game.log[li].result = result;
  }
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
  if (E.isFinished(S.game) || S.game.ended) return msg('Spiel ist vorbei – „Neues Spiel“ starten.', 'err');
  if (rating() && (S.busy || (S.queued.length && !S.draining))) { // Bewertung braucht die Rechnung zum aktuellen Stand
    S.queued.push([x, result, shipCells]);
    return;
  }
  const rated = rating() ? E.rateShot(S.game, S.analysis, x) : null;
  const before = E.cloneGame(S.game);
  const r = E.applyShot(S.game, x, result, shipCells);
  if (!r.ok && r.ambiguous) return askSunk(x, false, r.candidates);
  if (!r.ok) return msg(r.error, 'err');
  S.history.push(before);
  S.manualSelect = false;
  if (rating()) {
    S.game.log.push({ cell: x, result, rating: rated, helped: helpVisible() });
    S.lastRating = rated ? { cell: x, result, ...rated } : null;
    if (S.mode === 'train' && rated && rated.loss > 0.03) {
      S.flash = { mine: x, best: rated.bestCell };
      clearTimeout(S.flashTimer);
      S.flashTimer = setTimeout(() => { S.flash = null; render(); }, 1600);
    }
  }
  if (result === 'sunk') {
    msg(`${cellName(x)}: ${r.sunkLength}er versenkt${S.game.config.touch === 'any' ? '' : ' – Rand gesperrt'}.`, 'ok');
  } else {
    msg(`${cellName(x)}: ${result === 'hit' ? 'Treffer' : 'Wasser'}.`, result === 'hit' ? 'ok' : '');
  }
  if (E.isFinished(S.game)) {
    msg(`Alle Schiffe versenkt! ${S.game.shots} Schüsse, davon ${S.game.misses} Fehlschüsse.`, 'ok');
    stopAuto();
    if (S.mode === 'train' || (S.mode === 'real' && S.blind)) finishGame();
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

// ---------------------------------------------------------------------------
// Auswertung & Fortschritt
// ---------------------------------------------------------------------------
const configKey = (c) => `${c.rows}×${c.cols} · ${c.fleet.map((f) => `${f.count}×${f.length}`).join(' ')}${c.touch === 'none' ? '' : c.touch === 'any' ? ' · berühren' : ' · über Eck'}`;

/** Spiel beenden (fertig oder abgebrochen), bewerten und im Verlauf speichern. */
function finishGame() {
  const g = S.game;
  g.ended = true;
  if (S.mode === 'train' && S.truth) {
    const truth = S.truth, cfg = g.config;
    runBotGame(truth, cfg, (res) => {
      if (S.game !== g) return;
      S.botResult = res;
      saveHistory(g, res.misses);
      render();
    });
  } else {
    saveHistory(g, null);
  }
  saveGame();
  render();
}

function saveHistory(g, botMisses) {
  if (g.saved) return;
  const sum = E.summarizeLog(g.log);
  if (!sum.moves) return;
  g.saved = true;
  const hist = store.get('history', []);
  hist.push({
    t: Date.now(), mode: S.mode, cfg: configKey(g.config), finished: E.isFinished(g),
    shots: g.shots, misses: g.misses, accuracy: sum.accuracy, cost: sum.cost, moves: sum.moves,
    botMisses, helped: sum.helped,
  });
  store.set('history', hist.slice(-500));
}

function renderReport() {
  const card = $('report-card');
  const g = S.game;
  if (!g.ended || !(S.mode === 'train' || S.mode === 'real')) { card.hidden = true; return; }
  const sum = E.summarizeLog(g.log);
  card.hidden = false;
  const c = sum.counts, L = E.RATING_LABELS;
  const bot = S.mode === 'train'
    ? `<div><b>${S.botResult ? S.botResult.misses : '…'}</b><span>Bot (gleiche Flotte)</span></div>` : '';
  card.innerHTML = `
    <div class="card-title">Auswertung${E.isFinished(g) ? '' : ' (abgebrochen)'}</div>
    <div class="big">
      <div><b>${g.misses}</b><span>deine Fehlschüsse</span></div>${bot}
      <div><b>${Math.round(sum.accuracy * 100)} %</b><span>Genauigkeit</span></div>
      <div><b>≈ ${sum.cost.toFixed(1).replace('.', ',')}</b><span>verschenkte Fehlschüsse</span></div>
    </div>
    <div class="counts">${['sure', 'best', 'good', 'inaccuracy', 'mistake', 'blunder'].filter((k) => c[k]).map((k) => `${L[k].icon} ${L[k].text} ${c[k]}`).join(' · ')}</div>
    ${sum.helped ? '<p class="hint">Mit Hilfe gespielt – zählt nicht für den Fortschritt.</p>' : ''}
    ${sum.worst.length ? `<div class="hint">Größte Fehler (antippen zum Zeigen):</div><ol>${sum.worst.map((e) =>
      `<li data-mine="${e.cell}" data-best="${e.rating.bestCell}">Zug ${e.move}: ${cellName(e.cell)} (${pct(e.rating.p)}) – besser ${cellName(e.rating.bestCell)} (${pct(e.rating.pBest)})</li>`).join('')}</ol>` : '<p class="hint">Keine nennenswerten Fehler – stark! 🎯</p>'}
    <p class="hint">Genauigkeit = deine Trefferchancen im Verhältnis zum jeweils besten Feld. „Verschenkt“ = so viele Fehlschüsse hast du durch die Zugwahl im Schnitt mehr riskiert als nötig.</p>`;
  card.querySelectorAll('li[data-mine]').forEach((li) => li.addEventListener('click', () => {
    S.flash = { mine: +li.dataset.mine, best: +li.dataset.best };
    clearTimeout(S.flashTimer);
    S.flashTimer = setTimeout(() => { S.flash = null; render(); }, 2500);
    render();
  }));
}

function renderCoach() {
  const box = $('coach');
  const r = S.lastRating;
  if (S.mode !== 'train' || !r || S.game.ended) { box.hidden = true; return; }
  box.hidden = false;
  const L = E.RATING_LABELS[r.label];
  box.className = 'coach ' + r.label;
  const res = r.result === 'miss' ? 'Wasser' : r.result === 'hit' ? 'Treffer' : 'Versenkt';
  let detail = `${cellName(r.cell)} hatte ${pct(r.p)} Trefferchance.`;
  if (r.label === 'sure') detail = `${cellName(r.cell)} war ein sicherer Treffer.`;
  else if (r.label === 'blunder') detail = `${cellName(r.cell)} war sicher Wasser – z. B. diagonal neben einem Treffer oder am Rand eines versenkten Schiffs. Besser: ${cellName(r.bestCell)} (${pct(r.pBest)}).`;
  else if (r.loss > 0.03) detail += ` Besser: ${cellName(r.bestCell)} (${pct(r.pBest)}).`;
  if (r.sureAvailable && r.label !== 'sure') detail += ' Tipp: Es gab einen sicheren Treffer – der kostet nie einen Zug.';
  box.innerHTML = `<b>${L.icon} ${L.text}</b> · ${res}<br>${detail}`;
}

function renderProgress() {
  const el = $('progress');
  const key = configKey(S.config);
  const all = store.get('history', []);
  const hist = all.filter((h) => h.cfg === key && !h.helped);
  if (!hist.length) {
    el.innerHTML = `<p class="hint">Noch keine Spiele mit diesen Regeln (${key}). Spiel ein Training oder ein echtes Spiel im Blind-Modus – danach erscheint hier dein Verlauf.</p>`;
    return;
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const last5 = hist.slice(-5), before = hist.slice(-10, -5);
  const done5 = hist.filter((h) => h.finished).slice(-5);
  const acc5 = mean(last5.map((h) => h.accuracy));
  const trend = before.length ? acc5 - mean(before.map((h) => h.accuracy)) : null;
  const train = hist.filter((h) => h.mode === 'train' && h.botMisses != null && h.finished);
  const gap = train.length ? mean(train.slice(-5).map((h) => h.misses - h.botMisses)) : null;
  const fmt = (v, d = 1) => v.toFixed(d).replace('.', ',');
  // Diagramm: Genauigkeit je Spiel (eine Serie, kein Legendenkasten nötig)
  const pts = hist.slice(-30);
  const W = 300, H = 120, padL = 26, padR = 8, padT = 8, padB = 18;
  const lo = Math.min(0.5, ...pts.map((h) => h.accuracy)), hi = 1;
  const xs = (i) => padL + (pts.length === 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (pts.length - 1));
  const ys = (v) => padT + ((hi - v) * (H - padT - padB)) / (hi - lo);
  const ticks = [lo, (lo + hi) / 2, hi];
  const line = pts.map((h, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(h.accuracy).toFixed(1)}`).join(' ');
  const date = (t) => new Date(t).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  const label = (h, i) => `Spiel ${hist.length - pts.length + i + 1} (${date(h.t)}, ${h.mode === 'train' ? 'Training' : 'echt'}): Genauigkeit ${Math.round(h.accuracy * 100)} %, ${h.misses} Fehlschüsse${h.botMisses != null ? `, Bot ${h.botMisses}` : ''}`;
  el.innerHTML = `
    <div class="prog-sum">
      <div><b>${Math.round(acc5 * 100)} %</b><span>Ø Genauigkeit (letzte 5)</span></div>
      <div><b>${trend == null ? '–' : (trend >= 0 ? '+' : '−') + fmt(Math.abs(trend) * 100) + ' P.'}</b><span>Trend ggü. den 5 davor</span></div>
      <div><b>${done5.length ? fmt(mean(done5.map((h) => h.misses))) : '–'}</b><span>Ø Fehlschüsse (letzte 5 fertigen)</span></div>
      <div><b>${gap == null ? '–' : (gap >= 0 ? '+' : '−') + fmt(Math.abs(gap))}</b><span>Fehlschüsse mehr als der Bot (Training)</span></div>
    </div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Genauigkeit pro Spiel">
      ${ticks.map((t) => `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${ys(t)}" y2="${ys(t)}"/><text class="axis" x="${padL - 4}" y="${ys(t) + 3}" text-anchor="end">${Math.round(t * 100)}%</text>`).join('')}
      <path class="line" d="${line}"/>
      ${pts.map((h, i) => `<g data-i="${i}"><circle class="hit" cx="${xs(i)}" cy="${ys(h.accuracy)}" r="10"/><circle class="dot" cx="${xs(i)}" cy="${ys(h.accuracy)}" r="4"/></g>`).join('')}
      <text class="axis" x="${padL}" y="${H - 4}">älter</text><text class="axis" x="${W - padR}" y="${H - 4}" text-anchor="end">neuer</text>
    </svg>
    <div class="chart-tip" id="chart-tip">Genauigkeit pro Spiel – Punkt antippen für Details.</div>
    <p class="hint">Die Genauigkeit schwankt weniger als die Fehlschüsse (die hängen stark vom Glück ab). Steigt sie über mehrere Spiele, wird deine Intuition besser. Nur Spiele ohne Hilfe zählen.</p>
    <details><summary class="hint">Alle Spiele als Tabelle</summary>
      <table class="prog-table"><thead><tr><th>Datum</th><th>Art</th><th>Genau.</th><th>Fehl</th><th>Bot</th></tr></thead><tbody>
      ${hist.slice().reverse().map((h) => `<tr><td>${date(h.t)}</td><td>${h.mode === 'train' ? 'Training' : 'echt'}${h.finished ? '' : '*'}</td><td>${Math.round(h.accuracy * 100)} %</td><td>${h.misses}</td><td>${h.botMisses ?? '–'}</td></tr>`).join('')}
      </tbody></table>
      <p class="hint">* abgebrochen</p>
      <button class="btn ghost small" id="clear-history">Verlauf löschen</button>
    </details>`;
  const tip = el.querySelector('#chart-tip');
  el.querySelectorAll('g[data-i]').forEach((gEl) => {
    const show = () => {
      el.querySelectorAll('.dot.on').forEach((d) => d.classList.remove('on'));
      gEl.querySelector('.dot').classList.add('on');
      tip.textContent = label(pts[+gEl.dataset.i], +gEl.dataset.i);
    };
    gEl.addEventListener('mouseenter', show);
    gEl.addEventListener('click', show);
  });
  el.querySelector('#clear-history').addEventListener('click', () => {
    if (!confirm('Gesamten Verlauf löschen?')) return;
    store.set('history', all.filter((h) => h.cfg !== key));
    renderProgress();
  });
}

function trainShoot(x) {
  if (!S.truth || S.game.ended) return;
  const cur = S.game.cells[x];
  if (cur !== E.UNKNOWN && cur !== E.BLOCKED) return msg('Feld wurde schon beschossen.', 'err');
  const res = E.resolveShot(S.game, S.truth, x);
  shoot(x, res, res === 'sunk' ? E.shipAt(S.truth, x) : undefined);
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
  store.set('game', { config: g.config, cells: Array.from(g.cells), remaining: g.remaining, sunkShips: g.sunkShips, shots: g.shots, misses: g.misses, log: g.log, ended: g.ended, saved: g.saved });
}

function loadGame() {
  const saved = store.get('game', null);
  if (!saved || JSON.stringify(E.normalizeConfig(saved.config)) !== JSON.stringify(E.normalizeConfig(S.config))) return false;
  const g = E.newGame(saved.config);
  g.cells.set(saved.cells);
  Object.assign(g, { remaining: saved.remaining, sunkShips: saved.sunkShips, shots: saved.shots, misses: saved.misses, log: saved.log || [], ended: !!saved.ended, saved: !!saved.saved });
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
  if (S.mode === 'train') return trainShoot(x);
  S.selected = x;
  S.manualSelect = true;
  render();
}

const HEAT = { prob: '#f59e0b', entropy: '#8b5cf6' };

function render() {
  const g = S.game;
  const help = helpVisible();
  const a = help ? S.analysis : null;
  const n = g.cells.length;
  const parity = new Set(S.showParity && a ? a.parity.cells : []);
  const best = help ? S.choice?.cell ?? -1 : -1;
  const remembered = new Set(help ? S.choice?.remembered || [] : []);
  const ranks = new Map(help ? (S.choice?.ranking || []).slice(0, 5).map((r, i) => [r.cell, i + 1]) : []);
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
    if (S.flash && x === S.flash.best) cls.push('coach-best');
    if (S.flash && x === S.flash.mine) cls.push('coach-mine');
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
  document.querySelector('#rec-card .rec-title').textContent = help ? 'Empfehlung' : 'Status';
  document.querySelector('.sel-line').hidden = S.mode === 'train';
  if (!help) {
    $('rec-cell').textContent = S.mode === 'train' ? '🎯' : '🙈';
    $('rec-cell').classList.remove('finale');
    $('rec-stats').innerHTML = g.ended
      ? 'Spiel ausgewertet – siehe unten.'
      : S.mode === 'train'
        ? `Training: Schieß nach Gefühl. ${g.shots} Schüsse, ${g.misses} Fehlschüsse.`
        : 'Blind-Modus: keine Hilfe. Trag deine Schüsse wie gewohnt ein – am Ende gibt es die Auswertung.';
  } else if (done) {
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
  if (sv === E.UNKNOWN && a && help) hint = `(Treffer ${pct(a.pShip[sel])})`;
  else if (S.mode === 'real' && (sv === E.MISS || sv === E.HIT || sv === E.SUNK)) {
    hint = `(${STATE_NAME[sv]} – zum Ändern anderen Knopf drücken oder leeren)`;
  } else if (sv === E.BLOCKED) hint = '(automatisch gesperrt)';
  $('sel-hint').textContent = hint;
  const clr = $('clear-cell');
  clr.hidden = S.mode !== 'real';
  clr.disabled = !(sv === E.MISS || sv === E.HIT || sv === E.SUNK);
  $('undo').disabled = !S.history.length;
  $('undo').hidden = S.mode === 'train';
  $('blind-wrap').hidden = S.mode !== 'real';
  $('end-game').hidden = !(S.mode === 'real' && S.blind && g.shots > 0 && !g.ended);

  renderSunkChoice();
  renderCoach();
  renderReport();
  renderProgress();
  renderFleet();
  renderStats();
}

function renderFleet() {
  const g = S.game;
  const el = $('fleet');
  el.innerHTML = '';
  const help = helpVisible();
  const found = help ? S.analysis?.found || [] : [];
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
  const p = help ? S.analysis?.parity : null;
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
  if (!helpVisible()) {
    $('stats').innerHTML = `<dt>Schüsse</dt><dd>${g.shots}</dd><dt>Fehlschüsse</dt><dd>${g.misses}</dd>`;
    $('top-list').innerHTML = '';
    return;
  }
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
  $('mode-train').classList.toggle('active', mode === 'train');
  $('mode-demo').classList.toggle('active', mode === 'demo');
  $('real-actions').hidden = mode !== 'real';
  $('train-actions').hidden = mode !== 'train';
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
    if (S.mode === 'real' && S.game.shots > 0 && !E.isFinished(S.game) && !S.game.ended && !confirm('Laufendes Spiel verwerfen?')) return;
    newGame();
  });
  $('mode-real').addEventListener('click', () => S.mode !== 'real' && setMode('real'));
  $('mode-demo').addEventListener('click', () => S.mode !== 'demo' && setMode('demo'));
  $('mode-train').addEventListener('click', () => S.mode !== 'train' && setMode('train'));
  $('blind').checked = S.blind;
  $('blind').addEventListener('change', (e) => {
    S.blind = e.target.checked;
    store.set('blind', S.blind);
    msg(S.blind ? '🙈 Blind-Modus an – ab jetzt keine Hilfe.' : 'Blind-Modus aus – die restlichen Züge zählen als „mit Hilfe“.');
    render();
  });
  $('end-game').addEventListener('click', () => {
    if (!confirm('Spiel jetzt beenden und auswerten? (z. B. wenn deine Gegnerin gewonnen hat)')) return;
    finishGame();
    msg('Spiel beendet – Auswertung siehe oben.', 'ok');
  });
  $('train-help').addEventListener('change', (e) => { S.trainHelp = e.target.checked; render(); });
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
      S.selected = x;
      S.manualSelect = true;
      render();
      return;
    }
    if (k === 'z') return undo();
    if (k === 'f' && S.evil && !E.isFinished(S.game)) return setUnleash(!S.unleash);
    if (S.mode === 'real') {
      if (k === 'l' || k === 'backspace' || k === 'delete') { e.preventDefault(); clearSelected(); }
      else if (k === 'w') shoot(S.selected, 'miss');
      else if (k === 't') shoot(S.selected, 'hit');
      else if (k === 'v') shoot(S.selected, 'sunk');
    } else if (S.mode === 'train') {
      if (k === ' ' || k === 'enter') { e.preventDefault(); trainShoot(S.selected); }
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
