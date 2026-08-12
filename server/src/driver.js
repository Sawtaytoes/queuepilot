// Playback state machine: sample the Shield's real state, then drive it to `playing`.
//
// Ported from the retired Python driver (PLAYBACK_FSM). Replaces the fire-and-forget tail
// (ensurePlexOpen -> waitForProfile -> play) with a machine that SAMPLES real state and
// runs VERIFIED, RETRIED, NON-DESTRUCTIVE transitions toward the target:
//
//     unreachable ──▶ device_on ──▶ plex_foreground ──▶ signed_in(required) ──▶ playing(target)
//
// Every edge verifies it landed before proceeding, retries a bounded number of times, and
// never destroys progress it can't recover cheaply (no force-stop of a running movie, no
// picker walk when already on the right profile). Play is ALWAYS the last action, and it
// is verified: the Companion port is probed and Plex confirmed foreground immediately
// before playMedia fires.
//
// Gated behind env.PLAYBACK_FSM (default off). Reuses adb / profiles / playback primitives
// — it does not re-derive picker or profile logic. See docs/playback-state-machine-design.md.
//

import {
  ADB_ENABLED,
  PLAYBACK_MODE,
  SHIELD_CLIENT_URI,
  SHIELD_IP,
  COMPANION_PORT,
  PLAYBACK_FSM_PLAY_ATTEMPTS,
  PLAYBACK_FSM_SWITCH_ATTEMPTS,
  PLAYBACK_FSM_RETRY_BACKOFF,
} from './env.js';
import * as adb from './adb.js';
import * as playback from './playback.js';
import * as profiles from './profiles.js';

// Read aloud verbatim by automation.plex_channels_status_announcements, so these stay
// sentences a person would say — no timeout figures, no switcher jargon (the diagnostic
// detail goes to the log). See docs/decisions/2026-07-26-spoken-status-is-a-sentence-not-a-diagnostic.md.
const SWITCH_ERROR = (
  "'{label}' needs the '{profile}' Plex profile, and the Shield did not "
  + 'switch to it. Pick it on the TV.'
);
const PLAY_ERROR = "Plex wasn't ready to play on the Shield. Try the card again.";

const sleep = (s) => new Promise((r) => setTimeout(r, Math.max(0, Number(s) || 0) * 1000));

function isCancelled(cancel) {
  if (!cancel) return false;
  // Node Event-like: .isSet(); Python threading.Event: .is_set / .isSet.
  if (typeof cancel.isSet === 'function') return Boolean(cancel.isSet());
  if (typeof cancel.is_set === 'function') return Boolean(cancel.is_set());
  return false;
}

// Surface a mid-flight transition on plex-channels/state (what HA's status sensor shows).
// Lazy / soft: mqttd (D6) or service may not be wired yet. A null client (unit tests) is a
// no-op, so the driver stays testable without MQTT. Optional `publishState` inject for tests.
let _publishState = null;
export function setPublishState(fn) {
  _publishState = fn;
}

function publishAwait(client, awaiting) {
  if (client == null && !_publishState) return;
  if (_publishState) {
    try { _publishState(client, { awaiting }); } catch { /* ignore */ }
    return;
  }
  // Soft: when mqttd lands it can assign setPublishState. Until then, no-op.
}

// Is the Shield's Plex app the foreground activity right now? (ADB read, ~50ms.)
// PLEX_PKG is not re-exported from adb.js (only TITLE_ID is); hardcode the package.
const PLEX_PKG = 'com.plexapp.android';
async function plexForeground() {
  const act = await Promise.resolve(adb.foregroundActivity());
  return Boolean(act && String(act).includes(PLEX_PKG));
}

// device_on + plex_foreground, retried. Non-fatal: ensurePlexOpen never force-stops, and
// a play still tries even if ADB can't confirm Plex came up (HA may have launched it).
async function ensurePlex(attempts = 2) {
  const n = Math.max(1, attempts);
  for (let i = 0; i < n; i++) {
    const ok = await Promise.resolve(adb.ensurePlexOpen());
    if (ok) return true;
    await sleep(PLAYBACK_FSM_RETRY_BACKOFF);
  }
  return false;
}

