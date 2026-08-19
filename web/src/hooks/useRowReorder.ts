import { type RefObject, useEffect, useRef } from "react"

/**
 * Drag-to-reorder for the Play landing's card grid.
 *
 * The Queues configurator has had this for whole shelves since the beginning
 * (`useHomeDrags`), but only there, and only for Ordered Queues. On the landing — the screen
 * the household actually opens — nothing could be reordered at all, and Curated and Filtered
 * Pools had no reorder anywhere in the app (owner, 2026-08-17: "I also have no way to reorder
 * these items").
 *
 * The gestures follow `useHomeDrags` deliberately, because they are the same gesture:
 *
 * - **Mouse** drags past a small threshold; **touch** arms on a ~200 ms long-press, so a
 *   swipe still scrolls the page rather than dragging a card out from under the finger.
 * - **The whole card starts a drag on a fine pointer**, and only the handle on a coarse one.
 *   The card holds a link and a button, so a press that lands on one of those is left alone;
 *   everything else on the card is grabbable. Touch keeps the handle because whole-card touch
 *   dragging costs the page its scroll surface.
 *   (decision `2026-08-19-the-whole-card-is-the-drag-handle-on-a-fine-pointer`)
 * - The moved node is **restored to where React last rendered it** before `onCommit` runs, so
 *   React re-renders from a DOM it believes rather than one this hook rearranged behind it.
 *   Skipping that is what produces `NotFoundError` on a later commit.
 *
 * Reordering is transform-only while dragging and a single `insertBefore` per crossing — no
 * layout thrash, and the browser keeps the cards' own transitions.
 *
 * **It moves in TWO axes as of 2026-08-19, because the landing is a wrapped grid.** The
 * original compared the dragged row's midpoint against each neighbour's midpoint on Y alone,
 * which is exactly right for a single column and silently wrong for a grid: every card in a
 * row shares a Y midpoint, so dragging sideways swapped with whichever of them happened to
 * come first in the DOM, and dragging up one row picked a card three columns away. The test
 * is containment now — which card is the POINTER inside — which is unambiguous in both
 * layouts and needs no special case for the one-column Narrow View.
 * (decision `2026-08-19-the-landing-is-one-wrapped-grid-of-typed-cards`)
 */

const DRAG_THRESHOLD = 6
const LONG_PRESS_MS = 200

type Drag = {
  row: HTMLElement
  /** Where React had it, restored before we hand control back. */
  nextSibling: ChildNode | null
  /** The pointer's origin, RE-ANCHORED on every move: the node's untransformed home moves
   * when it is spliced elsewhere in the grid, so the running offset has to be measured from
   * the new home on both axes or the card jumps out from under the cursor. */
  startX: number
  startY: number
  isDragging: boolean
  isArmed: boolean
  holdTimer?: ReturnType<typeof setTimeout>
}

