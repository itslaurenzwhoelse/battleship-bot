// Benchmark: Strategien auf denselben zufälligen Aufstellungen vergleichen.
// Aufruf: node bench/bench.mjs [Spiele] [Stichproben pro Zug]
// Gemessen wird vor allem die Zahl der Fehlschüsse – bei "Treffer = nochmal
// schießen" entscheidet nur sie, wie viele Runden man braucht.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os from 'node:os';
import * as E from '../src/engine.js';

const STRATS = (process.env.STRATS || 'infoPerMiss,entropy,probability').split(',');
const NAMES = { ...Object.fromEntries(Object.entries(E.STRATEGIES).map(([k, v]) => [k, v.name])), evil: 'Evil-Modus (Info pro Fehlschuss)' };

function playGame(ships, strategy, samples, seed) {
  const g = E.newGame();
  let move = 0;
  while (!E.isFinished(g)) {
    const a = E.analyze(g, { samples, seed: seed * 1000 + move++ });
    const evil = strategy === 'evil';
    const { cell } = E.chooseShot(g, a, evil ? 'infoPerMiss' : strategy, { evil });
    if (cell < 0) throw new Error('kein Zug gefunden');
    const r = E.applyShot(g, cell, E.resolveShot(g, ships, cell));
    if (!r.ok) throw new Error(r.error);
  }
  return { shots: g.shots, misses: g.misses };
}

if (isMainThread) {
  const games = +(process.argv[2] ?? 120);
  const samples = +(process.argv[3] ?? 4000);
  const threads = Math.max(1, os.cpus().length);
  const rng = E.makeRng(20261101);
  console.log(`Erzeuge ${games} zufällige Aufstellungen ...`);
  const boards = Array.from({ length: games }, () => E.randomFleet(E.DEFAULT_CONFIG, rng));
  const jobs = [];
  boards.forEach((ships, i) => STRATS.forEach((s) => jobs.push({ i, s, ships })));
  const results = Object.fromEntries(STRATS.map((s) => [s, []]));
  let next = 0, done = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: threads }, () =>
      new Promise((resolve) => {
        const w = new Worker(new URL(import.meta.url), { workerData: { samples } });
        const feed = () => {
          if (next >= jobs.length) { w.terminate(); resolve(); return; }
          w.postMessage(jobs[next++]);
        };
        w.on('message', (m) => {
          results[m.s][m.i] = m.res;
          if (++done % 30 === 0) console.log(`  ${done}/${jobs.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
          feed();
        });
        feed();
      }),
    ),
  );
  const stats = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / (s.length - 1));
    return { mean, se: sd / Math.sqrt(s.length), median: s[s.length >> 1], min: s[0], max: s[s.length - 1] };
  };
  console.log(`\n${games} Spiele, 9x9, Flotte 3x4 + 5x3, ${samples} Stichproben/Zug\n`);
  console.log('Strategie                       Fehlschüsse Ø (±SE)   Median  Min  Max   Schüsse Ø');
  for (const s of STRATS) {
    const m = stats(results[s].map((r) => r.misses));
    const sh = stats(results[s].map((r) => r.shots));
    console.log(
      `${NAMES[s].padEnd(36)}${m.mean.toFixed(2).padStart(6)} (±${m.se.toFixed(2)})   ${String(m.median).padStart(6)} ${String(m.min).padStart(4)} ${String(m.max).padStart(4)}   ${sh.mean.toFixed(2)}`,
    );
  }
  // gepaarter Vergleich
  console.log('\nGepaarter Vergleich (gleiche Aufstellungen), Differenz der Fehlschüsse:');
  for (let a = 0; a < STRATS.length; a++)
    for (let b = a + 1; b < STRATS.length; b++) {
      const d = stats(results[STRATS[a]].map((r, i) => r.misses - results[STRATS[b]][i].misses));
      console.log(`  ${STRATS[a]} − ${STRATS[b]}: ${d.mean.toFixed(2)} (±${d.se.toFixed(2)})`);
    }
  console.log(`\nDauer: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} else {
  parentPort.on('message', ({ i, s, ships }) => {
    parentPort.postMessage({ i, s, res: playGame(ships, s, workerData.samples, i + 1) });
  });
}
