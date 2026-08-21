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

/**
 * The post-play account audit. Scripted off `CTL.accountVerdict`, which the driver tests set
 * to whatever `/status/sessions` would have said. Default: the account matches.
 */
export async function verifyAccount(expectAccountId, { device = null } = {}) {
  record('verify_account', expectAccountId, device);
  const v = CTL.accountVerdict;
  if (v) return v;
  return { isMismatch: false, accountId: expectAccountId ?? null, title: 'stub' };
}

export async function stopPlayback(device = null) {
  record('stop_playback', device);
  return true;
}
