import { startNamesUnit, timecode } from "./section"
import type {
  EntryUnit,
  NextEp,
  StartPoint,
  TileEntry,
} from "./types"

/**
 * "S3 · E5" for a multi-season show, just "E5" for a single-season one (every
 * anime — Japan doesn't do American-style seasons, so the "S1" is noise),
 * "Ch 113" on a reading queue, where the number is a chapter and there is no
 * season at all, and "Play 2 of 3" on a board game.
 *
 * A game is the only unit with a KNOWN TOTAL — an entry owes exactly N plays and then the
 * next game becomes the head — so it is the only one that counts towards something. A
 * queue with no total set says just "Play 2" rather than inventing a denominator.
 */
export function seLabel(
  ep: NextEp,
  unit: EntryUnit = "episode",
): string {
  if (unit === "volume") return `Vol ${ep.episode ?? "?"}`
  if (unit === "chapter") return `Ch ${ep.episode ?? "?"}`
  if (unit === "play") {
    const n = `Play ${ep.episode ?? "?"}`

    return ep.of ? `${n} of ${ep.of}` : n
  }

  const e = `E${ep.episode ?? "?"}`

  return ep.multiSeason ? `S${ep.season ?? "?"} · ${e}` : e
}

/**
 * Alphabetical sort that ignores a leading article (A / An / The) and is
 * numeric-aware (so "Vol 2" sorts before "Vol 10"): "The Book of Bantorra" files
 * under B, not T.
 */
export const titleSortKey = (
  t: string | null | undefined,
) => (t || "").replace(/^\s*(a|an|the)\s+/i, "")

export const byTitle = (
  a: { title: string },
  b: { title: string },
) =>
  titleSortKey(a.title).localeCompare(
    titleSortKey(b.title),
    undefined,
    {
      numeric: true,
      sensitivity: "base",
    },
  )

/** The collection size that can still play. Explicitly skipped direct members are absent. */
export const collectionOrderCount = (
  item: Pick<TileEntry, "childCount" | "skippedCount">,
): number | null =>
  item.childCount == null
    ? null
    : Math.max(
        0,
        item.childCount - (item.skippedCount ?? 0),
      )

/**
 * A collection's members are usually named after it ("Chaika: The Coffin Princess -
 * Avenging Battle" inside the "Chaika: The Coffin Princess" collection), and a tile
 * is ~160px wide — so the part that says WHICH member is exactly the part that gets
 * truncated away. The badge underneath already names the collection, so strip that
 * shared prefix off the title line.
 *
 * Left whole when the member doesn't lead with the collection name, is named
 * exactly for it, or the only thing left after the prefix is a release year or a bare
 * season/sequel ordinal — "Aldnoah.Zero (2015)" must not shrink to "(2015)", and
 * "Trapped in a Dating Sim 2" must not shrink to "2 (2026)". Neither remainder names
 * a show, so keep the whole title.
 * (decision `2026-07-31-collection-tiles-are-member-first`)
 */
export function withoutCollectionPrefix(
  member: string | null | undefined,
  collection: string | null | undefined,
): string {
  const m = String(member || "")
  const c = String(collection || "")

  if (
    !c ||
    m.length <= c.length ||
    m.slice(0, c.length).toLowerCase() !== c.toLowerCase()
  ) {
    return m
  }

  const rest = m
    .slice(c.length)
    .replace(/^\s*[-–—:·]?\s*/, "")

  // A remainder that is only a release year or sequel/season ordinal ("2", "II",
  // "Season 3", "Part 2") identifies no show on its own — the prefix WAS the show
  // name. Keep the full member title so the tile still reads as a show.
  if (
    /^\(\d{4}\)$/.test(rest) ||
    /^(?:season|part|s)?\s*(?:\d+|[ivxlcdm]+)$/i.test(rest)
  ) {
    return m
  }

  return rest || m
}

