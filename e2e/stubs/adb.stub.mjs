// Stand-in for server/src/adb.js when a test hooks it into server/src/driver.js.
// Behaviour is scripted through e2e/stubs/control.mjs (CTL); every call is recorded so the
// test can assert ordering and counts — the Node twin of the Python FSM test's adb stubs.
import { CTL, record } from './control.mjs';

export function foregroundActivity() {
  record('foreground_activity');
  return CTL.foreground;
}

export async function ensurePlexOpen() {
  record('ensure_plex_open');
  // Opening Plex foregrounds it and brings the Companion port up — same as the real thing.
  CTL.foreground = 'com.plexapp.android/.HomeActivityTV';
  CTL.companionUp = true;
  return true;
}

export async function sameProfile(a, b) {
  record('same_profile', a, b);
  const override = CTL.same.get(`${a}|${b}`);
  if (override !== undefined) return override;
  return a === b;
}

export async function switchTo(target, cancel = null, knownCurrent = null) {
  record('switch_to', target, knownCurrent);
  if (CTL.onSwitch) CTL.onSwitch(target, cancel, knownCurrent);
  return CTL.switchResult;
}

// Unused by driver.js but exported so the namespace shape matches the real module.
export function isAwake() { return CTL.awake; }
export function connect() { return true; }
export async function press() { return true; }
export const TITLE_ID = 'com.plexapp.android:id/title_text';
