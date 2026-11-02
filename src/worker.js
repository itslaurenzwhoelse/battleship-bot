// Web Worker: rechnet die Analyse im Hintergrund, damit die Seite flüssig bleibt.
import { analyze, chooseShot, simulateBotGame } from './engine.js?v=8';

self.onmessage = (e) => {
  if (e.data.type === 'botgame') {
    const { id, config, ships, samples } = e.data;
    self.postMessage({ type: 'botgame', id, result: simulateBotGame(config, ships, { samples }) });
    return;
  }
  const { id, game, strategy, samples, evil } = e.data;
  const t0 = performance.now();
  const analysis = analyze(game, { samples });
  const choice = chooseShot(game, analysis, strategy, { evil });
  self.postMessage({ id, analysis, choice, ms: performance.now() - t0 });
};
