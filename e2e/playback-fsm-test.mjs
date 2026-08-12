// Unit tests for the playback state machine (server/src/driver.js). No Plex, no MQTT, no ADB,
// no network — adb / playback / profiles are swapped for e2e/stubs/* via module resolve hooks,
// so this drives driveToPlaying directly and asserts the VERIFIED, RETRIED, NON-DESTRUCTIVE
// transitions the design doc promises.
//
// Node port of the retired e2e/playback-fsm-test.py (deleted with queue_builder/ on
// 2026-08-12); the scenarios and their assertions are carried over 1:1:
//   (a) already on the right profile + Plex open  -> NO picker walk, plays once
//   (b) Plex closed                               -> launches then plays
//   (c) Companion refused once (Errno 111)        -> re-open + retry -> plays
//   (d) a real profile change is needed           -> switch then play
//   (e) cancel mid-flight                         -> aborts cleanly, never plays
//   (f) a transition's bounded retries exhaust    -> single spoken-sentence error
//
// Run:  node e2e/playback-fsm-test.mjs     (from the repo root; exits non-zero on failure)

// env.js reads process.env at module-eval, so these must precede the driver import.
process.env.PLAYBACK_MODE = 'client';
process.env.ADB_ENABLED = 'true';
process.env.SHIELD_IP = '192.0.2.30';
process.env.COMPANION_PORT = '32500';
process.env.SHIELD_CLIENT_URI = '';
process.env.PLAYBACK_FSM_PLAY_ATTEMPTS = '3';
process.env.PLAYBACK_FSM_SWITCH_ATTEMPTS = '2';
process.env.PLAYBACK_FSM_RETRY_BACKOFF = '0'; // no real sleeps in tests

import { stubDriverDeps } from './stubs/hooks.mjs';

stubDriverDeps();
const { CTL, reset, nCalls, firstIndex } = await import('./stubs/control.mjs');
const driver = await import('../server/src/driver.js');

