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
import type { PlaybackResult } from './playback.js';
import * as profiles from './profiles.js';
import type { CancelFlag, Device, PublishedStateExtra, PushResult } from './types.js';
import { errMessage, isCancelled } from './errors.js';

/**
 * What `setPublishState()` accepts: mqttd's `publishState(extra)`, handed down through
 * `session.setPublishers()`. Spelled as the SHARED `PublishedStateExtra` (types.ts) rather
 * than a local re-declaration — the local copy this file used to carry took a leading mqtt
 * `client` argument the real publisher never had, and nothing typechecked the gap.
 */
type PublishStateFn = (extra: PublishedStateExtra) => void;

// Read aloud verbatim by automation.plex_channels_status_announcements, so these stay
// sentences a person would say — no timeout figures, no switcher jargon (the diagnostic
// detail goes to the log). See docs/decisions/2026-07-26-spoken-status-is-a-sentence-not-a-diagnostic.md.
const SWITCH_ERROR = (
  "'{label}' needs the '{profile}' Plex profile, and the Shield did not "
  + 'switch to it. Pick it on the TV.'
);
const PLAY_ERROR = "Plex wasn't ready to play on the Shield. Try the card again.";
// Read aloud like the two above, so it stays a sentence a person would say. This one is the
// audit failing: playback DID start, and it started as the wrong person.
const ACCOUNT_ERROR = (
  "'{label}' is for the '{profile}' profile, but the Shield played it as '{actual}'. "
  + 'I stopped it. Pick the right profile on the TV and try again.'
);

const sleep = (s: number): Promise<void> => new Promise((r) => {
  setTimeout(r, Math.max(0, Number(s) || 0) * 1000);
});

// isCancelled is now imported from ./errors.js — byte-for-byte the same isSet-then-is_set
// probe this module inlined (see CancelFlag in types.ts). Still re-exported on `_internals`,
// which is where the FSM tests reach for it.

// Surface a mid-flight transition on queuepilot/state (what HA's status sensor shows).
// Lazy / soft: mqttd or the session may not have injected a publisher yet, in which case this
// is a no-op and the driver stays testable without MQTT.
let _publishState: PublishStateFn | null = null;
export function setPublishState(fn: PublishStateFn | null): void {
  _publishState = fn;
}

function publishAwait(awaiting: string): void {
  if (!_publishState) return;
  try { _publishState({ awaiting }); } catch { /* ignore */ }
}

// Is the Shield's Plex app the foreground activity right now? (ADB read, ~50ms.)
// PLEX_PKG is not re-exported from adb.js (only TITLE_ID is); hardcode the package.
const PLEX_PKG = 'com.plexapp.android';
async function plexForeground(): Promise<boolean> {
  const act = await Promise.resolve(adb.foregroundActivity());
  return Boolean(act && String(act).includes(PLEX_PKG));
}

