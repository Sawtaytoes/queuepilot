import type { Group, GroupsResponse } from "../lib/types"

/**
 * WHICH GROUP IS ACTIVE, and where that fact lives.
 *
 * **One rule, and everything here is a consequence of it: the URL wins; storage is only a
 * default for a URL that did not say.**
 *
 * `localStorage` alone was the obvious design and fails three ways at once — a group is
 * then not bookmarkable (so it cannot go on a phone home screen), it is per-device (so the
 * TV browser, the phone and the desktop each drift to a different person), and Back does not
 * undo a switch. The path alone fails one way: typing the bare domain lands you nowhere in
 * particular. So the path is the truth and storage answers exactly one question — "what did
 * this device look at last?" — consulted only on `/`.
 *
 * The stored value is a group ID, never a label: ids are immutable and labels are free, the
 * same contract `sets.yaml` keeps.
 */

const KEY = "queuepilot.group"

/** Read the last-used group id. Returns null when storage is unavailable (private mode, a
 * locked-down webview) — a missing preference is not an error, it just means `all`. */
export function lastUsedGroup(): string | null {
  try {
    return window.localStorage.getItem(KEY) || null
  } catch {
    return null
  }
}

/**
 * Remember the group this device is looking at.
 *
 * Called from the route, not from the picker's click handler, so that arriving by ANY
 * route — a bookmark, a link from Home Assistant, Back — updates it. A click handler would
 * record only the switches made inside the app, which is the smaller half.
 */
export function rememberGroup(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(KEY, id)
    else window.localStorage.removeItem(KEY)
  } catch {
    /* storage is a convenience; the URL is the truth */
  }
}

/** The group the given route id names, or null for "all"/unknown. Unknown falls back to
 * everything rather than to an empty page — a stale bookmark to a deleted group should still
 * show the app. */
export function findGroup(
  groups: GroupsResponse | null,
  id: string | null,
): Group | null {
  if (!id || !groups) return null

  return (
    groups.groups.find((g) => g.id === id && !g.isAll) ??
    null
  )
}

/** `/g/<id>`, or `/` for the everything view. The one place the group URL is spelled. */
export function groupPath(
  group: Pick<Group, "id" | "isAll">,
): string {
  return group.isAll
    ? "/"
    : `/g/${encodeURIComponent(group.id)}`
}

/**
 * The provider filter, read off the query string rather than the path.
 *
 * A chip is a FILTER, not a level of the hierarchy — making it a path segment
 * (`/plex/sawtaytoes`) forces a trip back to the root every time the medium changes, for a
 * distinction the person already knows. The query string keeps it linkable without making
 * it structural, so `/g/bob?only=kavita` is still a bookmark.
 */
export function parseOnly(search: string): string | null {
  const value = new URLSearchParams(search).get("only")

  return value && value !== "all" ? value : null
}

/** Build the href for a provider chip on the current group. */
export function onlyPath(
  basePath: string,
  kind: string | null,
): string {
  return kind
    ? `${basePath}?only=${encodeURIComponent(kind)}`
    : basePath
}
