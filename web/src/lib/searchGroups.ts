import type {
  Library,
  RegistrySet,
  SearchHit,
} from "./types"

/**
 * Ordering and labelling for a pool's member search, which since `scope=all` searches EVERY
 * library rather than the pool's own.
 *
 * That was the right call — a curated member is a manual include and need not come from a
 * library the pool draws from — but it made the results unreadable: everything arrived mixed,
 * with nothing on a row saying which library it came from or whether the pool can even reach
 * it (owner, 2026-08-17). So results are grouped: **this pool's libraries first**, then a rule,
 * then everything else.
 *
 * Within each group the existing rule holds — **collections lead**. That is not cosmetic:
 * typing a franchise name turns up dozens of individual hits, the dropdown caps at 30, and a
 * collection appended after the items was pushed past the cap and never shown at all.
 */

/** The section ids a set actually draws from — show libraries plus item (movie/shorts) ones. */
export function poolSections(
  set: Pick<RegistrySet, "sections" | "item_sections">,
): Set<number> {
  return new Set([
    ...(set.sections || []),
    ...(set.item_sections || []),
  ])
}

export type GroupedHit = {
  hit: SearchHit
  /** Rendered as a rule + heading above this row; only the first of each group carries one. */
  separator: string | null
}

/**
 * Group `hits` into in-pool then out-of-pool, collections first inside each, and mark the
 * first row of each group with the heading that introduces it.
 *
 * A STABLE sort within each bucket, so Plex's own relevance order survives — this reorders
 * by group, never within one.
 */
export function groupHits(
  hits: readonly SearchHit[],
  sections: ReadonlySet<number>,
  labels: { inPool: string; rest: string },
): GroupedHit[] {
  const rank = (hit: SearchHit): number => {
    const isIn = sections.has(hit.sectionId) ? 0 : 2
    return isIn + (hit.type === "collection" ? 0 : 1)
  }
  const sorted = [...hits]
    .map((hit, index) => ({ hit, index, rank: rank(hit) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)

  let seenInPool = false
  let seenRest = false

  return sorted.map(({ hit }) => {
    const isIn = sections.has(hit.sectionId)
    let separator: string | null = null

    // Only label the in-pool group when there is a second group to distinguish it FROM.
    // A search that lands entirely inside the pool is the ordinary case and needs no chrome.
    if (isIn && !seenInPool) {
      seenInPool = true
      separator = sorted.some(
        (s) => !sections.has(s.hit.sectionId),
      )
        ? labels.inPool
        : null
    } else if (!isIn && !seenRest) {
      seenRest = true
      separator = labels.rest
    }

    return { hit, separator }
  })
}

/** A section id → its library name, for the line under a result. */
export function libraryTitle(
  libraries: readonly Library[],
  sectionId: number,
): string {
  return (
    libraries.find((l) => l.id === sectionId)?.title ??
    `Library ${sectionId}`
  )
}

/**
 * What a result calls itself: `Title (Year)`, plus the EDITION when Plex gave it one.
 *
 * Two editions of a film are two library items with the same title and the same year, and
 * only the tagged one names itself — so this is what makes them distinguishable at all.
 */
export function hitLabel(hit: SearchHit): string {
  const year = hit.year ? ` (${hit.year})` : ""
  const edition = hit.editionTitle
    ? ` — ${hit.editionTitle}`
    : ""
  return `${hit.title}${year}${edition}`
}

/**
 * The title a PICK stores in the file — `hitLabel` for an item, the bare name for a
 * collection.
 *
 * A collection is stored as a `{collection: "<name>"}` entry and expanded by NAME, so it must
 * not carry a year or an edition; an item is addressed by `ratingKey` and its title is the
 * human-readable half of the same entry, so it carries both. (Before 2026-08-21 the collection
 * was the literal string `Collection: <name>`. The entry KEY is unchanged either way —
 * `title:Collection: <name>` — which is why `keyOfHit` in the views still spells it that way.)
 *
 * One function because three pickers write the same entry shape — the queue add box, the
 * Home toolbar's add-to-any-queue menu, and the pool member picker. It was copied three
 * times, and only the member picker was updated when the edition arrived (#139), which is
 * exactly how the queue box came to store two editions under one title.
 */
export function entryTitle(hit: SearchHit): string {
  return hit.type === "collection"
    ? hit.title
    : hitLabel(hit)
}
