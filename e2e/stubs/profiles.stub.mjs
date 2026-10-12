// Stand-in for server/src/profiles.js under the driver's unit tests (see control.mjs).
// LAST_SEEN is the SAME object the test mutates, so the driver's writes are observable.
import { CTL, record } from './control.mjs';

export const LAST_SEEN = CTL.lastSeen;

export function recordObservedProfile(title) {
  LAST_SEEN.title = title;
  LAST_SEEN.isObserved = true;
  LAST_SEEN.observedAt = Date.now();
}

export function recordProfileClaim(title) {
  LAST_SEEN.title = title;
  LAST_SEEN.isObserved = false;
  LAST_SEEN.observedAt = null;
}

export function invalidateObservedProfile() {
  LAST_SEEN.isObserved = false;
  LAST_SEEN.observedAt = null;
}

// A faithful mirror of the real rule, not a permissive stand-in: a scenario that wants the
// skip must stamp a time (CTL.observe does), and one that wants the walk can age it.
export function isObservationFresh() {
  if (!LAST_SEEN.isObserved || LAST_SEEN.observedAt == null) return false;
  if (CTL.observationTtlSeconds <= 0) return false;
  return Date.now() - LAST_SEEN.observedAt <= CTL.observationTtlSeconds * 1000;
}

export function observationAgeSeconds() {
  if (LAST_SEEN.observedAt == null) return null;
  return Math.max(0, Math.round((Date.now() - LAST_SEEN.observedAt) / 1000));
}

export async function waitForProfile({ match = null } = {}) {
  record('wait_for_profile', match);
  return match; // signed in as requested, by default
}

export function setForProfile() { return null; }
