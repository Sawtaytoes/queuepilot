/**
 * ONE question about completion, with four answers — the Set editor's picker, and the
 * translation between it and the three booleans on disk
 * (decision `2026-09-08-completion-behaviour-is-one-picker-not-two-checkboxes`).
 *
 * | Mode      | Marks an entry done | Plays the whole lineup each scan | When everything is done |
 * | --------- | ------------------- | -------------------------------- | ----------------------- |
 * | `consume` | Yes                 | No                               | The queue runs dry      |
 * | `restart` | Yes                 | No                               | Clears, a round starts  |
 * | `playlist`| No                  | No                               | Never happens           |
 * | `reel`    | No                  | Yes                              | Never happens           |
 *
 * **STORAGE DOES NOT CHANGE.** `keep_completed` and `reel` are still the keys on disk and
 * `restart_when_exhausted` is one more boolean beside them. This file is a presentation over
 * a settled data model: no migration, a hand-edited `sets.yaml` keeps working, and a key
 * nobody promoted is not dropped.
 *
 * An ILLEGAL combination written by hand is RESOLVED, never refused — `reel` wins, then
 * `keep_completed`, then `restart_when_exhausted`. That is the precedence the engine already
 * has: `reel` implies `keep_completed`, and a set that never marks an entry done can never
 * run out of them. `server/src/sets.ts normalize()` reports the same effective triple, so the
 * picker and the engine cannot disagree about what a contradictory file means.
 */
export type CompletionMode =
  | "consume"
  | "playlist"
  | "reel"
  | "restart"

/** The three booleans as the wire carries them — and as `PATCH /api/sets/:id` takes them. */
export interface CompletionFlags {
  keep_completed: boolean
  reel: boolean
  restart_when_exhausted: boolean
}

/** In picker order: the default first, then the three opt-ins. */
export const COMPLETION_MODES: readonly CompletionMode[] = [
  "consume",
  "restart",
  "playlist",
  "reel",
]

export const COMPLETION_MODE_LABELS: Record<
  CompletionMode,
  string
> = {
  consume:
    "Consume — play each entry once, then it is done",
  playlist:
    "Playlist mode — never mark entries done, so the lineup stays re-showable",
  reel: "Demo reel — play the whole lineup every scan",
  restart:
    "Start over when exhausted — play each entry once, then start a new round",
}

export const COMPLETION_MODE_HINTS: Record<
  CompletionMode,
  string
> = {
  consume:
    "The normal queue. An entry that finishes is marked done and drops out, and the queue runs dry when the last one goes.",
  playlist:
    "Nothing is ever marked done, so every entry stays playable for ever. A showcase lineup wants this. It never runs dry, so it never starts over either.",
  reel: "Ignores watched state and plays every entry each scan. Nothing is ever marked done. The Theater Demo Reel is this.",
  restart:
    "Nothing repeats while anything is unwatched. When the last entry finishes, the queue clears its watched state and a new round begins. This is a COUNT, not a calendar — a queue that resets on a date is a separate setting.",
}

/**
 * Which mode a stored set is in. Reads the effective triple; the precedence above resolves a
 * hand-written contradiction rather than refusing it.
 */
export function completionModeOf(
  flags: Partial<CompletionFlags> | null | undefined,
): CompletionMode {
  if (flags?.reel) return "reel"
  if (flags?.keep_completed) return "playlist"
  if (flags?.restart_when_exhausted) return "restart"
  return "consume"
}

/**
 * The triple to SAVE for a chosen mode.
 *
 * `reel` still carries `keep_completed: true` because the engine implies it and a hand-reader
 * of `sets.yaml` should see the non-consuming intent without knowing the implication. Every
 * other mode sends the other two as `false`, which the writer stores as the ABSENCE of the
 * key — so a queue that has never left Consume gains no lines at all.
 */
export function completionFlagsFor(
  mode: CompletionMode,
): CompletionFlags {
  return {
    keep_completed: mode === "playlist" || mode === "reel",
    reel: mode === "reel",
    restart_when_exhausted: mode === "restart",
  }
}
