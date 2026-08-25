/**
 * FLIP for a DRAG, and only for a drag.
 *
 * There used to be two here. `flipPaint` wrapped a REPAINT — React committing a
 * new list — and `hooks/useFlipList.ts` was its React half. Both are gone:
 * `@charcuterie/logic` owns that shape now (`useFlipList`), because Docket needed
 * the same animation and a second copy is how two implementations drift. This app
 * adopts the library's, keyed off the same `data-key` these tiles have always
 * carried. `flipPaint` itself had no callers at all by then.
 *
 * `flipMove` stays, and is NOT the same animation. It wraps a drag's own DOM
 * mutation: it transforms EXISTING nodes only and never re-renders, which is what
 * keeps the mid-drag duplication bug from coming back (the drag inserts a node
 * imperatively — a React re-render underneath it would leave two copies and save a
 * duplicated order). Transform-only also keeps scroll anchoring
 * (`overflow-anchor: none` on the grid/strips) from reflowing the page mid-gesture.
 * See the Pitfall in `docs/web-ui-handoff.md` and decision
 * `2026-07-21-ui-interaction-states-standard`.
 *
 * The library hook cannot do this job: it animates what React re-rendered, and the
 * whole point here is that React must not re-render.
 */

export const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)")
    ?.matches ?? false

/**
 * Records each item's box BEFORE the DOM mutation, applies the inverse transform
 * AFTER, then releases it — so siblings glide instead of snapping. `dragEl` is
 * skipped: it is following the pointer and must not be transformed twice.
 */
/**
 * The frame callback that ends each tile's FLIP, so a re-entrant `flipMove` can cancel it.
 *
 * Keyed by element in a WeakMap rather than held on the node: a tile removed mid-drag should
 * not be kept alive by its own bookkeeping.
 */
const settles = new WeakMap<HTMLElement, number>()

export function flipMove(
  items: HTMLElement[],
  mutate: () => void,
  dragEl: HTMLElement | null,
): void {
  /*
   * `flipPaint` was the only reader of `prefersReducedMotion`, and deleting it
   * would have deleted the only reduced-motion check in this file — while
   * `flipMove` had never had one. So the guard lands here instead of leaving with
   * the function that used to hold it.
   *
   * The mutation still runs. Reduced motion asks for no ANIMATION, not for no
   * re-order: skipping `mutate()` would drop the drag itself.
   */
  if (prefersReducedMotion()) {
    mutate()

    return
  }

  const first = new Map<HTMLElement, DOMRect>()

  for (const el of items)
    first.set(el, el.getBoundingClientRect())

  mutate()

  for (const el of items) {
    if (el === dragEl) continue

    const f = first.get(el)

    if (!f) continue

    const last = el.getBoundingClientRect()
    const dx = f.left - last.left
    const dy = f.top - last.top

    if (!dx && !dy) continue

    // CANCEL this tile's pending settle before starting a new one.
    //
    // Without it, a drag that repositions again mid-settle leaves the OLD frame callback armed
    // — and when it fires it clears the transform the NEW flipMove just set, snapping the tile
    // to its layout box with no transition. Measured on one deliberate drag across a Cards
    // grid: 20 repositions in about half a second, each starting a fresh 180ms glide on ~7
    // tiles, so at any moment several stale cleanups were queued against live transforms. That
    // is the "flashes them around the screen" the owner reported.
    const pending = settles.get(el)

    if (pending != null) cancelAnimationFrame(pending)

    el.style.transition = "none"
    el.style.transform = `translate(${dx}px, ${dy}px)`

    settles.set(
      el,
      requestAnimationFrame(() => {
        settles.delete(el)
        el.style.transition = ""
        el.style.transform = ""
      }),
    )
  }
}

/**
 * After an add re-renders the grid, pull the eye to the affected tile: scroll it
 * into view and pulse it. The resolve round-trip means a new tile can land a beat
 * later and off-screen (the default add is to the top, but the list may be scrolled
 * elsewhere), so a mistaken add was impossible to find. No-op if the tile isn't on
 * the current view.
 */
export function flashTile(
  set: string,
  key: string | null | undefined,
): void {
  if (!key) return

  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(
      `.grid li[data-set="${CSS.escape(String(set))}"][data-key="${CSS.escape(String(key))}"]`,
    )

    if (!el) return

    el.scrollIntoView({
      behavior: "smooth",
      block: "center",
    })
    el.classList.remove("justadded")
    void el.offsetWidth // reflow, so re-adding the class restarts the animation
    el.classList.add("justadded")
    el.addEventListener(
      "animationend",
      () => el.classList.remove("justadded"),
      {
        once: true,
      },
    )
  })
}
