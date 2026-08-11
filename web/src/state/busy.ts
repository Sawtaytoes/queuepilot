/**
 * `uiBusy()` — the single guard that stops a live re-render landing mid-gesture.
 *
 * The bug it exists for shipped once: an SSE-driven refetch replaced the DOM under
 * an in-flight drag, the dragged element was re-inserted beside its fresh copy, and
 * the drop saved a duplicated order. Everything that can be "in the middle of
 * something" registers here, and both `liveRefresh` and the `now` repaint check it
 * before AND after their fetch (the fetch itself takes seconds — a gesture can
 * start during it).
 *
 * Kept as mutable module flags rather than React state on purpose: the callers are
 * an EventSource listener and a `setInterval`, neither of which has a component to
 * read state from, and a stale closure here would silently re-open the bug.
 */
export const busy = {
  /** A queue-grid poster press/drag is live. */
  gridPress: false,
  /** A Home-shelf poster press/drag is live. */
  homePress: false,
  /** A shelf (whole row) reorder is live. */
  shelfDrag: false,
  /** How many tiles are selected — a selection is an edit in progress. */
  selectedCount: 0,
  /** The heading is being renamed inline. */
  headingEdit: false,
  /** How many `<dialog>`s are open. */
  openModals: 0,
}

export function uiBusy(): boolean {
  return Boolean(
    busy.gridPress ||
      busy.homePress ||
      busy.shelfDrag ||
      busy.selectedCount ||
      busy.headingEdit ||
      busy.openModals ||
      // An open search dropdown is a pick in progress; re-rendering under it eats
      // the click. Read from the DOM, as the original did, because the three lists
      // are owned by three different components.
      document.querySelector(
        "#gresults.open, #results.open, #chmresults.open",
      ),
  )
}