// (host, port) of the target's Companion endpoint, for the readiness probe.
// A start command's `target` device carries its own Companion uri; otherwise the
// env-default Shield's SHIELD_CLIENT_URI, else SHIELD_IP:COMPANION_PORT.
export function companionAddr(device) {
  const uri = (device && device.uri) || SHIELD_CLIENT_URI;
  if (uri) {
    try {
      const withScheme = String(uri).includes('://') ? String(uri) : `http://${uri}`;
      const sp = new URL(withScheme);
      if (sp.hostname) {
        return [sp.hostname, sp.port ? Number(sp.port) : COMPANION_PORT];
      }
    } catch {
      /* fall through */
    }
  }
  return [SHIELD_IP, COMPANION_PORT];
}

// Did play fail because the Companion port refused the connection (Errno 111 / ECONNREFUSED)?
// playRatingKeys returns the error as a string rather than raising, so match on the text.
// Only this failure mode warrants a re-open-and-retry; an HTTP error means Plex answered.
export function isConnRefused(result) {
  const err = String((result && result.error) || '').toLowerCase();
  return (
    err.includes('connection refused')
    || err.includes('econnrefused')
    || err.includes('errno 111')
    || err.includes('urlopen error')
  );
}

// Is the Shield already signed into `required`, per the cached LAST_SEEN? Alias-aware.
// The one place the skip decision is made, so the picker is never walked when a cheap,
// alias-resolved read of the last-seen profile already proves we're on the right one.
async function onRequired(required) {
  const seen = profiles.LAST_SEEN.title;
  if (!seen) return false;
  return Boolean(await Promise.resolve(adb.sameProfile(seen, required)));
}

// signed_in(required). Returns null on success, or a terminal result (cancelled / error).
//
// NON-DESTRUCTIVE fast path: if the Shield is already signed into `required`
// (profiles.LAST_SEEN, alias-aware via adb.sameProfile), this is a no-op — it never walks
// the picker. Only when a real change is needed does it drive adb.switchTo, bounded-retried.
// A successful switch RECORDS `required` into LAST_SEEN so the next gated scan skips.
async function driveProfile(client, required, cancel) {
  if (await onRequired(required)) {
    console.log(
      `[driver] already signed in as '${profiles.LAST_SEEN.title}' `
      + `(== '${required}'); no picker walk`,
    );
    return null;
  }

  publishAwait(client, `profile:${required}`);

  if (!ADB_ENABLED) {
    // Can't drive the picker — wait for a human/HA to sign in, satisfied by the PMS log.
    const title = await profiles.waitForProfile({ cancel, match: required });
    if (isCancelled(cancel)) return { cancelled: true };
    if (title == null) return { error: SWITCH_ERROR, _profile: required };
    return null;
  }

  const attempts = Math.max(1, PLAYBACK_FSM_SWITCH_ATTEMPTS);
  for (let i = 0; i < attempts; i++) {
    if (isCancelled(cancel)) return { cancelled: true };
    // adb.js: switchTo(target, cancel = null, knownCurrent = null) → [ok, detail]
    let out;
    try {
      out = await adb.switchTo(required, cancel, profiles.LAST_SEEN.title);
    } catch (e) {
      out = [false, e && e.message ? e.message : String(e)];
    }
    let ok;
    let detail;
    if (Array.isArray(out)) {
      [ok, detail] = out;
    } else if (out && typeof out === 'object' && 'ok' in out) {
      ok = out.ok;
      detail = out.detail;
    } else {
      ok = Boolean(out);
      detail = out;
    }
    if (ok) {
      console.log(`[driver] switched to '${required}': ${detail}`);
      // Cache the confirmed profile so the NEXT gated scan short-circuits (no picker).
      profiles.LAST_SEEN.title = required;
      return null;
    }
    // A human or HA may have signed in meanwhile — a fresh LAST_SEEN also clears the gate.
    if (await onRequired(required)) {
      console.log(
        `[driver] gate cleared out-of-band: signed in as '${profiles.LAST_SEEN.title}'`,
      );
      return null;
    }
    console.log(
      `[driver] switch attempt ${i + 1}/${attempts} to '${required}' failed: ${detail}`,
    );
    await sleep(PLAYBACK_FSM_RETRY_BACKOFF);
  }
  return { error: SWITCH_ERROR, _profile: required };
}