/**
 * "12:30" from milliseconds — `hh:mm:ss` once past an hour, `mm:ss` below it. Feeds the
 * "In Progress" badge's hover readout (how far a resume point sits into the episode).
 *
 * `lib/section.timecode`, which is `formatTimecode` from `@charcuterie/ui`. This used to be a
 * hand-rolled printer, one of five across the fleet and two in this repo — see the note on
 * `NowPlayingBar.toClock`, which was the other one.
 */
const clock = (ms: number | null | undefined): string =>
  timecode(Number(ms) || 0)

/**
 * The "In Progress" badge's tooltip: "12:30 of 24:00 (52%)". Falls back to a bare
 * "12:30 in" when Plex gave a resume point but no runtime, and null when there is
 * nothing to say (the badge then keeps just its label).
 */
export function progressLabel(
  offsetMs?: number | null,
  durationMs?: number | null,
): string | null {
  const off = Number(offsetMs) || 0
  const dur = Number(durationMs) || 0

  if (dur <= 0) return off > 0 ? `${clock(off)} in` : null

  const pct = Math.min(
    100,
    Math.max(0, Math.round((off / dur) * 100)),
  )

  return `${clock(off)} of ${clock(dur)} (${pct}%)`
}

/** "24 min" / "1 h 47 min" from milliseconds. Null below a minute — a runtime Plex does
 *  not know is not a runtime worth a line. */
function minutes(ms: number): string | null {
  const total = Math.round(ms / 60000)

  if (total < 1) return null
  if (total < 60) return `${total} min`

  const h = Math.floor(total / 60)
  const m = total % 60

  return m ? `${h} h ${m} min` : `${h} h`
}

/**
 * How long the thing that plays next runs, for the tile's own line.
 *
 * `count` is the entry's effective batch — its own `episodes` override, else the queue's
 * default. Only the NEXT episode's runtime is known (it is the only leaf `nextEp` carries),
 * so a batch multiplies it and says **about**: episodes in a series are near-uniform, and a
 * total presented as exact would be a number nothing measured
 * (decision `2026-08-22-a-tile-names-the-runtime-on-its-own-line`).
 *
 * Null when there is no runtime at all — every Kavita and board-game tile, and any Plex item
 * whose next-up lookup came back empty. The line then does not render.
 */
export function runtimeLabel(
  ms: number | null | undefined,
  count = 1,
): string | null {
  const one = minutes(Number(ms) || 0)

  if (!one) return null
  if (count <= 1) return one

  const total = minutes((Number(ms) || 0) * count)

  return total ? `${count} x ${one} · about ${total}` : one
}

export type TileFace = {
  ratingKey: string | null
  title: string
  fullTitle?: string
  year: number | null
  next: string
  nextDone: boolean
  /** The collection a borrowed face came from (null for a plain series/movie). */
  from: string | null
  /**
   * Plex's EDITION label for the item this face IS ("3D", "Director's Cut"), or null.
   *
   * Belongs to the same item as `title`, which is what makes it correct on a collection: a
   * collection face borrows its next-up MEMBER's identity, and the next-up payload carries no
   * edition for that member, so the face says null rather than lending the collection's own
   * (which is always null anyway — a collection has no edition).
   */
  edition: string | null
}

/**
 * Does this next-up leaf's "title" just restate its own number?
 *
 * Kavita names most chapters after themselves — "35", "Chapter 35", "Ch. 35" — so the
 * episode line rendered "Ch 35 · Chapter 35". A range ("Chapter 1-19") says something the
 * number does not, and stays.
 *
 * `volume` / `vol` are in the list for the same reason at the volume level: a manga's items
 * are named "Volume 1" by Kavita and labelled "Vol 1" here, which rendered "Vol 1 · Volume 1".
 */
