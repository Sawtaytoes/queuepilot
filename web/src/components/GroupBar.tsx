import { Link } from "react-router"

import type { Group } from "../lib/types"
import { groupPath, onlyPath } from "../state/group"
import { openGroupsModal } from "../state/overlays"

/**
 * WHO IS WATCHING — the row of groups at the top of the landing, and the provider filter
 * under it.
 *
 * **Chips rather than a dropdown, and every one of them is a real `<a href>`.** A dropdown
 * hides the list behind a tap and tells you nothing until you open it; the whole point of
 * this control is to make "most of this is mine, four pools are the kids'" visible at a
 * glance. Links because that is what these are — each group is an address — so
 * middle-click, ⌘-click, "copy link" and the status-bar preview all come for free
 * (decision `2026-08-15-navigation-is-an-anchor-not-a-button`).
 *
 * The provider row only appears when the CURRENT group actually spans more than one backend.
 * Offering "Plex / Kavita" to someone whose whole group is Plex is a control that can only
 * ever be a no-op or an empty page.
 */
export function GroupBar({
  activeId,
  basePath,
  only,
  groups,
  providerKinds,
  countFor,
  labelForKind,
}: {
  /** The active group's id, or null for the everything view. */
  activeId: string | null
  /** The path the provider chips hang off — `/` or `/g/<id>`, without the query. */
  basePath: string
  /** The active provider filter, or null for all. */
  only: string | null
  groups: Group[]
  /** Provider kinds available in the ACTIVE group, in registry order. */
  providerKinds: string[]
  /** How many sets a group holds, after the provider filter. */
  countFor: (group: Group) => number
  /**
   * A provider kind's display name.
   *
   * Passed in rather than mapped here, because the answer already exists: every set carries
   * its provider's `vocabulary.name` (the same slot that rewrites "Plex" in authored copy),
   * and only the caller holds the registry. A local `{plex: "Plex", kavita: "Kavita"}` would
   * be a second list to remember when a fourth backend lands.
   */
  labelForKind: (kind: string) => string
}) {
  if (!groups.length) return null

  return (
    <nav aria-label="Group" className="groupbar">
      <ul className="groupchips" id="groupchips">
        {groups.map((group) => {
          const isActive = group.isAll
            ? !activeId
            : group.id === activeId
          const count = countFor(group)

          return (
            <li key={group.id}>
              <Link
                aria-current={isActive ? "page" : undefined}
                className="groupchip"
                // The provider filter is deliberately DROPPED when switching group:
                // `?only=kavita` on a group with no Kavita is an empty page, and the
                // filter is a property of what you are looking at, not of you.
                to={groupPath(group)}
              >
                {group.label}
                <span className="groupcount">{count}</span>
              </Link>
            </li>
          )
        })}
        <li>
          {/* The editor opens on the group you are LOOKING AT, so "these chips are wrong"
              and "fix this chip" are one gesture rather than two. */}
          <button
            className="groupchip groupedit"
            id="groupsedit"
            onClick={() => openGroupsModal(activeId)}
            type="button"
          >
            ⚙ Edit groups
          </button>
        </li>
      </ul>

      {providerKinds.length > 1 ? (
        <ul
          className="groupchips providerchips"
          id="providerchips"
        >
          <li>
            <Link
              aria-current={only ? undefined : "page"}
              className="groupchip"
              to={onlyPath(basePath, null)}
            >
              All
            </Link>
          </li>
          {providerKinds.map((kind) => (
            <li key={kind}>
              <Link
                aria-current={
                  only === kind ? "page" : undefined
                }
                className="groupchip"
                // The chip wears the backend's own colour, same rule as every other
                // provider-owned control on the page.
                data-provider={kind}
                to={onlyPath(basePath, kind)}
              >
                {labelForKind(kind)}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </nav>
  )
}
