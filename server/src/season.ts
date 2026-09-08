// THE SEASON WINDOW — a start date and an end date that repeat every year.
//
// One question, asked in one place: **is this queue available right now?** The answer is the
// stored `enabled` flag AND today falling inside the window
// (decision `2026-09-08-a-season-window-gates-the-existing-enabled-flag`).
//
// Three rules from that record are expressed HERE rather than at the six call sites, and each
// of them is a thing a second implementation gets wrong:
//
//   1. ⚠️ **NOTHING IN THIS FILE WRITES `enabled`, and nothing may learn to.** The window is a
//      SECOND gate over the stored flag, never a writer of it. If a season boundary wrote the
//      flag, the owner's manual toggle and the calendar would fight over one value and
//      whichever ran last would win with nothing in the log to say so. That is why
//      `isSetAvailable` is a function of two inputs and returns a boolean instead of
//      normalising one onto the other.
//   2. **It is evaluated on a READ. There is no timer, no cron and no `setInterval.`** Every
//      entry point takes `now` so the answer is computed at the moment the shelf or the
//      Tonight candidate list is built, exactly the way `promote_window` is read at play time.
//      A missed day corrects itself, because there was never a day to miss.
//   3. **A season boundary CLEARS NOTHING and MARKS NOTHING.** No `done` flag, no
//      `queue_entry_history` row, no `lead_cooldown` row. Resetting watched state is a
//      separate setting with its own record
//      (`2026-09-08-a-queue-can-clear-its-own-watched-state-on-a-date-each-year`), and the
//      owner split them deliberately: "Option 3 is more of a display one, not a 'reset the
//      queue' one." A queue can be seasonal and never reset, or reset annually and be
//      available all year.
//
// Pure: no store, no clock of its own, no provider. That is what lets `sets.ts` (the web
// registry), `engine/routing.ts`'s five consumers and `tonight/pick.ts` all ask the same
// function without any of them importing each other.

/**
 * A set, as much of one as this file reads. STRUCTURAL on purpose — `RoutingSetCfg` (the
 * engine shape) and `SetRegistryEntry` (the web shape) both satisfy it, and neither is
 * imported here. That is the whole reason all six `enabled` call sites can share one answer:
 * they hold two different set shapes and there is exactly one predicate between them.
 *
 * `enabled` is optional so a hand-built fixture that omits it reads as enabled, which is what
 * an absent `enabled:` line has always meant on disk.
 */
export interface SeasonGated {
  enabled?: boolean | null;
  season_start?: string | null;
  season_end?: string | null;
}

/** A parsed season day. No YEAR: the window repeats, so a year would be a lie the first time
 *  it rolled over. */
export interface SeasonDay {
  month: number;
  day: number;
}

/** A parsed window. Both ends or neither — see `seasonWindowOf`. */
export interface SeasonWindow {
  start: SeasonDay;
  end: SeasonDay;
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** The longest a month can be. February is 29 and not 28 on purpose: the window repeats every
 *  year, so a 29 Feb boundary is legal and simply does not occur in three years out of four. */
const MONTH_LENGTHS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * Read one `MM-DD` off the file. Anything else is `null`, and `null` means NO WINDOW rather
 * than a window that never opens — a hand-typed `season_start: october` must leave the queue
 * available, the way an unreadable `promote_window` falls back rather than blocking a promote.
 *
 * Tolerant about shape (`10-1`, ` 10-01 `, `10/01`) and strict about range, because the two
 * failures are different: the first is somebody typing, the second is a date that does not
 * exist.
 */
export function parseSeasonDay(value: unknown): SeasonDay | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const match = /^(\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const longest = MONTH_LENGTHS[month - 1];
  if (longest === undefined) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > longest) return null;

  return { day, month };
}

/** `MM-DD`, zero-padded — the one spelling anything writes to disk. */
export function formatSeasonDay(value: SeasonDay): string {
  return `${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

/**
 * The window a set carries, or `null` for a set with none.
 *
 * BOTH ENDS OR NEITHER. A half-written window is treated as no window rather than as an
 * open-ended one, because "available from 1 October onwards, forever" and "somebody saved the
 * form before picking the end" are indistinguishable here — and the writer
 * (`sets.ts normalizeSeasonForWrite`) refuses the half by name, so the only way to reach this
 * branch is a hand edit.
 */
export function seasonWindowOf(cfg: SeasonGated | null | undefined): SeasonWindow | null {
  if (!cfg) return null;
  const start = parseSeasonDay(cfg.season_start);
  const end = parseSeasonDay(cfg.season_end);
  if (!start || !end) return null;

  return { end, start };
}

/** `MM-DD` as one comparable integer: 1001 for 1 October. Month-major, so the ordinal sorts
 *  the calendar without needing a year to hang the dates on. */
const ordinalOf = (value: SeasonDay): number => value.month * 100 + value.day;

/** Today, in the SERVER's local time. A season is a household calendar fact — "the Halloween
 *  queue opens on 1 October" is about the wall in the hallway, not about UTC. */
const ordinalOfDate = (now: Date): number => (now.getMonth() + 1) * 100 + now.getDate();

/**
 * Is `now` inside the window?
 *
 * INCLUSIVE at both ends, and it WRAPS: `12-01` → `01-06` is an Advent window that crosses
 * the new year, and it is the case a naive `start <= today && today <= end` gets wrong by
 * being false every single day of its own season. A set with no window is always in season.
 */
export function isInSeason(cfg: SeasonGated | null | undefined, now: Date = new Date()): boolean {
  const window = seasonWindowOf(cfg);
  if (!window) return true;
  const start = ordinalOf(window.start);
  const end = ordinalOf(window.end);
  const today = ordinalOfDate(now);

  return start <= end
    ? today >= start && today <= end
    : today >= start || today <= end;
}

/**
 * ⭐ THE ONE ANSWER TO "IS THIS QUEUE AVAILABLE RIGHT NOW". Every consumer that used to ask
 * `cfg.enabled === false` asks this instead.
 *
 * `enabled !== false` AND in season, and the order of those two is not a style choice: the
 * stored flag is the owner's manual switch and the window is the calendar, they are read
 * independently, and NEITHER is written by the other. He can still disable a queue that is in
 * season, and re-enable one that is out of it, without editing a date.
 */
export function isSetAvailable(
  cfg: SeasonGated | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!cfg) return false;

  return cfg.enabled !== false && isInSeason(cfg, now);
}

/**
 * The date an out-of-season queue comes back, as words a card can print — `1 Oct`.
 *
 * `null` when the queue is IN season or carries no window, so a caller can render the mark on
 * truthiness alone. A queue that silently vanishes is a support question; a queue that says
 * "Out of season · returns 1 Oct" is the answer to it.
 */
export function seasonReturnLabel(
  cfg: SeasonGated | null | undefined,
  now: Date = new Date(),
): string | null {
  const window = seasonWindowOf(cfg);
  if (!window || isInSeason(cfg, now)) return null;

  return `${window.start.day} ${MONTH_NAMES[window.start.month - 1] ?? ''}`.trim();
}
