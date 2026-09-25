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

/** The one-shot pre-switch account observation from an existing target session. */
export async function currentAccount({ device = null, timeoutMs = 1000 } = {}) {
  record('current_account', device, timeoutMs);
  const o = CTL.accountObservation;
  if (o) return { hasSession: o.accountId != null, ...o };
  return {
    accountId: null,
    title: null,
    hasSession: false,
    reason: 'no active session on the target player',
  };
}

/**
 * The post-play session wait + account audit. Scripted off `CTL.accountVerdicts` (one per
 * call, last repeats) or, when that is empty, `CTL.accountVerdict`, which the driver tests
 * set to whatever `/status/sessions` would have said. Default: a session on the expected
 * account. A scripted verdict that omits `hasSession` gets it derived from `accountId`.
 */
export async function verifyAccount(expectAccountId, { device = null } = {}) {
  record('verify_account', expectAccountId, device);
  const nth = CTL.calls.filter((c) => c[0] === 'verify_account').length - 1;
  const v = CTL.accountVerdicts.length
    ? CTL.accountVerdicts[Math.min(nth, CTL.accountVerdicts.length - 1)]
    : CTL.accountVerdict;
  if (v) return { hasSession: v.accountId != null, ...v };
  return {
    isMismatch: false, accountId: expectAccountId ?? null, title: 'stub', hasSession: true,
  };
}

export async function stopPlayback(device = null) {
  record('stop_playback', device);
  return true;
}
