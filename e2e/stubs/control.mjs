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
  companionUp: true,
  switchResult: [true, 'selected on the picker'],
  same: new Map(), // "a|b" -> bool override for sameProfile
  playResults: [],
  lastSeen: { title: null }, // mirrors profiles.LAST_SEEN for the stub
  awake: true,
  onSwitch: null, // optional hook fired inside switchTo (cancel-mid-flight scenarios)
};

export function reset() {
  CTL.calls = [];
  CTL.foreground = 'com.plexapp.android/.PlayerActivity'; // Plex up by default
  CTL.companionUp = true;
  CTL.switchResult = [true, 'selected on the picker'];
  CTL.same = new Map();
  CTL.playResults = [{ queued: 1, played: true, mode: 'client', client: 'SHIELD' }];
  CTL.lastSeen.title = null;
  CTL.awake = true;
  CTL.onSwitch = null;
}

export const record = (...call) => CTL.calls.push(call);
export const nCalls = (name) => CTL.calls.filter((c) => c[0] === name).length;
export const firstIndex = (name) => CTL.calls.findIndex((c) => c[0] === name);

reset();
