// Shared control surface for the driver's stubbed primitives (e2e/stubs/*.stub.mjs).
//
// server/src/driver.js imports adb/playback/profiles as ESM namespaces, which are frozen —
// a test can't monkeypatch them the way e2e/playback-fsm-test.py patched the Python modules.
// So the tests install `node:module` resolve hooks that swap those three specifiers for the
// stubs next to this file, and the stubs read their scripted behaviour from THIS mutable
// object. `reset()` restores the baseline between scenarios (the Python test's `Env` class).
export const CTL = {
  calls: [],
  foreground: '',
  onboarding: false,
  companionUp: true,
  switchResult: [true, 'selected on the picker'],
  same: new Map(), // "a|b" -> bool override for sameProfile
  playResults: [],
  // Mirrors profiles.LAST_SEEN, provenance included: `isObserved` marks a title the PMS
  // log actually SAW, as opposed to one driveProfile claimed after an unverified switch.
  // Only an observation may satisfy a gate — see the bug2 scenarios in fsm-wake-and-skip.
  //
  // `observedAt` carries the same force. An observation only clears a gate while it is
  // FRESH, so a scenario that wants the skip must stamp a time as well as the flag;
  // `observe()` below does both and is what a test should call.
  lastSeen: { title: null, isObserved: false, observedAt: null },
  // Seconds an observation may clear a gate for. Mirrors PROFILE_OBSERVATION_TTL_SECONDS.
  observationTtlSeconds: 600,
  awake: true,
  onSwitch: null, // optional hook fired inside switchTo (cancel-mid-flight scenarios)
  // What playback.verifyAccount() should answer; null = 'the account matches'.
  accountVerdict: null,
  // A SCRIPT of verdicts, one per verifyAccount() call (the last one repeats). Takes
  // precedence over `accountVerdict` when non-empty — for the no-session-then-session
  // scenarios that drive the play retry.
  accountVerdicts: [],
  // Rows the driver appended to the gated-push log, in order. The attribution audit reads
  // that log, so a scenario can prove the row was written even when the live account check
  // had no opinion — which is the case the audit exists to cover.
  gatedPushes: [],
  // What the one-shot pre-switch `/status/sessions` read should answer. Null means the
  // target has no active session, so the driver falls back to LAST_SEEN or the picker.
  accountObservation: null,
};

export function reset() {
  CTL.calls = [];
  CTL.foreground = 'com.plexapp.android/.PlayerActivity'; // Plex up by default
  CTL.onboarding = false;
  CTL.companionUp = true;
  CTL.switchResult = [true, 'selected on the picker'];
  CTL.same = new Map();
  CTL.playResults = [{ queued: 1, played: true, mode: 'client', client: 'SHIELD' }];
  CTL.lastSeen.title = null;
  CTL.lastSeen.isObserved = false;
  CTL.lastSeen.observedAt = null;
  CTL.observationTtlSeconds = 600;
  CTL.awake = true;
  CTL.onSwitch = null;
  CTL.accountVerdict = null;
  CTL.accountVerdicts = [];
  CTL.accountObservation = null;
  CTL.gatedPushes = [];
}

/**
 * Put a FRESH observation of `title` in place — the state a scenario needs when it wants the
 * picker walk skipped. Pass `ageSeconds` to age it instead, which is how the staleness
 * scenarios set up an observation that must no longer clear the gate.
 */
export function observe(title, ageSeconds = 0) {
  CTL.lastSeen.title = title;
  CTL.lastSeen.isObserved = true;
  CTL.lastSeen.observedAt = Date.now() - ageSeconds * 1000;
}

export const record = (...call) => CTL.calls.push(call);
export const nCalls = (name) => CTL.calls.filter((c) => c[0] === name).length;
export const firstIndex = (name) => CTL.calls.findIndex((c) => c[0] === name);

reset();
