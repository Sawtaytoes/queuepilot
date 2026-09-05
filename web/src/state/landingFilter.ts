/**
 * WHAT THE LANDING IS FILTERED BY, and where that fact lives.
 *
 * Two independent filters, both in the QUERY STRING:
 *
 *   `?people=ada,grace`   who you are looking for — a multi-select over the roster
 *   `?only=kavita,plex`   which backends — a multi-select too, empty meaning all of them
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

/** A comma list from the query, de-duplicated, in the order the URL gives it. */
function parseList(search: string, key: string): string[] {
  const raw = new URLSearchParams(search).get(key)

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

/** The people ticked, in the order the URL lists them. Empty means NO FILTER AT ALL, which
 *  is the half of the rule the strict reading gets backwards — see `membersMatchPeople`. */
export function parsePeople(search: string): string[] {
  return parseList(search, "people")
}

/**
 * The provider filter — a LIST since 2026-09-05, where it used to be one kind or nothing.
 *
 * All is still spelled as the ABSENCE of the parameter, so the unfiltered address and a URL
 * that never mentioned a provider stay the same address rather than two. `?only=all` was the
 * old spelling of the same thing and keeps parsing to "no filter", and a single
 * `?only=kavita` — every provider link this app ever wrote — is just a one-item list, so no
 * bookmark, home-screen tile or NFC target had to change
 * (`2026-08-17`'s rule that a moved address keeps working).
 */
export function parseProviders(search: string): string[] {
  return parseList(search, "only").filter(
    (kind) => kind !== "all",
  )
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
    only?: readonly string[]
  },
): string {
  const people =
    change.people === undefined
      ? parsePeople(search)
      : change.people
  const only =
    change.only === undefined
      ? parseProviders(search)
      : change.only

  const params = new URLSearchParams()

  if (people.length) params.set("people", people.join(","))
  if (only.length) params.set("only", only.join(","))

  const query = params.toString()

  return query ? `${basePath}?${query}` : basePath
}

/**
 * The selection with one value added or taken away — the href a chip carries.
 *
 * One function for BOTH filters since the provider row became multi-select: a person chip
 * and a provider chip do exactly the same thing to their own list, and two copies of this
 * would be two places for the de-duplication to drift.
 */
export function toggleValue(
  selected: readonly string[],
  value: string,
): string[] {
  return selected.includes(value)
    ? selected.filter((id) => id !== value)
    : [...selected, value]
}
