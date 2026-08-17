/**
 * WHAT A ROW IS CALLED, given where you are looking at it from.
 *
 * Every queue in this house is named `<who> — <what>`: `Bob & Alice — Anime`,
 * `Family — Movies`, `Bob — Anime`. That was the only place ownership was recorded, so the
 * label had to carry it. Now the group does, and inside `Bob & Alice` a row that repeats
 * `Bob & Alice —` is saying the heading twice and burying the one word that distinguishes
 * it from the row beside it:
 *
 *     Bob & Alice                        Bob & Alice
 *     ├─ Bob & Alice — Anime      →      ├─ Anime
 *     └─ Bob & Alice — Movies            └─ Movies
 *
 * So the group's own name comes OFF the row while you are inside that group, and stays on
 * everywhere else — the All view, the queue page, the header, `sets.yaml`.
 *
 * **Nothing is renamed.** This is a display rule, not a migration: the stored label is
 * untouched, so an NFC card, an HA automation, a bookmark and the Ordered Queues editor all
 * keep seeing the full name. Turning the group filter off restores it in the same render.
 */

/**
 * The separators a `<who> — <what>` label may use.
 *
 * Em dash first because that is what every existing label uses. The other two are here
 * because the labels are typed by hand into a text field and nobody is going to reach for
 * the em dash reliably; a hyphen-separated `Bob - Anime` should shorten too, or the rule
 * looks broken for the next queue he names.
 *
 * ORDER MATTERS: longest first, so ` — ` is not matched by the ` - ` pattern's prefix.
 */
const SEPARATORS = [" — ", " – ", " - "]

/** Compare the way a person would: case and surrounding space are not the name. */
const same = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * `label` with `groupLabel —` stripped from the front, or `label` unchanged.
 *
 * Returns the ORIGINAL whenever stripping would be wrong or useless:
 *  - no group in context (the All view),
 *  - the label has no separator (`Manga & Webtoons`, `Shows & Shorts`),
 *  - the prefix is some other name (`Bob & Dave — Movies` seen inside `Bob`),
 *  - the remainder would be empty (a label that IS the group's name plus a dangling dash).
 *
 * That last one is the reason this returns a string rather than a nullable: a row with no
 * name is worse than a row with a redundant one.
 */
export function labelInGroup(
  label: string,
  groupLabel: string | null | undefined,
): string {
  if (!groupLabel || !label) return label

  for (const separator of SEPARATORS) {
    const at = label.indexOf(separator)

    if (at < 0) continue
    if (!same(label.slice(0, at), groupLabel)) continue

    const rest = label.slice(at + separator.length).trim()

    return rest || label
  }

  return label
}
