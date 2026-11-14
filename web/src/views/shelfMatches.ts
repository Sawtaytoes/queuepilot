/**
 * A shelf matches the filter on either of its NAMES, or on any title inside it.
 *
 * TWO names since WP-5, and both are searched on purpose. The displayed name is the activity
 * ("Movies & Shows"), which is what somebody reads on screen; the registry's `label` is the
 * hand-typed string that WP-5 migrated FROM and no longer shows. Dropping the second would
 * make typing "manga" stop finding the queue the owner named that, on the day the name
 * disappeared from the screen — a search that used to work and quietly does not.
 */
export function shelfMatches(
  filter: string,
  names: readonly string[],
  items: { title?: string }[],
) {
  if (!filter) return true

  const lowerFilter = filter.toLowerCase()

  if (
    names.some((name) =>
      name.toLowerCase().includes(lowerFilter),
    )
  )
    return true

  return items.some((it) =>
    (it.title || "").toLowerCase().includes(lowerFilter),
  )
}
