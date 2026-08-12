// Stand-in for server/src/profiles.js under the driver's unit tests (see control.mjs).
// LAST_SEEN is the SAME object the test mutates, so the driver's writes are observable.
import { CTL, record } from './control.mjs';

export const LAST_SEEN = CTL.lastSeen;

export async function waitForProfile({ match = null } = {}) {
  record('wait_for_profile', match);
  return match; // signed in as requested, by default
}

export function setForProfile() { return null; }
