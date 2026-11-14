import { ROUTE_PATHS } from "../lib/routePaths"
import { PeoplePage } from "./PeoplePage"
import { useCanonicalPath } from "./useCanonicalPath"

/**
 * `/g/<group>`, which no longer exists. The tail is deliberately DROPPED: there is no
 * per-group address to move a group id to. The people filter is not a translation of a group
 * — a group is a saved set of people, and picking the same people by hand is a different
 * assertion — so guessing one would be worse than landing on everything.
 */
export function LegacyGroupPage() {
  useCanonicalPath(ROUTE_PATHS.people)

  return <PeoplePage />
}
