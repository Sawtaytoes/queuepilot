// The seasonal reset's date arithmetic. Pure — no store, no clock, no timer.
//
// decision 2026-09-08-a-queue-can-clear-its-own-watched-state-on-a-date-each-year
import { describe, expect, it } from 'vitest';

import {
  formatResetDate, isResetDue, mostRecentOccurrence, parseResetDate,
} from './seasonalReset.js';

const at = (
  year: number, month: number, day: number, hour = 12,
): Date => new Date(year, month - 1, day, hour, 0, 0, 0);
const secondsAt = (...args: Parameters<typeof at>): number => Math.floor(at(...args).getTime() / 1000);

describe('parseResetDate', () => {
  it('reads MM-DD', () => {
    expect(parseResetDate('11-01')).toEqual({ month: 11, day: 1 });
    expect(parseResetDate('12-25')).toEqual({ month: 12, day: 25 });
  });

  it('tolerates the shapes a hand-edited file produces', () => {
    expect(parseResetDate('  11-01  ')).toEqual({ month: 11, day: 1 });
    expect(parseResetDate('11/1')).toEqual({ month: 11, day: 1 });
    expect(parseResetDate('1-5')).toEqual({ month: 1, day: 5 });
  });

  it('is OFF for absent, blank and unreadable values', () => {
    // Every one of these means "this queue does not reset". A typo must disable the feature,
    // never invent a date — the same posture parsePromoteWindow takes.
    for (const raw of [null, undefined, '', '   ', 'never', 'nonsense', '2026-11-01', '13-01', '11-32', '02-30', '0-5', '11-0']) {
      expect(parseResetDate(raw), `${JSON.stringify(raw)} should be off`).toBeNull();
    }
  });

  it('accepts 29 February — it is a real date somebody may pick', () => {
    expect(parseResetDate('02-29')).toEqual({ month: 2, day: 29 });
  });
});

describe('formatResetDate', () => {
  it('pads, so the file always reads MM-DD', () => {
    expect(formatResetDate({ month: 1, day: 5 })).toBe('01-05');
  });
});

describe('mostRecentOccurrence', () => {
  it('is this year when the date has passed', () => {
    expect(mostRecentOccurrence({ month: 11, day: 1 }, at(2026, 11, 5))).toEqual(at(2026, 11, 1, 0));
  });

  it('is LAST year when the date has not come round yet', () => {
    expect(mostRecentOccurrence({ month: 11, day: 1 }, at(2026, 10, 30))).toEqual(at(2025, 11, 1, 0));
  });

  it('counts the date itself, from local midnight', () => {
    expect(mostRecentOccurrence({ month: 11, day: 1 }, at(2026, 11, 1, 0))).toEqual(at(2026, 11, 1, 0));
  });

  it('lands 29 February on 1 March in a common year rather than skipping it', () => {
    // Never SKIPPED: a queue asked to reset on the leap day still resets every year, one day
    // later in three years out of four.
    expect(mostRecentOccurrence({ month: 2, day: 29 }, at(2026, 6, 1))).toEqual(at(2026, 3, 1, 0));
    expect(mostRecentOccurrence({ month: 2, day: 29 }, at(2024, 6, 1))).toEqual(at(2024, 2, 29, 0));
  });
});

describe('isResetDue', () => {
  const ON = '11-01';

  it('is not due when the queue names no date', () => {
    expect(isResetDue({ resetWatchedOn: null, lastResetAt: null, now: at(2026, 11, 5) }))
      .toEqual({ isDue: false, why: 'not-configured' });
  });

  it('is not due before the date, however long the queue has run', () => {
    expect(isResetDue({ resetWatchedOn: ON, lastResetAt: secondsAt(2025, 11, 1), now: at(2026, 10, 31) }))
      .toEqual({ isDue: false, why: 'already-reset' });
  });

  it('fires on the date when the queue has never reset', () => {
    const verdict = isResetDue({ resetWatchedOn: ON, lastResetAt: null, now: at(2026, 11, 1, 9) });
    expect(verdict).toMatchObject({ isDue: true, reason: '11-01' });
  });

  it('fires ONCE, and the stamp is the only thing that stops the second read', () => {
    // There is no timer, so a queue played three times on 1 November is asked three times.
    const first = isResetDue({ resetWatchedOn: ON, lastResetAt: null, now: at(2026, 11, 1, 9) });
    expect(first.isDue).toBe(true);
    const second = isResetDue({
      resetWatchedOn: ON,
      lastResetAt: secondsAt(2026, 11, 1, 9),
      now: at(2026, 11, 1, 21),
    });
    expect(second).toEqual({ isDue: false, why: 'already-reset' });
  });

  it('corrects a missed day rather than skipping the year', () => {
    // Nobody plays the queue until December. The reset happens in December — the same answer
    // arriving later, which is the whole reason there is no timer.
    const verdict = isResetDue({
      resetWatchedOn: ON,
      lastResetAt: secondsAt(2025, 11, 1),
      now: at(2026, 12, 20),
    });
    expect(verdict).toMatchObject({ isDue: true });
    expect(verdict.isDue && verdict.occurrence).toEqual(at(2026, 11, 1, 0));
  });

  it('fires again the NEXT year, and not before', () => {
    const stamp = secondsAt(2026, 11, 1, 9);
    expect(isResetDue({ resetWatchedOn: ON, lastResetAt: stamp, now: at(2027, 10, 31) }))
      .toEqual({ isDue: false, why: 'already-reset' });
    expect(isResetDue({ resetWatchedOn: ON, lastResetAt: stamp, now: at(2027, 11, 1, 1) }))
      .toMatchObject({ isDue: true });
  });
});
