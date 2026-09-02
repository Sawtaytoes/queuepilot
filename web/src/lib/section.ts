import { formatTimecode } from "@charcuterie/ui"

import type {
  EndPoint,
  QueueItem,
  StartPoint,
  TileEntry,
} from "./types"

/**
 * A SECTION of an item: where playback begins inside the first played unit, and where it
 * stops.
 *
 * One mechanism, two independently optional ends, and all four combinations are real states
 * rather than three plus an error (decision
 * `2026-09-01-a-start-point-carries-a-position-and-end-is-its-mirror`):
 *
 * | `startMs` | `endMs` | Plays |
 * | --- | --- | --- |
 * | null | null | the whole unit — today's behaviour |
 * | set | null | from that offset to the end of the unit |
 * | null | set | from the beginning of the unit, stopping there |
 * | set | set | the window between them |
 *
 * ⚠️ **An open end is NOT a bound**, and this is the trap the whole file is shaped around.
 * `null` means "the choice was never made", not `0` and not `duration`. Every test here is
 * `!= null` rather than truthiness, because `0` is a real offset — a section that starts on
 * the first frame — and `Number(null)` is `0`, which is how a CLEARED window reads as a
 * section at offset zero. `entryFormat.toPositionMs()` states the same rule server-side.
 *
 * The keys carry the `Ms` suffix `@charcuterie/ui`'s `TimecodeInput` uses, because a
 * duration's unit is genuinely ambiguous and this repo speaks both: the wire is
 * milliseconds everywhere except the MQTT now-playing payload, which is seconds.
 */
export type Section = {
  endMs: number | null
  startMs: number | null
}

/** A millisecond offset off the wire, or null. Never coerces — see the `!= null` rule above. */
const positionOf = (
  value: number | null | undefined,
): number | null =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : null

/**
 * The section one entry carries, or null when it carries none.
 *
 * Reads BOTH keys: a start offset lives inside `start` (beside the season and episode that
 * pick which unit plays), and its mirror is the entry's own `end`.
 */
export function sectionOf(
  item:
    | (Pick<TileEntry, "start"> & { end?: EndPoint | null })
    | null
    | undefined,
): Section | null {
  const startMs = positionOf(item?.start?.position_ms)
  const endMs = positionOf(item?.end?.position_ms)

  return startMs == null && endMs == null
    ? null
    : { endMs, startMs }
}

export const hasSection = (
  item:
    | (Pick<TileEntry, "start"> & { end?: EndPoint | null })
    | null
    | undefined,
) => sectionOf(item) !== null

/**
 * Does this start point name a UNIT — a member, a season, an episode?
 *
 * A film section carries `start: {position_ms}` ALONE, because a film has no season and no
 * episode. Without this test `startLabel` answers "Start set" for one, which names nothing:
 * the two facts a start can carry are WHICH unit plays and WHERE IN IT playback begins, and
 * the entry sheet gives each its own field.
 */
export const startNamesUnit = (
  start: StartPoint | null | undefined,
): start is StartPoint =>
  Boolean(
    start &&
      (start.series != null ||
        start.season != null ||
        start.episode != null),
  )

/** A start point stripped to its section offset — everything a UNIT edit must not touch. */
const positionPart = (
  start: StartPoint | null | undefined,
): StartPoint =>
  start?.position_ms == null
    ? {}
    : { position_ms: start.position_ms }

/** A start point stripped to its unit fields — everything a SECTION edit must not touch. */
const unitPart = (
  start: StartPoint | null | undefined,
): StartPoint => {
  const next: StartPoint = {}

  if (start?.series != null) next.series = start.series
  if (start?.season != null) next.season = start.season
  if (start?.episode != null) next.episode = start.episode

  return next
}

/** `{}` is not a start point — the sparse rule says an empty mapping is `null`. */
const orNull = (start: StartPoint): StartPoint | null =>
  Object.keys(start).length ? start : null

/**
 * One start point with its UNIT fields replaced and its section offset kept.
 *
 * `PATCH /queues/:set/items/:key/start` replaces the whole mapping, so the start picker
 * writing `{season, episode}` back would silently DROP a section that entry already had —
 * and dropping it is invisible, because the picker does not draw the offset. The two fields
 * are independent in the panel, so each one carries the other through.
 */