export function isSelfTitled(
  ep: NextEp,
  ownTitle?: string | null,
): boolean {
  const title = String(ep.title ?? "").trim()

  if (!title) return true

  // The next-up IS the tile. A game has no sub-item to name — one entry is one game — so
  // its next-up title is the game's own name, and the line rendered "Play 1 of 1 · ELDEN
  // RING" under a tile already headed ELDEN RING (reported live, 2026-08-17). The numeric
  // test below could never catch it: the duplicate is a NAME, not a numbered stand-in.
  // Board Game Picker has always had the same shape ("Play 2 of 3 · Wingspan").
  const own = String(ownTitle ?? "").trim()

  if (own && own.toLowerCase() === title.toLowerCase())
    return true

  const number = String(ep.episode ?? "")

  return (
    number !== "" &&
    new RegExp(
      `^(?:chapter|chap|ch|volume|vol)?\\.?\\s*${number}$`,
      "i",
    ).test(title)
  )
}

/**
 * Completed as the GRID means it: nothing left to play here.
 *
 * Three sources say that, and all three count. `done` is the flag in `queues.yaml`, written by
 * a scan — so it is exactly as fresh as the last one, and a film finished after it says
 * nothing. `isFinished` is the same rule judged live by `/api/queues`, which is what covers
 * the gap between the credits and the next scan (and anything watched where QueuePilot never
 * saw it). `isRevived` is that same live judgement pointing the OTHER way: the entry has
 * something to play again — a new episode aired — so the flag is stale and the next scan will
 * clear it, which makes a "Completed" badge over a tile naming the episode it is about to play
 * simply wrong.
 *
 * NOT what "Remove all completed" acts on: that button removes entries from the file, so it
 * still keys off `done` alone.
 */
export const isCompleted = (item: {
  done?: boolean
  isFinished?: boolean
  isRevived?: boolean
}): boolean =>
  !item.isRevived && Boolean(item.done || item.isFinished)

/** "Nothing left to play" in this entry's own unit — a reading queue is read, not watched,
 *  and a board game that has had all its plays is played out. */
const allWatchedLabel = (unit: EntryUnit) => {
  if (unit === "chapter" || unit === "volume")
    return "All read"
  if (unit === "play") return "All played"

  return "All watched"
}

/**
 * The WAITING counterpart of `allWatchedLabel`, for an entry that owes exactly one unit.
 *
 * "Play 1 of 1" is a denominator that can only ever be 1 and a numerator that can only ever
 * be 1 — it answers no question anyone has. A Steam entry is always this shape (Steam
 * publishes no session log, so an entry is done after one session), and a one-play board
 * game is too. The useful thing to say is the STATE, which is the same thing the finished
 * tile says, pointing the other way.
 */
const notYetLabel = (unit: EntryUnit) =>
  unit === "play" ? "Not played yet" : ""

/**
 * What a tile actually SHOWS — poster, title line, episode line. A collection
 * borrows the identity of the member that plays next (its poster + its name), and
 * names ITSELF only in the badge, so every tile reads the same way: title = what's
 * playing, yellow line = which episode.
 * (decision `2026-07-31-collection-tiles-are-member-first`)
 */