export function useRowReorder(
  listRef: RefObject<HTMLElement | null>,
  /** Called with the list's ids in their new order, only when the order actually changed. */
  onCommit: (ids: string[]) => void,
  isEnabled = true,
) {
  // A REAL ref, not a fresh `{ current }` object per render. The effect captures whatever it
  // is handed ONCE, so a plain object would leave the listeners calling the first render's
  // callback for ever — and the first render is exactly the one where `GET /api/sets` has not
  // answered yet, so the commit read an EMPTY set list and bailed. The drag worked, the drop
  // did nothing, and nothing anywhere said why.
  const commitRef = useRef(onCommit)

  commitRef.current = onCommit

  useEffect(() => {
    const list = listRef.current

    if (!list || !isEnabled) return

    let drag: Drag | null = null

    const rows = () => [
      ...list.querySelectorAll<HTMLElement>(
        ":scope > li[data-set]",
      ),
    ]

    const orderNow = () =>
      rows().map((r) => r.dataset.set as string)

    const begin = () => {
      if (!drag) return

      drag.isDragging = true
      drag.row.classList.add("dragging")
      document.body.classList.add("rowdragging")
    }

    const onMove = (e: PointerEvent) => {
      if (!drag) return

      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY

      if (!drag.isDragging) {
        // Touch waits for the long-press timer; a mouse only needs to mean it. The
        // threshold is on the DISTANCE moved, not on dy — a sideways drag in the grid is a
        // real drag and used to have to travel vertically before it counted as one.
        if (
          drag.isArmed ||
          Math.hypot(dx, dy) < DRAG_THRESHOLD
        )
          return

        begin()
      }

      e.preventDefault()
      drag.row.style.transform = `translate(${dx}px, ${dy}px)`

      // The card the POINTER is inside, if any. Containment rather than a midpoint
      // comparison: in a wrapped grid every card in a row shares a midpoint on Y, so the
      // old test could not tell them apart, and the gaps between cards mean "over nothing"
      // is a real answer that should move nothing.
      const target = rows().find((other) => {
        if (other === drag?.row) return false

        const r = other.getBoundingClientRect()

        return (
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom
        )
      })

      if (!target) return

      const before = drag.row.getBoundingClientRect()
      const isBefore =
        drag.row.compareDocumentPosition(target) &
        Node.DOCUMENT_POSITION_FOLLOWING

      list.insertBefore(
        drag.row,
        isBefore ? target.nextSibling : target,
      )

      // Re-anchor: the node moved, so its untransformed origin moved with it.
      const after = drag.row.getBoundingClientRect()

      drag.startX += after.left - before.left
      drag.startY += after.top - before.top
      drag.row.style.transform = `translate(${e.clientX - drag.startX}px, ${e.clientY - drag.startY}px)`
    }

    const finish = () => {
      if (!drag) return

      const { isDragging, nextSibling, row } = drag

      if (drag.holdTimer) clearTimeout(drag.holdTimer)

      drag = null
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", finish)
      row.style.transform = ""
      row.classList.remove("dragging")
      document.body.classList.remove("rowdragging")

      if (!isDragging) return

      const next = orderNow()

      // Put the node back where React last rendered it BEFORE the state update, so React
      // reconciles against the DOM it produced rather than the one this hook rearranged.
      list.insertBefore(row, nextSibling)
      commitRef.current(next)
    }

    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement
      const handle = target.closest(".rowdrag")
      const row =
        target.closest<HTMLElement>("li[data-set]")

      if (!row) return

      /**
       * **Touch must use the handle; a pointer may grab the card anywhere.**
       *
       * Whole-card dragging by touch means `touch-action: none` on the card — and the card
       * is the surface the page is scrolled by, so the landing would stop scrolling under a
       * finger. Only `.rowdrag` opts out of scrolling, which is why it is still rendered on
       * a coarse pointer and why touch is still required to start there.
       */
      if (e.pointerType === "touch" && !handle) return

      /**
       * A press that lands on something you CLICK is not a drag. The card holds a link (the
       * name) and a button (Play on), and on a filtered pool a listbox as well — grabbing
       * those would fight the thing they are for. This is what makes "the whole card is the
       * handle" safe; the 6px threshold below is what keeps a plain click a click.
       */
      if (
        !handle &&
        target.closest(
          'a, button, input, select, textarea, [role="combobox"], [role="listbox"]',
        )
      )
        return

      // Not on an interactive child, so nothing here wants the browser's default — and the
      // default is a text selection that would drag a highlight across the page instead.
      e.preventDefault()
      drag = {
        isArmed: e.pointerType === "touch",
        isDragging: false,
        nextSibling: row.nextSibling,
        row,
        startX: e.clientX,
        startY: e.clientY,
      }

      if (drag.isArmed) {
        drag.holdTimer = setTimeout(() => {
          if (!drag) return

          drag.isArmed = false
          begin()
        }, LONG_PRESS_MS)
      }

      window.addEventListener("pointermove", onMove, {
        passive: false,
      })
      window.addEventListener("pointerup", finish)
      window.addEventListener("pointercancel", finish)
    }

    list.addEventListener("pointerdown", onDown)

    return () => {
      list.removeEventListener("pointerdown", onDown)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", finish)
      document.body.classList.remove("rowdragging")
    }
  }, [isEnabled, listRef])
}

/**
 * Splice the grid's new order back into the FULL set order.
 *
 * `PATCH /api/sets-order` takes the complete order and appends anything it was not told
 * about — so sending only what is on screen would sweep every other set to the end of
 * `sets.yaml`. Permuting only the slots the visible cards occupy leaves every other set
 * exactly where it was, which is what makes reordering correct while a GROUP or PROVIDER
 * FILTER is on: the hidden cards never move, because their slots are never touched.
 *
 * This mattered for three separate shelves before the landing became one grid, and it still
 * matters for one grid, for the filter reason alone.
 */
export function spliceOrder(
  fullOrder: readonly string[],
  visibleOrder: readonly string[],
): string[] {
  const moving = new Set(visibleOrder)
  let next = 0

  return fullOrder.map((id) =>
    moving.has(id) ? (visibleOrder[next++] as string) : id,
  )
}
