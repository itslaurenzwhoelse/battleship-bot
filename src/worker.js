// Web Worker: rechnet die Analyse im Hintergrund, damit die Seite flüssig bleibt.
import { analyze, chooseShot } from './engine.js?v=5';

self.onmessage = (e) => {
  const { id, game, strategy, samples, evil } = e.data;
  const t0 = performance.now();
  const analysis = analyze(game, { samples });
  const choice = chooseShot(game, analysis, strategy, { evil });
  self.postMessage({ id, analysis, choice, ms: performance.now() - t0 });
};
