// Stand-in for server/src/playback.js under the driver's unit tests (see control.mjs).
import { CTL, record } from './control.mjs';

export async function companionReady(host = null, port = null) {
  record('companion_ready', host, port);
  return CTL.companionUp;
}

export async function playRatingKeys(ratingKeys, { setName = null, device = null, offset = 0 } = {}) {
  record('play', [...ratingKeys], offset, setName, device);
  // Pop the next scripted result; the last one repeats once the script runs out.
  const nth = CTL.calls.filter((c) => c[0] === 'play').length - 1;
  return CTL.playResults[Math.min(nth, CTL.playResults.length - 1)];
}