export const withUnit = (
  start: StartPoint | null | undefined,
  unit: StartPoint | null,
): StartPoint | null =>
  orNull({ ...positionPart(start), ...(unit ?? {}) })

/** Its mirror: one start point with its section offset replaced and its unit kept. */
export const withPositionMs = (
  start: StartPoint | null | undefined,
  positionMs: number | null,
): StartPoint | null =>
  orNull({
    ...unitPart(start),
    ...(positionMs == null
      ? {}
      : { position_ms: positionMs }),
  })

/**
 * A timecode as this app prints one: `12:30`, `01:02:03` — the hour only once there is one,
 * and zero-padded, which is `formatTimecode`'s canonical spelling.
 *
 * `formatTimecode` from `@charcuterie/ui`, never a sixth hand-rolled printer. The library
 * counted five across the fleet, two of them in THIS repo (`tileFace.clock` and
 * `NowPlayingBar.toClock`), each with its own answer to whether the hour shows and whether
 * the minute is padded. Milliseconds are dropped: a tile tag and a tooltip are read at a
 * glance, and `.000` on every one of them is three characters of noise. The MODAL shows the
 * full `hh:mm:ss.mmm`, because that is where a frame-accurate value is typed.
 */
export const timecode = (ms: number): string =>
  formatTimecode(Math.max(0, ms), {
    isHoursShown: ms >= 3_600_000,
    millisecondDigits: 0,
  })

/**
 * The tile TAG — short enough for a poster, and different in each of the three states worth
 * showing. A default shows NOTHING, which is the whole rule the tags follow
 * (decision `2026-08-14-entry-settings-are-tags-plus-a-panel`).
 *
 * Every reading leads with the same word so the three read as one family, and so that none
 * of them collides with the batch-stop tag's "Ends at season" a few pixels away.
 */
export function sectionTagLabel(
  section: Section | null,
): string {
  if (!section) return ""

  const { endMs, startMs } = section

  if (startMs != null && endMs != null) {
    return `Section ${timecode(startMs)}–${timecode(endMs)}`
  }

  if (startMs != null) {
    return `Section from ${timecode(startMs)}`
  }

  return `Section to ${timecode(endMs ?? 0)}`
}

/**
 * The tag's tooltip. Authored in Plex's words — the caller runs `applyVocab` over it, the
 * way every other tag here does.
 */
export function sectionTagTip(
  section: Section | null,
): string {
  if (!section) return ""

  const { endMs, startMs } = section

  if (startMs != null && endMs != null) {
    return `Plays only ${timecode(startMs)} to ${timecode(endMs)} of this item, then the queue moves on`
  }

  if (startMs != null) {
    return `Playback begins at ${timecode(startMs)} and runs to the end of this item`
  }

  return `Playback begins at the start and stops at ${timecode(endMs ?? 0)}, then the queue moves on`
}

/**
 * The one-line summary in the entry sheet's Section row. Longer than the tag — there is a
 * whole row for it — and it names the runtime when the item reports one, because "stops at
 * 17:00" means something different in a 20-minute episode and a three-hour film.
 */
export function sectionSummary(
  section: Section | null,
  durationMs?: number | null,
): string {
  const runtime =
    durationMs != null && durationMs > 0
      ? ` of ${timecode(durationMs)}`
      : ""

  if (!section) return "Plays the whole item"

  const { endMs, startMs } = section

  if (startMs != null && endMs != null) {
    return `${timecode(startMs)} to ${timecode(endMs)}${runtime}`
  }

  if (startMs != null) {
    return `${timecode(startMs)} to the end${runtime}`
  }

  return `The start to ${timecode(endMs ?? 0)}${runtime}`
}

/**
 * The item's runtime in milliseconds, or null when nothing knows it.
 *
 * `0` is what the wire sends for "unknown" — a Kavita chapter, a board game, a Plex item
 * whose next-up lookup came back empty — and it is NOT a runtime. Answering null makes the
 * modal drop its slider and its clamp rather than clamping every offset to zero, which is
 * what passing `durationMs={0}` to a `TimecodeInput` would do.
 */
export function runtimeMs(
  item: Pick<QueueItem, "duration"> | null | undefined,
): number | null {
  const ms = Number(item?.duration) || 0

  return ms > 0 ? ms : null
}