const FAILS = [];
function ok(name, cond, detail = '') {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

// A cancel flag shaped like the one session.js passes (isSet()).
function cancelFlag() {
  let set = false;
  return { set: () => { set = true; }, isSet: () => set };
}

const drive = (kw = {}) => driver.driveToPlaying(null, {
  ratingKeys: ['100'],
  requiredProfile: null,
  offset: 0,
  device: { mode: 'client' },
  setName: 'demo',
  cancel: null,
  ...kw,
});

// --------------------------------------------------------------------------- //
// (a) Already on the right profile + Plex open -> NO picker walk, plays once
// --------------------------------------------------------------------------- //
reset();
CTL.lastSeen.title = 'Younger Kids';
let res = await drive({ requiredProfile: 'Younger Kids' });
ok('(a) already-on-profile: plays and reports played', res.played === true);
ok('(a) already-on-profile: NEVER walks the picker (no switchTo)', nCalls('switch_to') === 0);
ok('(a) already-on-profile: plays exactly once', nCalls('play') === 1);

// --------------------------------------------------------------------------- //
// (b) Plex closed -> launches (ensurePlexOpen) then plays
// --------------------------------------------------------------------------- //
reset();
CTL.foreground = 'com.google.android.tvlauncher/.MainActivity'; // Plex closed
CTL.companionUp = false; // ... and the Companion port is down until Plex opens
res = await drive();
ok('(b) plex-closed: opens Plex before playing', nCalls('ensure_plex_open') >= 1);
ok('(b) plex-closed: play still succeeds', res.played === true);

// --------------------------------------------------------------------------- //
// (c) Companion refused once (Errno 111) -> re-open + retry -> plays
// --------------------------------------------------------------------------- //
const REFUSED = {
  queued: 1, played: false, mode: 'client', client: 'SHIELD',
  error: 'URLError: <urlopen error [Errno 111] Connection refused>',
};
const PLAYED = { queued: 1, played: true, mode: 'client', client: 'SHIELD' };
reset();
CTL.playResults = [REFUSED, PLAYED];
res = await drive();
ok('(c) companion-refused: retries and eventually plays', res.played === true);
ok('(c) companion-refused: play was attempted twice', nCalls('play') === 2);
ok('(c) companion-refused: re-opened Plex between attempts', nCalls('ensure_plex_open') >= 1);

// --------------------------------------------------------------------------- //
// (d) A real profile change is needed -> switch then play
// --------------------------------------------------------------------------- //
reset();
CTL.lastSeen.title = 'Younger Kids';          // signed in as the WRONG profile
CTL.same.set('Younger Kids|Demo', false);     // not the same slot -> a real change
res = await drive({ requiredProfile: 'Demo' });
ok('(d) profile-change: drives the picker exactly once', nCalls('switch_to') === 1);
ok('(d) profile-change: switch happens BEFORE play', firstIndex('switch_to') < firstIndex('play'));
ok('(d) profile-change: plays after the switch settles', res.played === true);

// --------------------------------------------------------------------------- //
// (e) Cancel mid-flight -> aborts cleanly, never plays
// --------------------------------------------------------------------------- //
reset();
let cancel = cancelFlag();
cancel.set(); // a newer scan already cancelled this one before it started driving
res = await drive({ cancel });
ok('(e) cancel: returns cancelled', res.cancelled === true);
ok('(e) cancel: never fires play', nCalls('play') === 0);

// Cancel that lands DURING the switch retries (switch keeps failing; cancel set mid-switch).
reset();
CTL.lastSeen.title = 'Younger Kids';
CTL.same.set('Younger Kids|Demo', false);
CTL.switchResult = [false, 'ran out of time'];
cancel = cancelFlag();
CTL.onSwitch = () => cancel.set(); // a newer scan arrives mid-switch
res = await drive({ requiredProfile: 'Demo', cancel });
ok('(e) cancel mid-switch: aborts cleanly', res.cancelled === true);
ok('(e) cancel mid-switch: never fires play', nCalls('play') === 0);

// --------------------------------------------------------------------------- //
// (f) A transition's bounded retries exhaust -> ONE spoken-sentence error
// --------------------------------------------------------------------------- //
// f1: the switch never lands -> the profile-gate spoken sentence, set label filled in.
reset();
CTL.lastSeen.title = 'Younger Kids';
CTL.same.set('Younger Kids|Demo', false);
CTL.switchResult = [false, 'ran out of time after 12 presses'];
res = await drive({ requiredProfile: 'Demo', setLabel: 'Demo Reel' });
ok('(f) switch-exhausted: returns an error, not a crash', Boolean(res.error));
ok(
  '(f) switch-exhausted: spoken sentence names the profile + set, ends with an instruction',
  res.error === "'Demo Reel' needs the 'Demo' Plex profile, and the Shield did not "
    + 'switch to it. Pick it on the TV.',
  res.error,
);
ok('(f) switch-exhausted: NEVER plays after a failed gate', nCalls('play') === 0);
ok('(f) switch-exhausted: honored the bounded switch attempts (2)', nCalls('switch_to') === 2);
ok(
  '(f) switch-exhausted: no diagnostic jargon in the spoken sentence',
  !String(res.error).includes('presses') && !String(res.error).toLowerCase().includes('timeout'),
);

// f2: the Companion stays refused for every attempt -> the play spoken sentence.
reset();
CTL.playResults = [REFUSED]; // always refused
res = await drive();
ok(
  '(f) play-exhausted: returns the spoken play error',
  res.error === "Plex wasn't ready to play on the Shield. Try the card again.",
  res.error,
);
ok('(f) play-exhausted: tried the bounded number of times (3)', nCalls('play') === 3);

// --------------------------------------------------------------------------- //
// Extra: cast mode skips the Companion-refusal loop entirely (it's :32500-specific).
// --------------------------------------------------------------------------- //
reset();
res = await drive({ device: { mode: 'cast' } });
ok('cast mode: plays once, no Companion probe', res.played === true && nCalls('companion_ready') === 0);

// Extra: a non-connection play error (HTTP) is surfaced as-is, not retried (Plex answered).
reset();
CTL.playResults = [{ queued: 1, played: false, mode: 'client', error: 'playMedia HTTP 500' }];
res = await drive();
ok('http error: surfaced as-is (not a spoken retry error)', res.error === 'playMedia HTTP 500');
ok('http error: not retried (Plex answered)', nCalls('play') === 1);

// The offset the caller passes must reach playRatingKeys unchanged (resume-in-queue's tail).
reset();
await drive({ offset: 90_000 });
ok('offset is threaded to playRatingKeys', CTL.calls.find((c) => c[0] === 'play')[2] === 90_000);

console.log(FAILS.length ? `\nFAILURES: ${FAILS.length}` : '\ndone');
process.exit(FAILS.length ? 1 : 0);
