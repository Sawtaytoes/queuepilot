import type { NextEp, StartPoint, TileEntry } from "./types"

/**
 * "S3 · E5" for a multi-season show, just "E5" for a single-season one (every
 * anime — Japan doesn't do American-style seasons, so the "S1" is noise).
 */
export function seLabel(ep: NextEp): string {
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

/**
 * A collection's members are usually named after it ("Chaika: The Coffin Princess -
 * Avenging Battle" inside the "Chaika: The Coffin Princess" collection), and a tile
 * is ~160px wide — so the part that says WHICH member is exactly the part that gets
 * truncated away. The badge underneath already names the collection, so strip that
 * shared prefix off the title line.
 *
 * Left whole when the member doesn't lead with the collection name, or is named
 * exactly for it. (decision `2026-07-31-collection-tiles-are-member-first`)
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

  return rest || m
}

/**
 * "12:30" from milliseconds — `H:MM:SS` once past an hour, `M:SS` below it. Feeds the
 * "In Progress" badge's hover readout (how far a resume point sits into the episode).
 */
export function clock(
  ms: number | null | undefined,
): string {
  const total = Math.max(
    0,
    Math.round((Number(ms) || 0) / 1000),
  )
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h ? String(m).padStart(2, "0") : String(m)

  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`
}

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

export type TileFace = {
  ratingKey: string | null
  title: string
  fullTitle?: string
  year: number | null
  next: string
  nextDone: boolean
  /** The collection a borrowed face came from (null for a plain series/movie). */
  from: string | null
}

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
    from: null,
    next: "",
    nextDone: false,
    ratingKey: item.ratingKey,
    title: item.title,
    year: item.year,
  }

  if (item.type === "show") {
    if (n) {
      base.next = n.title
        ? `${seLabel(n)} · ${n.title}`
        : seLabel(n)
    } else if (item.resolved) {
      base.next = "All watched"
      base.nextDone = true
    }

    return base
  }

  if (item.type !== "collection") return base

  if (!n?.member) {
    // No next-up member (every member watched, or Plex couldn't say): fall back to
    // the collection's own poster/name + its size.
    base.year = null
    base.next =
      item.childCount != null
        ? `${item.childCount} in order`
        : "plays in order"

    return base
  }

  return {
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
        : n.position && item.childCount
          ? `${n.position} of ${item.childCount}`
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
 * The chip on an overridden tile: "Start E20" / "Start S2E3" (the season only when
 * it matters).
 */
export function startLabel(
  start: StartPoint | null | undefined,
): string {
  if (!start) return ""
  if (start.episode == null) return "Start set"

  return (start.season ?? 0) > 1
    ? `Start S${start.season}E${start.episode}`
    : `Start E${start.episode}`
}