export function tileFace(item: TileEntry): TileFace {
  const n = item.nextEp
  const base: TileFace = {
    edition: item.editionTitle ?? null,
    from: null,
    next: "",
    nextDone: false,
    ratingKey: item.ratingKey,
    title: item.title,
    year: item.year,
  }

  if (
    "item_order" in item &&
    item.item_order === "shuffle" &&
    !item.done &&
    (item.type === "show" || item.type === "collection")
  ) {
    base.next =
      item.type === "show" ? "Any episode" : "Any item"
    base.nextDone = false

    return base
  }

  if (item.type === "show") {
    const unit = item.unit ?? "episode"

    if (n) {
      // A single-unit entry has nothing to count, so it reports its state instead. Only
      // `play` has such a label — an episode or a chapter always sits somewhere in a run,
      // so "E1" still says which one.
      const only =
        Number(n.of) === 1 ? notYetLabel(unit) : ""
      const label = only || seLabel(n, unit)

      base.next =
        only || isSelfTitled(n, item.title)
          ? label
          : `${label} · ${n.title}`
    } else if (item.resolved && !item.isNextEpFailed) {
      base.next = allWatchedLabel(unit)
      base.nextDone = true
    }

    return base
  }

  if (item.type !== "collection") return base

  const orderCount = collectionOrderCount(item)

  if (!n?.member) {
    // No next-up member: fall back to the collection's own poster/name. A collection
    // that is simply FINISHED reads exactly like a finished show ("All watched") —
    // the two say the same thing, so they must not say it two different ways. The
    // neutral size label is for when we don't actually know: an unresolved entry, or
    // a next-up lookup that errored rather than came back empty.
    base.year = null

    if (item.resolved && !item.isNextEpFailed) {
      base.next = allWatchedLabel(item.unit ?? "episode")
      base.nextDone = true

      return base
    }

    base.next =
      orderCount != null
        ? `${orderCount} in order`
        : "plays in order"

    return base
  }

  return {
    // The face is the MEMBER, so this is the MEMBER's edition (`nextEp.memberEdition`) and
    // never `item.editionTitle`, which would name the collection's edition on a tile whose
    // title is the member's. It stayed null until 2026-08-26, when the next-up payload
    // started carrying one: a collection can hold the same film three times, once per cut,
    // and without this the tile printed the same line whichever of them it had picked.
    edition: n.memberEdition ?? null,
    from: item.title,
    fullTitle: n.member,
    // A series member reads exactly like a series tile (episode + episode title —
    // never the series name, which is already the title line). A movie member says
    // where in the collection it sits, since the movie itself IS the title line.
    next:
      n.kind === "show"
        ? n.title
          ? `${seLabel(n)} · ${n.title}`
          : seLabel(n)
        : n.position && orderCount
          ? `${n.position} of ${orderCount}`
          : "",
    nextDone: false,
    ratingKey: n.memberRatingKey || item.ratingKey,
    title: withoutCollectionPrefix(n.member, item.title),
    year: n.memberYear ?? null,
  }
}

/**
 * Can this entry carry a manual start point? Shows and collections can (a movie is
 * one item).
 */
export const isStartable = (
  item: TileEntry | null | undefined,
) =>
  Boolean(
    item?.resolved &&
      (item.type === "show" || item.type === "collection"),
  )

/**
 * Does this entry have items INSIDE it to choose between — the member list's gate?
 *
 * The same shapes `isStartable` names, for the same reason: a movie IS its own item, so
 * "which of these plays" has one answer and Remove is the control. Separate from it because
 * the two answers will drift — a provider can list units without accepting a start floor —
 * and because a reader should not have to know that "startable" also means "has members".
 *
 * A `ratingKey` is required as well: the list is fetched by it, and an entry that resolved
 * to nothing has none.
 */
export const hasMemberList = (
  item: TileEntry | null | undefined,
) => Boolean(isStartable(item) && item?.ratingKey)

/**
 * The chip on an overridden tile: "Start E20" / "Start S2E3" (the season only when
 * it matters).
 */
export function startLabel(
  start: StartPoint | null | undefined,
  unit: EntryUnit = "episode",
): string {
  // ⚠️ A start point can carry a POSITION and nothing else — a film section is exactly that,
  // because a film has no season and no episode. It names no unit, so this label has nothing
  // to say about it and the SECTION tag beside it is what reads the offset. Without this the
  // tag said "Start set", which names nothing at all.
  if (!startNamesUnit(start)) return ""
  if (start.episode == null) return "Start set"

  if (unit === "volume") return `Start Vol ${start.episode}`
  if (unit === "chapter") return `Start Ch ${start.episode}`

  return (start.season ?? 0) > 1
    ? `Start S${start.season}E${start.episode}`
    : `Start E${start.episode}`
}
