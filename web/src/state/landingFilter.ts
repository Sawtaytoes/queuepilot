/**
 * WHAT THE LANDING IS FILTERED BY, and where that fact lives.
 *
 * Two independent filters, both in the QUERY STRING:
 *
 *   `?people=ada,grace`   who you are looking for — a multi-select over the roster
 *   `?only=kavita`        which backend — one at a time, or all
 *
 * ## Why the query string and not the path
 *
 * A filter is not a level of the hierarchy. Making one a path segment forces a trip back to
 * the root every time it changes, for a distinction the person already knows — the argument
 * that kept `?only=` out of the route on 2026-08-17, applied to the control that replaced
 * the groups. The query string keeps both LINKABLE without making either structural, so
 * `/?people=ada&only=kavita` is a bookmark, a phone home-screen tile and an NFC target.
 *
 * ## Why there is no `localStorage` here, unlike the group bar this replaces
 *
 * `state/group.ts` remembered the last group and answered a bare `/` with it, because a group
 * was a PLACE and landing nowhere in particular was the failure it fixed. A people filter is
 * not a place — it is a search field — and a remembered one is the search field that comes
 * back pre-typed, hiding most of the app on a visit that asked for nothing. So the landing
 * always opens on everything, and the URL is the whole of the truth
 * (decision `2026-08-26-the-landing-filters-by-people-and-the-group-chips-go`).
 *
 * `/g/<id>` is a MOVED PATH now — the legacy route in `App.tsx` rewrites it to `/admin` — so
 * an old bookmark lands on the management page rather than on a filter nothing can turn off.
 */

/** The people ticked, in the order the URL lists them. Empty means NO FILTER AT ALL, which
 *  is the half of the rule the strict reading gets backwards — see `membersMatchPeople`. */
export function parsePeople(search: string): string[] {
  const raw = new URLSearchParams(search).get("people")

  if (!raw) return []

  const seen = new Set<string>()

  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => {
      if (!id || seen.has(id)) return false
      seen.add(id)

      return true
    })
}

/**
 * The provider filter. `all` is spelled as the ABSENCE of the parameter, so the All chip and
 * a URL that never mentioned a provider are the same address rather than two.
 */
export function parseOnly(search: string): string | null {
  const value = new URLSearchParams(search).get("only")

  return value && value !== "all" ? value : null
}

/**
 * The address a filter chip points at: the current query with one thing changed.
 *
 * Every chip is a real `<a href>` — the rule this app has kept since 2026-08-15 — so the
 * href has to be COMPUTED rather than implied by a click handler, and this is the one place
 * that computes it. Both filters survive each other's changes, which is the whole point of
 * having two: ticking a second person must not silently drop the Kavita chip.
 */
export function filterPath(
  basePath: string,
  search: string,
  change: {
    people?: readonly string[]
    only?: string | null
  },
): string {
  const people =
    change.people === undefined
      ? parsePeople(search)
      : change.people
  const only =
    change.only === undefined
      ? parseOnly(search)
      : change.only

  const params = new URLSearchParams()

  if (people.length) params.set("people", people.join(","))
  if (only) params.set("only", only)

  const query = params.toString()

  return query ? `${basePath}?${query}` : basePath
}

/** The selection with one person added or taken away — the href a person chip carries. */
export function togglePerson(
  selected: readonly string[],
  personId: string,
): string[] {
  return selected.includes(personId)
    ? selected.filter((id) => id !== personId)
    : [...selected, personId]
}
