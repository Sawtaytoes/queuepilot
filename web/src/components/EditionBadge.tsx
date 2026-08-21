import type { SearchHit } from "../lib/types"

type Props = {
  /** The hit whose edition to name. */
  hit: Pick<SearchHit, "editionTitle">
}

/**
 * Plex's EDITION label on a search-result row, when the item has one.
 *
 * Two editions of a film are two library items with the same title and the same year, so a
 * row without this is character-for-character identical to its twin and the picker cannot be
 * used at all. Only the tagged item names itself — the plain edition renders nothing rather
 * than inventing a "Standard" label Plex never wrote, which is why this returns `null`
 * instead of a placeholder.
 *
 * A component rather than a fourth copy of the same `<span>`: every `SearchDropdown` caller
 * needs it (the queue add box, the Home toolbar, the pool member picker, the Blocked picker),
 * and when it was inline only ONE of them got it (#139 — the member picker).
 */
export function EditionBadge({ hit }: Props) {
  if (!hit.editionTitle) return null

  return (
    <span className="editionbadge">{hit.editionTitle}</span>
  )
}
