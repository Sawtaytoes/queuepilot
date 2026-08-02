/**
 * FLIP, twice — and they are not the same animation.
 *
 * `flipPaint` wraps a REPAINT (React committing a new list): persisting tiles,
 * matched by `data-key`, glide from their old box to the new one and fresh tiles
 * fade in, so add/remove/reorder reads as motion rather than a snap. It runs the
 * Web Animations API, which does not touch inline styles and therefore cannot leak
 * a transform onto a node React later reuses.
 *
 * `flipMove` wraps a DRAG's own DOM mutation: it transforms EXISTING nodes only and
 * never re-renders, which is what keeps the mid-drag duplication bug from coming
 * back (the drag inserts a node imperatively — a React re-render underneath it
 * would leave two copies and save a duplicated order). Transform-only also keeps
 * scroll anchoring (`overflow-anchor: none` on the grid/strips) from reflowing the
 * page mid-gesture. See the Pitfall in `docs/web-ui-handoff.md` and decision
 * `2026-07-21-ui-interaction-states-standard`.
 */

export const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false

/**
 * Measure `container`'s tiles, run `build` (the DOM write), then animate each tile
 * from where it was to where it now is.
 */
export function flipPaint(
  container: HTMLElement | null,
  build: () => void,
  animate: boolean,
): void {
  if (!container || !animate || prefersReducedMotion()) {
    build()

    return
  }

  const before = new Map<string, DOMRect>()

  for (const t of container.querySelectorAll<HTMLElement>("li.tile")) {
    if (t.dataset.key) before.set(t.dataset.key, t.getBoundingClientRect())
  }

  build()

  for (const t of container.querySelectorAll<HTMLElement>("li.tile")) {
    const a = t.getBoundingClientRect()
    const b = t.dataset.key ? before.get(t.dataset.key) : undefined

    if (!b) {
      t.animate(
        [
          { opacity: 0, transform: "scale(0.92)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 180, easing: "ease-out" },
      )

      continue
    }

    const dx = b.left - a.left
    const dy = b.top - a.top

    if (dx || dy) {
      t.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: "none" },
        ],
        { duration: 240, easing: "cubic-bezier(.2,.7,.3,1)" },
      )
    }
  }
}

/**
 * Records each item's box BEFORE the DOM mutation, applies the inverse transform
 * AFTER, then releases it — so siblings glide instead of snapping. `dragEl` is
 * skipped: it is following the pointer and must not be transformed twice.
 */
export function flipMove(
  items: HTMLElement[],
  mutate: () => void,
  dragEl: HTMLElement | null,
): void {
  const first = new Map<HTMLElement, DOMRect>()

  for (const el of items) first.set(el, el.getBoundingClientRect())

  mutate()

  for (const el of items) {
    if (el === dragEl) continue

    const f = first.get(el)

    if (!f) continue

    const last = el.getBoundingClientRect()
    const dx = f.left - last.left
    const dy = f.top - last.top

    if (!dx && !dy) continue

    el.style.transition = "none"
    el.style.transform = `translate(${dx}px, ${dy}px)`

    requestAnimationFrame(() => {
      el.style.transition = ""
      el.style.transform = ""
    })
  }
}

/**
 * After an add re-renders the grid, pull the eye to the affected tile: scroll it
 * into view and pulse it. The resolve round-trip means a new tile can land a beat
 * later and off-screen (the default add is to the top, but the list may be scrolled
 * elsewhere), so a mistaken add was impossible to find. No-op if the tile isn't on
 * the current view.
 */
export function flashTile(set: string, key: string | null | undefined): void {
  if (!key) return

  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(
      `.grid li[data-set="${CSS.escape(String(set))}"][data-key="${CSS.escape(String(key))}"]`,
    )

    if (!el) return

    el.scrollIntoView({ behavior: "smooth", block: "center" })
    el.classList.remove("justadded")
    void el.offsetWidth // reflow, so re-adding the class restarts the animation
    el.classList.add("justadded")
    el.addEventListener("animationend", () => el.classList.remove("justadded"), {
      once: true,
    })
  })
}
