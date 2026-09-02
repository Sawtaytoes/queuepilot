// THE SECTION WINDOW — `start.position_ms` and `end.position_ms`, the two keys that say where
// inside the first played unit playback begins and where it stops (decision
// `2026-09-01-a-start-point-carries-a-position-and-end-is-its-mirror`).
//
// This file pins the two NORMALIZERS, which are pure and are where the sparse rule lives. The
// pair rule ("end strictly after start") needs both sides of one entry on disk and belongs to
// the writers, so it is pinned against a real file in `e2e/yaml-roundtrip-test.ts`.
import { describe, expect, it } from 'vitest';

import { hasSection, toPositionMs } from './entryFormat.js';
import { normalizeEnd, normalizeStart } from './queues.js';

describe('a position off the wire', () => {
  it('accepts a number, a numeric string and zero', () => {
    expect(toPositionMs(3_660_000)).toBe(3_660_000);
    expect(toPositionMs('3660000')).toBe(3_660_000);
    // Zero is a REAL value — "begin at the very start" is the other half of an end-only
    // window — so every caller tests `!= null` rather than truthiness.
    expect(toPositionMs(0)).toBe(0);
  });

  it('rounds a fractional millisecond rather than keeping it', () => {
    expect(toPositionMs(1000.4)).toBe(1000);
    expect(toPositionMs(1000.6)).toBe(1001);
  });

  it('reads every unusable spelling as NO position', () => {
    for (const junk of [
      undefined, null, '', '   ', 'twelve thirty', NaN, Infinity, -1, -0.4,
      true, false, {}, [], [1000],
    ]) {
      expect(toPositionMs(junk)).toBeNull();
    }
  });
});

describe('normalizeStart carries a position', () => {
  it('takes a position beside the unit it picked', () => {
    expect(normalizeStart({ season: 2, episode: 4, position_ms: 750_000 })).toEqual({
      season: 2, episode: 4, position_ms: 750_000,
    });
  });

  // THE TRAP. The guard used to read `!hasSeries && src.episode == null`, which was right
  // while a start could only pick a unit. A film section has NEITHER a series NOR an episode —
  // only a position — so that guard discarded every one of them and returned null, silently.
  it('accepts a MOVIE section: a position with no series and no episode', () => {
    expect(normalizeStart({ position_ms: 3_660_000 })).toEqual({ position_ms: 3_660_000 });
    expect(normalizeStart({ position_ms: 0 })).toEqual({ position_ms: 0 });
  });

  it('still picks a unit with no position at all', () => {
    expect(normalizeStart({ season: 1, episode: 3 })).toEqual({ season: 1, episode: 3 });
    expect(normalizeStart({ series: '4242' })).toEqual({ series: '4242' });
  });

  it('drops a junk position and keeps the rest of the start', () => {
    expect(normalizeStart({ season: 1, episode: 3, position_ms: 'soon' }))
      .toEqual({ season: 1, episode: 3 });
    expect(normalizeStart({ season: 1, episode: 3, position_ms: -5 }))
      .toEqual({ season: 1, episode: 3 });
    expect(normalizeStart({ season: 1, episode: 3, position_ms: null }))
      .toEqual({ season: 1, episode: 3 });
  });

  it('is NULL, never an empty mapping, when nothing usable is left', () => {
    expect(normalizeStart({ position_ms: 'soon' })).toBeNull();
    expect(normalizeStart({ position_ms: -1 })).toBeNull();
    expect(normalizeStart({})).toBeNull();
    expect(normalizeStart(null)).toBeNull();
    expect(normalizeStart('12:30')).toBeNull();
  });
});

describe('normalizeEnd mirrors it', () => {
  it('keeps a usable position and nothing else', () => {
    expect(normalizeEnd({ position_ms: 3_960_000 })).toEqual({ position_ms: 3_960_000 });
    expect(normalizeEnd({ position_ms: '3960000' })).toEqual({ position_ms: 3_960_000 });
    // A key `end` has never carried is not preserved: unlike the entry's own extras bag,
    // this mapping is rebuilt from what the normalizer understands.
    expect(normalizeEnd({ position_ms: 10, season: 2 })).toEqual({ position_ms: 10 });
  });

  it('is NULL, never an empty mapping, without a usable position', () => {
    for (const junk of [null, undefined, {}, { position_ms: null }, { position_ms: '' },
      { position_ms: -1 }, { position_ms: 'later' }, 'later', 4]) {
      expect(normalizeEnd(junk)).toBeNull();
    }
  });
});

// The four states from the decision record. Each is a SHAPE the normalizers must produce, and
// all four are valid — there is no mode flag telling them apart.
describe('the four optionality states', () => {
  it('neither: today’s behaviour, both keys absent', () => {
    expect(normalizeStart({ season: 1, episode: 1 })?.position_ms).toBeUndefined();
    expect(normalizeEnd(undefined)).toBeNull();
  });

  it('start only: from that offset to the end of the unit', () => {
    expect(normalizeStart({ position_ms: 750_000 })).toEqual({ position_ms: 750_000 });
    expect(normalizeEnd(null)).toBeNull();
  });

  it('end only: from the beginning of the unit, stopping at that offset', () => {
    expect(normalizeStart(null)).toBeNull();
    expect(normalizeEnd({ position_ms: 1_020_000 })).toEqual({ position_ms: 1_020_000 });
  });

  it('both: the window between them', () => {
    expect(normalizeStart({ position_ms: 3_660_000 })).toEqual({ position_ms: 3_660_000 });
    expect(normalizeEnd({ position_ms: 3_960_000 })).toEqual({ position_ms: 3_960_000 });
  });
});

// `hasSection` decides whether an add is DELIBERATE — it ran a day ahead of these fields, so
// the two have to be checked against each other rather than assumed to agree.
describe('hasSection agrees with the normalizers', () => {
  const cases: unknown[] = [
    { start: { position_ms: 1000 } },
    { end: { position_ms: 0 } },
    { start: { season: 2, episode: 4 } },
    { start: { season: 2, episode: 4, position_ms: 750_000 } },
    { start: { position_ms: null } },
    { start: { position_ms: '' } },
    { start: { position_ms: -1 } },
    { start: null, end: null },
    {},
  ];

  it('answers true exactly when a normalizer keeps a position', () => {
    for (const value of cases) {
      const m = value as { start?: unknown; end?: unknown };
      const normalized = normalizeStart(m.start)?.position_ms != null
        || normalizeEnd(m.end)?.position_ms != null;
      expect([value, hasSection(value)]).toEqual([value, normalized]);
    }
  });

  // The two that used to disagree, named. `Number(null)` is 0 and `Number('')` is 0, so the
  // first draft of the predicate called a CLEARED window a section — it would have minted an
  // id and walked an add past the duplicate guard while the writer dropped the key.
  it('reads a cleared position as no section, not as a section at 0', () => {
    expect(hasSection({ start: { position_ms: null } })).toBe(false);
    expect(hasSection({ end: { position_ms: '' } })).toBe(false);
    expect(hasSection({ end: { position_ms: 0 } })).toBe(true);
  });
});
