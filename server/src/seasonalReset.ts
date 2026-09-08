// The seasonal reset as a PURE VALUE: what `reset_watched_on` means, and whether today is
// past it.
//
// decision 2026-09-08-a-queue-can-clear-its-own-watched-state-on-a-date-each-year.
//
// Nothing here reads a clock, opens a database or writes a file. It exists as its own module
// for `leadWindow.ts`'s reason: the answer is a comparison between two dates, and the module
// that owns the WRITE (`watchedReset.ts`) reaches the book of record, so a caller that only
// wants to know whether a date has passed must not have to import that.
//
// ⚠️ THERE IS NO TIMER ANYWHERE IN THIS FEATURE, and that is the decision, not an omission.
// A `setInterval` that does not fire is invisible until somebody notices a repeat; a
// comparison against the date cannot silently not happen. A queue nobody plays until December
// resets in December, which is the same answer arriving later.

/** A `reset_watched_on` value, parsed. Months are 1-12 and days are 1-31, as a person writes them. */
export interface ResetDate {
  month: number;
  day: number;
}

/**
 * Parse `reset_watched_on`. The stored spelling is `MM-DD` — `"11-01"` is 1 November.
 *
 * Tolerant of the shapes a hand-edited `sets.yaml` produces: padding, a `/` separator and a
 * single-digit month or day. Refuses anything else by returning null, which every consumer
 * reads as "this queue does not reset" — the same posture `parsePromoteWindow` takes, and for
 * the same reason: a typo must disable the feature rather than invent a date.
 *
 * ⚠️ `MM-DD` and not `DD-MM`, and not a locale. The file is read by one household and by
 * `e2e/`, and a value whose meaning depends on where it is read is a value that plays the
 * Halloween queue in January.
 */
export function parseResetDate(raw: unknown): ResetDate | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const match = /^(\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  // A day past the end of its own month is a typo, not a date to clamp: `02-31` means nobody
  // knows what was meant, and guessing 28 February would fire the reset three days early
  // every year with nothing on screen to say so.
  if (day > daysInMonth(month, 2024)) return null; // 2024 is a leap year: 29 February passes
  return { month, day };
}

/** The stored spelling of a parsed date — zero padded, so the file always reads `11-01`. */
export function formatResetDate(date: ResetDate): string {
  return `${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/** How many days a month has in a given year. February is the only interesting one. */
export function daysInMonth(month: number, year: number): number {
  // Day 0 of the NEXT month is the last day of this one. `month` is 1-based and the Date
  // constructor's month is 0-based, so `month` here already names the next one.
  return new Date(year, month, 0).getDate();
}

/**
 * The most recent moment this date came round, at or before `now`, as LOCAL midnight.
 *
 * Local and not UTC. The household reads this as a day on a calendar, and a UTC boundary puts
 * the reset several hours out on one side of the world and on the wrong DAY on the other.
 *
 * 29 FEBRUARY: a common year has no 29 February, so the date lands on 1 March by the ordinary
 * `Date` overflow — which is the answer a person means. A reset asked for on the leap day
 * still happens every year, one day later in three years out of four. It is never SKIPPED,
 * which is what a strict reading would do.
 */
export function mostRecentOccurrence(date: ResetDate, now: Date): Date {
  const thisYear = occurrenceIn(date, now.getFullYear());
  if (thisYear.getTime() <= now.getTime()) return thisYear;
  return occurrenceIn(date, now.getFullYear() - 1);
}

function occurrenceIn(date: ResetDate, year: number): Date {
  return new Date(year, date.month - 1, date.day, 0, 0, 0, 0);
}

/** What `isResetDue` needs to answer. Every field is what the caller already holds. */
export interface ResetDueQuery {
  /** The set's `reset_watched_on`, raw off the cfg. Absent / unparseable = the queue is off. */
  resetWatchedOn: unknown;
  /** Epoch SECONDS of the last reset, or null when this queue has never reset. */
  lastResetAt: number | null;
  now: Date;
}

/** Why a queue is not due, when it is not. Reported so a log line can say which. */
export type ResetDueVerdict =
  | { isDue: true; occurrence: Date; reason: string }
  | { isDue: false; why: 'not-configured' | 'already-reset' };

/**
 * Is this queue past its reset date, and has it not already reset for that occurrence?
 *
 * The whole read-time check, in one comparison. `lastResetAt` is what stops it firing again on
 * the second read of the same day — there is no timer to hold that state, so the stamp is it.
 *
 * A stamp is compared against the OCCURRENCE, never against "a year ago". A queue reset on
 * 1 November 2026 and next played on 30 October 2027 is not due: the most recent occurrence is
 * still 1 November 2026 and the stamp is at or after it. On 1 November 2027 the occurrence
 * moves and the stamp is behind it, so it fires — once.
 */
export function isResetDue(query: ResetDueQuery): ResetDueVerdict {
  const date = parseResetDate(query.resetWatchedOn);
  if (!date) return { isDue: false, why: 'not-configured' };
  const occurrence = mostRecentOccurrence(date, query.now);
  const stampMs = query.lastResetAt == null ? null : query.lastResetAt * 1000;
  if (stampMs != null && stampMs >= occurrence.getTime()) {
    return { isDue: false, why: 'already-reset' };
  }
  return { isDue: true, occurrence, reason: formatResetDate(date) };
}