// device_on + plex_foreground, retried. Non-fatal: ensurePlexOpen never force-stops, and
// a play still tries even if ADB can't confirm Plex came up (HA may have launched it).
async function ensurePlex(attempts = 2): Promise<boolean> {
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
export function companionAddr(device: Device | null | undefined): [string, number] {
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
export function isConnRefused(result: { error?: string } | null | undefined): boolean {
  const err = String((result && result.error) || '').toLowerCase();
  return (
    err.includes('connection refused')
    || err.includes('econnrefused')
    || err.includes('errno 111')
    || err.includes('urlopen error')
  );
}

// Is the Shield already signed into `required`, per an OBSERVED LAST_SEEN? Alias-aware.
// The one place the skip decision is made, so the picker is never walked when a cheap,
// alias-resolved read of the last-seen profile already proves we're on the right one.
//
// `isObserved` is load-bearing, not defensive. This used to read `LAST_SEEN.title` alone —
// but `driveProfile()` below WRITES that field itself on a switch it never verified, so the
// skip was a cache confirming its own last guess. Once the guess was wrong it stayed wrong,
// silently, on every later play: "already signed in; no picker walk" against a Shield that
// was signed in as somebody else. Only a profile the PMS log actually SAW may skip the walk.
// (docs/decisions/2026-08-21-the-profile-gate-verifies-the-account-plex-is-playing-as.md)
async function onRequired(required: string): Promise<boolean> {
  const seen = profiles.LAST_SEEN.title;
  if (!seen || !profiles.LAST_SEEN.isObserved) return false;
  return Boolean(await Promise.resolve(adb.sameProfile(seen, required)));
}

// signed_in(required). Returns null on success, or a terminal result (cancelled / error).
//
// NON-DESTRUCTIVE fast path: if the Shield is already signed into `required`
// (profiles.LAST_SEEN, alias-aware via adb.sameProfile), this is a no-op — it never walks
// the picker. Only when a real change is needed does it drive adb.switchTo, bounded-retried.
// A successful switch RECORDS `required` into LAST_SEEN so the next gated scan skips.
async function driveProfile(
  required: string,
  cancel: CancelFlag | null,
): Promise<PushResult | null> {
  if (await onRequired(required)) {
    console.log(
      `[driver] already signed in as '${profiles.LAST_SEEN.title}' `
      + `(== '${required}'); no picker walk`,
    );
    return null;
  }

  publishAwait(`profile:${required}`);

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
    // adb.js: switchTo(target, cancel = null, knownCurrent = null) → [ok, detail].
    // Deliberately typed `unknown`: the tuple is what the real module returns, but this
    // module is also run against e2e/stubs/adb.stub.mjs, and the object/scalar branches
    // below are the port's defensive handling of a stub that answers differently. Narrowing
    // `out` to the tuple would delete them.
    let out: unknown;
    try {
      out = await adb.switchTo(required, cancel, profiles.LAST_SEEN.title);
    } catch (e) {
      out = [false, errMessage(e)];
    }
    let ok: boolean;
    let detail: unknown;
    if (Array.isArray(out)) {
      [ok, detail] = out as [boolean, unknown];
    } else if (out && typeof out === 'object' && 'ok' in out) {
      ok = Boolean((out as { ok?: unknown }).ok);
      detail = (out as { detail?: unknown }).detail;
    } else {
      ok = Boolean(out);
      detail = out;
    }
    if (ok) {
      console.log(`[driver] switched to '${required}': ${detail}`);
      // A CLAIM, not an observation: adb.switchTo confirms the right tile was highlighted
      // when CENTER was pressed, never that Plex signed in. Recorded as the picker HINT for
      // the next walk (it saves a ~1.9s dump) and deliberately NOT marked observed, so it
      // cannot satisfy onRequired() and skip the walk on a later play.
      profiles.LAST_SEEN.title = required;
      profiles.LAST_SEEN.isObserved = false;
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
async function drivePlay(
  ratingKeys: (string | number)[] | null | undefined,
  setName: string | null,
  device: Device | null,
  offset: number,
  cancel: CancelFlag | null,
  userUuid: string | null = null,
): Promise<PlaybackResult | PushResult> {
  const mode = (device && device.mode) || PLAYBACK_MODE;
  if (mode !== 'client') {
    return playback.playRatingKeys(ratingKeys, {
      setName, device, offset, userUuid,
    });
  }

  const [host, port] = companionAddr(device);
  const attempts = Math.max(1, PLAYBACK_FSM_PLAY_ATTEMPTS);
  let result: PlaybackResult | null = null;
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
    result = await playback.playRatingKeys(ratingKeys, {
      setName, device, offset, userUuid,
    });
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
// Signature: driveToPlaying({ ratingKeys, requiredProfile, offset, device, setName, cancel,
// setLabel, userUuid }). It used to lead with an mqtt `client`, which every caller passed as
// null and which existed only to be forwarded to the state publisher that does not take one.
//
// `userUuid` is the ACTIVE binding's managed-user uuid — the account the playQueue must be
// built as. It is passed through untouched; playback.playToken explains why the set's
// top-level user_uuid cannot be trusted for a multi-profile channel.
export async function driveToPlaying({
  ratingKeys,
  requiredProfile = null,
  offset = 0,
  device = null,
  setName = null,
  cancel = null,
  setLabel = null,
  userUuid = null,
  accountId = null,
}: {
  ratingKeys?: (string | number)[];
  requiredProfile?: string | null;
  offset?: number;
  device?: Device | null;
  setName?: string | null;
  cancel?: CancelFlag | null;
  setLabel?: string | null;
  userUuid?: string | null;
  /** The bound account (`binding.account_id`) the audit below holds playback to. */
  accountId?: number | null;
} = {}): Promise<PlaybackResult | PushResult> {
  if (isCancelled(cancel)) return { cancelled: true };

  // unreachable -> device_on -> plex_foreground. Best-effort head start (the play step
  // re-verifies foreground itself); ADB off/unreachable falls back to whatever HA launched.
  if (ADB_ENABLED) await ensurePlex();

  // plex_foreground -> signed_in(required). Only when the set/card demands a profile.
  if (requiredProfile) {
    const r = await driveProfile(requiredProfile, cancel);
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
  const result = await drivePlay(ratingKeys, setName, device, offset, cancel, userUuid);

  // playing(target) -> playing(target) AS THE RIGHT ACCOUNT.
  //
  // Everything above this line is the gate PROMISING the right profile; this is the only step
  // that CHECKS it. `adb.switchTo` reports success on the CENTER keypress and cannot see
  // whether Plex acted on it, so until a session exists there is nothing to read — which is
  // why the audit runs here, after play, and stops a mismatch instead of preventing it.
  //
  // Only a POSITIVE mismatch is terminal. `verifyAccount` abstains when it cannot tell (no
  // session surfaced in time, Plex unreachable), because failing a play that is probably fine
  // is worse than an audit that occasionally has no opinion.
  if (result && (result as PlaybackResult).played && accountId != null) {
    if (isCancelled(cancel)) return { cancelled: true };
    const verdict = await playback.verifyAccount(accountId, { device });
    if (verdict.isMismatch) {
      console.log(
        `[driver] WRONG ACCOUNT: '${setLabel || setName}' is bound to account ${accountId} `
        + `but the Shield is playing as ${verdict.accountId} ('${verdict.title}'); stopping`,
      );
      await playback.stopPlayback(device);
      return {
        error: ACCOUNT_ERROR
          .replace('{label}', setLabel || setName || '')
          .replace('{profile}', requiredProfile || String(accountId))
          .replace('{actual}', verdict.title || String(verdict.accountId)),
        _diag: result,
      };
    }
    if (verdict.accountId == null) {
      console.log(`[driver] account audit had no opinion: ${verdict.reason}`);
    } else {
      console.log(`[driver] account audit OK: playing as ${verdict.accountId} ('${verdict.title}')`);
    }
  }
  return result;
}

// Exported for unit tests (parity with e2e/playback-fsm-test.py scenarios).
export const _internals = {
  SWITCH_ERROR,
  PLAY_ERROR,
  ACCOUNT_ERROR,
  plexForeground,
  ensurePlex,
  onRequired,
  driveProfile,
  drivePlay,
  isCancelled,
  publishAwait,
};
