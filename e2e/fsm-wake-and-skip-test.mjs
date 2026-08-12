// Unit tests for two FSM bugs found on the real Shield. No Plex, no MQTT, no ADB, no network.
//
// Node port of the retired e2e/fsm-wake-and-skip-test.py (deleted with queue_builder/ on
// 2026-08-12), asserting the same two fixes against server/src/adb.js + server/src/driver.js:
//
// Bug 1 — dozing Shield not woken before launch. `am start plex://` on a sleeping device does
//         NOT foreground Plex — the launch queues behind the dream. FIX: wake FIRST when the
//         Shield isn't awake (or the foreground is unknown), then launch. Driven through the
//         REAL adb.js with node:child_process scripted (e2e/stubs/child-process.stub.mjs), so
//         the wake→launch ORDER is observed, not assumed.
//
// Bug 2 — picker walked even when already on the required profile. driveProfile's
//         "already on required -> skip" needs profiles.LAST_SEEN populated and alias-aware
//         matching; a successful switch must RECORD the profile so the next scan skips.
//
// Run:  node e2e/fsm-wake-and-skip-test.mjs   (from the repo root; exits non-zero on failure)

process.env.ADB_ENABLED = 'true';
process.env.ADB_PLEX_LAUNCH_WAIT_SECONDS = '1'; // bound the post-launch poll in tests
process.env.PLAYBACK_FSM_SWITCH_ATTEMPTS = '2';
process.env.PLAYBACK_FSM_RETRY_BACKOFF = '0';

import { stubAdbShell, stubDriverDeps } from './stubs/hooks.mjs';

stubAdbShell();
stubDriverDeps();
const { ADB_SCRIPT, resetScript } = await import('./stubs/child-process.stub.mjs');
const { CTL, reset } = await import('./stubs/control.mjs');
const adb = await import('../server/src/adb.js'); // REAL module, faked shell
const driver = await import('../server/src/driver.js'); // stubbed adb/playback/profiles

const FAILS = [];
function ok(name, cond, detail = '') {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

// =========================================================================== //
// Bug 1 — ensurePlexOpen wakes a dozing Shield BEFORE launching Plex
// =========================================================================== //
const PLEX = 'com.plexapp.android/.HomeActivityTV';
const LAUNCHER = 'com.google.android.tvlauncher/.MainActivity';

// Asleep/dozing: foreground reads null, then null after the wake, then Plex once launched.
resetScript({ awake: false, foreground: [null, null, PLEX] });
let res = await adb.ensurePlexOpen();
ok('(bug1) asleep: WAKEUP is sent', ADB_SCRIPT.order.includes('wake'));
ok('(bug1) asleep: launch happens', ADB_SCRIPT.order.includes('launch'));
ok(
  '(bug1) asleep: WAKEUP is sent BEFORE the plex:// launch',
  ADB_SCRIPT.order.indexOf('wake') >= 0
    && ADB_SCRIPT.order.indexOf('wake') < ADB_SCRIPT.order.indexOf('launch'),
  JSON.stringify(ADB_SCRIPT.order),
);
ok('(bug1) asleep: ends foreground on Plex -> true', res === true);

// Wake alone brings Plex back (the screensaver was over Plex): no launch needed.
resetScript({ awake: false, foreground: [null, PLEX] });
res = await adb.ensurePlexOpen();
ok(
  '(bug1) asleep-over-plex: wakes and returns true without launching',
  ADB_SCRIPT.order.includes('wake') && !ADB_SCRIPT.order.includes('launch') && res === true,
  JSON.stringify(ADB_SCRIPT.order),
);

// Awake on the launcher: no needless WAKEUP, straight to launch.
resetScript({ awake: true, foreground: [LAUNCHER, PLEX] });
res = await adb.ensurePlexOpen();
ok('(bug1) awake-on-launcher: does NOT send a needless WAKEUP',
  !ADB_SCRIPT.order.includes('wake'), JSON.stringify(ADB_SCRIPT.order));
ok('(bug1) awake-on-launcher: launches and returns true',
  ADB_SCRIPT.order.includes('launch') && res === true);

// Already on Plex: returns immediately, no wake, no launch.
resetScript({ awake: true, foreground: [PLEX] });
res = await adb.ensurePlexOpen();
ok('(bug1) already-on-plex: no wake, no launch, true',
  ADB_SCRIPT.order.length === 0 && res === true, JSON.stringify(ADB_SCRIPT.order));

// =========================================================================== //
// Bug 2 — driveProfile skips the picker when already on `required` (alias-aware),
//         and records the confirmed profile so the NEXT scan skips too.
// =========================================================================== //
const { driveProfile } = driver._internals;

// Wire the stubbed adb.sameProfile with alias groups, and count switchTo calls.
function wireDriver(aliasGroups = [], switchOk = true) {
  reset();
  CTL.switchResult = [switchOk, switchOk ? 'selected on the picker' : 'ran out of time'];
  for (const group of aliasGroups) {
    for (const a of group) {
      for (const b of group) CTL.same.set(`${a}|${b}`, true);
    }
  }
}
const switches = () => CTL.calls.filter((c) => c[0] === 'switch_to');

// (a) LAST_SEEN == required exactly -> no picker walk.
wireDriver();
CTL.lastSeen.title = 'sawtaytoes';
let r = await driveProfile(null, 'sawtaytoes', null);
ok('(bug2a) exact LAST_SEEN==required: gate satisfied (null)', r === null);
ok('(bug2a) exact LAST_SEEN==required: NO switchTo call', switches().length === 0);

// (b) LAST_SEEN is the DISPLAY name, required the USERNAME — the alias must short-circuit.
wireDriver([['Bob Smith', 'sawtaytoes']]);
CTL.lastSeen.title = 'Bob Smith';
r = await driveProfile(null, 'sawtaytoes', null);
ok('(bug2b) display-name==username alias: gate satisfied (null)', r === null);
ok('(bug2b) display-name==username alias: NO picker/switch call', switches().length === 0);

// (c) A real change: LAST_SEEN cold (null) -> switch once, and LAST_SEEN is then RECORDED as
//     `required`, so an immediate second call short-circuits with no further switch.
wireDriver([['Bob Smith', 'sawtaytoes']], true);
CTL.lastSeen.title = null;
const r1 = await driveProfile(null, 'sawtaytoes', null);
ok('(bug2c) cold cache: switch runs once', r1 === null && switches().length === 1,
  JSON.stringify(switches()));
ok('(bug2c) switch records the profile into LAST_SEEN', CTL.lastSeen.title === 'sawtaytoes',
  String(CTL.lastSeen.title));
const r2 = await driveProfile(null, 'sawtaytoes', null);
ok('(bug2c) second gated scan short-circuits: still only ONE switch total',
  r2 === null && switches().length === 1, JSON.stringify(switches()));

// (d) Cold cache + a DIFFERENT signed-in profile -> a real switch is still driven.
wireDriver([['Bob Smith', 'sawtaytoes'], ['Younger Kids']]);
CTL.lastSeen.title = 'Younger Kids'; // signed in as someone else
r = await driveProfile(null, 'sawtaytoes', null);
ok('(bug2d) genuinely-wrong profile: drives the switch once',
  r === null && switches().length === 1, JSON.stringify(switches()));

console.log(FAILS.length ? `\nFAILURES: ${FAILS.length}` : '\ndone');
process.exit(FAILS.length ? 1 : 0);
