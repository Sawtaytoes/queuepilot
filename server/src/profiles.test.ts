// `LAST_SEEN`'s provenance and its EXPIRY, against the real module.
//
// decision 2026-10-12-a-profile-observation-expires-and-a-gated-push-is-audited.
//
// ⚠️ WHY THIS EXISTS SEPARATELY FROM THE E2E SUITES. `e2e/stubs/profiles.stub.mjs` MIRRORS this
// logic rather than importing it, because the driver's resolve hooks swap the whole module out.
// A mirror that drifts from the original is the silent false pass `e2e/stubs/module-id.mjs`
// documents at length: every FSM scenario would keep passing against a copy while production
// behaved differently. These cases pin the real functions, so a change here that the stub does
// not follow shows up as a disagreement between two suites instead of as nothing at all.
import { afterEach, describe, expect, it } from 'vitest';

import { PROFILE_OBSERVATION_TTL_SECONDS } from './env.js';
import {
  LAST_SEEN,
  _setNow,
  invalidateObservedProfile,
  isObservationFresh,
  observationAgeSeconds,
  recordObservedProfile,
  recordProfileClaim,
} from './profiles.js';

const START = 1_800_000_000_000; // epoch MILLISECONDS
let clock = START;

const at = (ms: number): void => { clock = ms; };

afterEach(() => {
  _setNow();
  LAST_SEEN.title = null;
  LAST_SEEN.isObserved = false;
  LAST_SEEN.observedAt = null;
});

const withClock = (): void => { _setNow(() => clock); };

describe('a profile observation', () => {
  it('is fresh when just recorded, and stale once past the TTL', () => {
    withClock();
    at(START);
    recordObservedProfile('Younger Kids');

    expect(LAST_SEEN).toMatchObject({ title: 'Younger Kids', isObserved: true });
    expect(LAST_SEEN.observedAt).toBe(START);
    expect(isObservationFresh()).toBe(true);
    expect(observationAgeSeconds()).toBe(0);

    // Exactly on the boundary still counts — the comparison is inclusive, so a TTL of 600
    // means "up to and including 600 s" rather than an off-by-one nobody can see.
    at(START + PROFILE_OBSERVATION_TTL_SECONDS * 1000);
    expect(isObservationFresh()).toBe(true);

    at(START + PROFILE_OBSERVATION_TTL_SECONDS * 1000 + 1);
    expect(isObservationFresh()).toBe(false);
    // The TITLE survives: it is still the picker's navigation hint, it just cannot clear a
    // gate. Losing it would make the next walk start from an unknown position.
    expect(LAST_SEEN.title).toBe('Younger Kids');
    expect(LAST_SEEN.isObserved).toBe(true);
  });

  // THE 2026-09-12 SHAPE. A correct, matching, two-hour-old observation must not clear a gate.
  it('does not clear a gate two hours later', () => {
    withClock();
    at(START);
    recordObservedProfile('Younger Kids');

    at(START + 2 * 60 * 60 * 1000);
    expect(isObservationFresh()).toBe(false);
    expect(observationAgeSeconds()).toBe(7200);
  });

  it('is never fresh when it came from an ADB claim', () => {
    withClock();
    at(START);
    recordProfileClaim('Younger Kids');

    expect(LAST_SEEN).toMatchObject({
      title: 'Younger Kids', isObserved: false, observedAt: null,
    });
    // A claim cannot become fresh by being recent — it carries no time at all, so there is
    // nothing for the TTL to measure and nothing to accidentally pass it.
    expect(isObservationFresh()).toBe(false);
    expect(observationAgeSeconds()).toBeNull();
  });

  it('is not fresh with no observation at all', () => {
    expect(isObservationFresh()).toBe(false);
    expect(observationAgeSeconds()).toBeNull();
  });

  it('loses both its authority and its timestamp when invalidated', () => {
    withClock();
    at(START);
    recordObservedProfile('Younger Kids');
    invalidateObservedProfile();

    expect(LAST_SEEN.title).toBe('Younger Kids'); // still the hint
    expect(LAST_SEEN.isObserved).toBe(false);
    expect(LAST_SEEN.observedAt).toBeNull();
    expect(isObservationFresh()).toBe(false);
  });

  it('re-recording refreshes the stamp', () => {
    withClock();
    at(START);
    recordObservedProfile('Younger Kids');

    at(START + 2 * 60 * 60 * 1000);
    expect(isObservationFresh()).toBe(false);

    // A later play's audit observed the same profile again. That is new evidence, not the old
    // evidence restated, so the window restarts.
    recordObservedProfile('Younger Kids');
    expect(isObservationFresh()).toBe(true);
    expect(observationAgeSeconds()).toBe(0);
  });

  // A clock that goes backwards (NTP step, container clock skew) must not read as a future
  // observation that never expires.
  it('treats a backwards clock as age zero rather than as negative age', () => {
    withClock();
    at(START);
    recordObservedProfile('Younger Kids');

    at(START - 60_000);
    expect(observationAgeSeconds()).toBe(0);
    expect(isObservationFresh()).toBe(true);
  });
});