// playing(target). Play is the LAST action and it is VERIFIED.
//
// The Companion-refused failure mode is client-mode only: before each attempt the driver
// confirms Plex is foreground AND the Companion port accepts a TCP connect, re-opening
// Plex when either is false; a play that still comes back ECONNREFUSED re-opens and
// retries, a bounded few times. Success (or any non-connection failure) returns immediately.
// Cast mode doesn't use Companion :32500 — play once and return its result.
async function drivePlay(ratingKeys, setName, device, offset, cancel) {
  const mode = (device && device.mode) || PLAYBACK_MODE;
  if (mode !== 'client') {
    return playback.playRatingKeys(ratingKeys, { setName, device, offset });
  }

  const [host, port] = companionAddr(device);
  const attempts = Math.max(1, PLAYBACK_FSM_PLAY_ATTEMPTS);
  let result = null;
  for (let i = 0; i < attempts; i++) {
    if (isCancelled(cancel)) return { cancelled: true };
    // Verify plex_foreground + Companion readiness immediately BEFORE firing play.
    if (ADB_ENABLED && !(await plexForeground())) {
      console.log('[driver] Plex not foreground before play; re-opening');
      await ensurePlex();
    }
    if (!(await playback.companionReady(host, port))) {
      console.log(
        `[driver] Companion ${host}:${port} not accepting a connection; re-opening Plex`,
      );
      if (ADB_ENABLED) await ensurePlex();
      await sleep(PLAYBACK_FSM_RETRY_BACKOFF);
    }
    result = await playback.playRatingKeys(ratingKeys, { setName, device, offset });
    if (result && result.played) return result;
    if (isConnRefused(result)) {
      console.log(
        `[driver] play attempt ${i + 1}/${attempts} refused: ${result && result.error}; `
        + 're-opening Plex and retrying',
      );
      if (ADB_ENABLED) await ensurePlex();
      await sleep(PLAYBACK_FSM_RETRY_BACKOFF);
      continue;
    }
    // A non-connection failure (HTTP, no client advertising): Plex answered — surface it
    // as-is so state/last-played publish exactly as the legacy path did.
    return result;
  }
  console.log(
    `[driver] play still refused after ${attempts} attempts: ${result && result.error}`,
  );
  return { error: PLAY_ERROR, _diag: result };
}

// Drive the target device from wherever it is to `playing(target)`.
//
// Returns the playback result dict on success (published as-is), {cancelled: true} when a
// newer scan cancelled this one, or {error: "<spoken sentence>"} when a transition's
// bounded retries were exhausted (the diagnostic detail is already in the log). Selection
// (which items, which profile binding) is done by the caller and unchanged; this owns only
// the launch + profile gate + verified play.
//
// Signature: driveToPlaying(client, { ratingKeys, requiredProfile, offset, device,
// setName, cancel, setLabel }).
export async function driveToPlaying(client, {
  ratingKeys,
  requiredProfile = null,
  offset = 0,
  device = null,
  setName = null,
  cancel = null,
  setLabel = null,
} = {}) {
  if (isCancelled(cancel)) return { cancelled: true };

  // unreachable -> device_on -> plex_foreground. Best-effort head start (the play step
  // re-verifies foreground itself); ADB off/unreachable falls back to whatever HA launched.
  if (ADB_ENABLED) await ensurePlex();

  // plex_foreground -> signed_in(required). Only when the set/card demands a profile.
  if (requiredProfile) {
    const r = await driveProfile(client, requiredProfile, cancel);
    if (r != null) {
      if (r.error === SWITCH_ERROR) {
        const profile = r._profile != null ? r._profile : requiredProfile;
        delete r._profile;
        r.error = SWITCH_ERROR
          .replace('{label}', setLabel || setName || '')
          .replace('{profile}', profile);
      }
      return r;
    }
  }

  if (isCancelled(cancel)) return { cancelled: true };

  // signed_in(required) -> playing(target). Play is the last action, verified + retried.
  return drivePlay(ratingKeys, setName, device, offset, cancel);
}

// Exported for unit tests (parity with e2e/playback-fsm-test.py scenarios).
export const _internals = {
  SWITCH_ERROR,
  PLAY_ERROR,
  plexForeground,
  ensurePlex,
  onRequired,
  driveProfile,
  drivePlay,
  isCancelled,
  publishAwait,
};
