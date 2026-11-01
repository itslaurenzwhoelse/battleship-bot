// Web Worker: rechnet die Analyse im Hintergrund, damit die Seite flüssig bleibt.
import { analyze, chooseShot } from './engine.js';

self.onmessage = (e) => {
  const { id, game, strategy, samples } = e.data;
  const t0 = performance.now();
  const analysis = analyze(game, { samples });
  const choice = chooseShot(game, analysis, strategy);
  self.postMessage({ id, analysis, choice, ms: performance.now() - t0 });
};
