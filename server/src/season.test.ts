// The season window: a start date and an end date that repeat every year.
//
// What is pinned here is the RULE, not the plumbing — that the window is a second gate over
// `enabled` and never a writer of it, that it wraps the new year, and that it is a function of
// `now` rather than of a timer. The six consumers are pinned in `e2e/season-window-test.ts`.
import { describe, expect, it } from 'vitest';

import {
  formatSeasonDay,
  isInSeason,
  isSetAvailable,
  parseSeasonDay,
  seasonReturnLabel,
  seasonWindowOf,
} from './season.js';

/** A local-time date, because the window is a household calendar fact and `season.ts` reads
 *  `getMonth()`/`getDate()` rather than the UTC pair. */
const on = (month: number, day: number): Date => new Date(2026, month - 1, day, 12, 0, 0);

const halloween = { enabled: true, season_end: '11-05', season_start: '10-01' };
/** Crosses the new year — the case a naive `start <= today && today <= end` gets wrong by
 *  being false every day of its own season. */
const advent = { enabled: true, season_end: '01-06', season_start: '12-01' };

describe('parsing one MM-DD off the file', () => {
  it('reads the padded, unpadded and slashed spellings', () => {
    expect(parseSeasonDay('10-01')).toEqual({ day: 1, month: 10 });
    expect(parseSeasonDay('10-1')).toEqual({ day: 1, month: 10 });
    expect(parseSeasonDay('  10/01  ')).toEqual({ day: 1, month: 10 });
  });

  it('refuses a date that does not exist, and a month that is not one', () => {
    expect(parseSeasonDay('02-30')).toBeNull();
    expect(parseSeasonDay('13-01')).toBeNull();
    expect(parseSeasonDay('00-01')).toBeNull();
    expect(parseSeasonDay('10-00')).toBeNull();
  });

  it('allows 29 February, because the window repeats and carries no year', () => {
    expect(parseSeasonDay('02-29')).toEqual({ day: 29, month: 2 });
  });

  it('reads anything else as NO WINDOW rather than as a window that never opens', () => {
    // A hand-typed `season_start: october` must leave the queue AVAILABLE. The opposite
    // reading hides a queue on a typo, with nothing on screen to say why.
    for (const junk of ['october', '', '  ', 'null', '2026-10-01', null, undefined, 12]) {
      expect(parseSeasonDay(junk)).toBeNull();
    }
  });

  it('writes back the one padded spelling', () => {
    expect(formatSeasonDay({ day: 1, month: 10 })).toBe('10-01');
    expect(formatSeasonDay({ day: 31, month: 12 })).toBe('12-31');
  });
});

describe('a window is both ends or neither', () => {
  it('reads a complete pair', () => {
    expect(seasonWindowOf(halloween)).toEqual({
      end: { day: 5, month: 11 },
      start: { day: 1, month: 10 },
    });
  });

  it('reads a HALF-written pair as no window at all', () => {
    // "Available from 1 October onwards, forever" and "somebody saved the form before picking
    // an end" are indistinguishable here, so the half is not guessed into an open end.
    expect(seasonWindowOf({ season_start: '10-01' })).toBeNull();
    expect(seasonWindowOf({ season_end: '11-05' })).toBeNull();
    expect(seasonWindowOf({})).toBeNull();
    expect(seasonWindowOf(null)).toBeNull();
  });
});

describe('is today inside the window', () => {
  it('is inclusive at BOTH ends', () => {
    expect(isInSeason(halloween, on(10, 1))).toBe(true);
    expect(isInSeason(halloween, on(11, 5))).toBe(true);
  });

  it('is out one day either side', () => {
    expect(isInSeason(halloween, on(9, 30))).toBe(false);
    expect(isInSeason(halloween, on(11, 6))).toBe(false);
  });

  it('WRAPS the new year', () => {
    expect(isInSeason(advent, on(12, 1))).toBe(true);
    expect(isInSeason(advent, on(12, 25))).toBe(true);
    expect(isInSeason(advent, on(1, 6))).toBe(true);
    expect(isInSeason(advent, on(1, 7))).toBe(false);
    expect(isInSeason(advent, on(6, 15))).toBe(false);
  });

  it('treats a one-day window as one day', () => {
    const birthday = { season_end: '03-14', season_start: '03-14' };
    expect(isInSeason(birthday, on(3, 14))).toBe(true);
    expect(isInSeason(birthday, on(3, 13))).toBe(false);
    expect(isInSeason(birthday, on(3, 15))).toBe(false);
  });

  it('leaves a set with no window in season all year', () => {
    expect(isInSeason({ enabled: true }, on(6, 15))).toBe(true);
    expect(isInSeason({}, on(1, 1))).toBe(true);
  });
});

describe('the window is a SECOND gate over `enabled`, never a writer of it', () => {
  it('needs both to answer yes', () => {
    expect(isSetAvailable(halloween, on(10, 15))).toBe(true);
    expect(isSetAvailable({ ...halloween, enabled: false }, on(10, 15))).toBe(false);
    expect(isSetAvailable(halloween, on(6, 15))).toBe(false);
    expect(isSetAvailable({ ...halloween, enabled: false }, on(6, 15))).toBe(false);
  });

  it('does not touch the stored flag when the season closes', () => {
    // The whole point of the split: the manual switch and the calendar are read
    // independently, so the owner can still disable an in-season queue and re-enable an
    // out-of-season one without editing a date. A window that WROTE `enabled` would make
    // whichever ran last win, silently.
    const set = { ...halloween };
    expect(isSetAvailable(set, on(6, 15))).toBe(false);
    expect(set.enabled).toBe(true);
    expect(set.season_start).toBe('10-01');
    expect(set.season_end).toBe('11-05');
  });

  it('reads an ABSENT `enabled` as enabled, the way an absent line always has', () => {
    expect(isSetAvailable({ season_end: '11-05', season_start: '10-01' }, on(10, 15))).toBe(true);
    expect(isSetAvailable({}, on(10, 15))).toBe(true);
  });

  it('is a function of `now`, so nothing needs a timer to notice the boundary', () => {
    // One value, two answers, no write in between. This is what "evaluated on a READ" means.
    expect(isSetAvailable(halloween, on(11, 5))).toBe(true);
    expect(isSetAvailable(halloween, on(11, 6))).toBe(false);
  });

  it('answers no for a set that does not exist', () => {
    expect(isSetAvailable(null)).toBe(false);
    expect(isSetAvailable(undefined)).toBe(false);
  });
});

describe('the mark on the shelf card', () => {
  it('names the date the queue comes back', () => {
    expect(seasonReturnLabel(halloween, on(6, 15))).toBe('1 Oct');
    expect(seasonReturnLabel(advent, on(6, 15))).toBe('1 Dec');
  });

  it('says nothing while the queue is IN season', () => {
    expect(seasonReturnLabel(halloween, on(10, 15))).toBeNull();
  });

  it('says nothing about a queue with no window', () => {
    expect(seasonReturnLabel({ enabled: true }, on(6, 15))).toBeNull();
  });

  it('says nothing about a queue the owner turned off by hand', () => {
    // A disabled queue is not "out of season", and marking it as one would blame the calendar
    // for a switch somebody flipped.
    expect(seasonReturnLabel({ enabled: false }, on(6, 15))).toBeNull();
  });
});
