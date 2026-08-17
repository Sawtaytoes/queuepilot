import { type RefObject, useEffect, useRef } from "react"

/**
 * Drag-to-reorder for a vertical list of rows — the Play landing's three shelves.
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
 *   swipe still scrolls the page rather than dragging a row out from under the finger.
 * - Only the **handle** starts a drag. The row is a link and its buttons play things; a
 *   whole-row drag would fight both.
 * - The moved node is **restored to where React last rendered it** before `onCommit` runs, so
 *   React re-renders from a DOM it believes rather than one this hook rearranged behind it.
 *   Skipping that is what produces `NotFoundError` on a later commit.
 *
 * Reordering is transform-only while dragging and a single `insertBefore` per crossing — no
 * layout thrash, and the browser keeps the rows' own transitions.
 */

const DRAG_THRESHOLD = 6
const LONG_PRESS_MS = 200

type Drag = {
  row: HTMLElement
  /** Where React had it, restored before we hand control back. */
  nextSibling: ChildNode | null
  startY: number
  offset: number
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

      const dy = e.clientY - drag.startY

      if (!drag.isDragging) {
        // Touch waits for the long-press timer; a mouse only needs to mean it.
        if (drag.isArmed || Math.abs(dy) < DRAG_THRESHOLD)
          return

        begin()
      }

      e.preventDefault()
      drag.offset = dy
      drag.row.style.transform = `translateY(${dy}px)`

      // Swap when the pointer passes a neighbour's midpoint. Comparing against the MIDPOINT
      // (not the edge) is what stops a row oscillating between two slots on a 1px move.
      const box = drag.row.getBoundingClientRect()
      const midY = box.top + box.height / 2

      for (const other of rows()) {
        if (other === drag.row) continue

        const otherBox = other.getBoundingClientRect()
        const otherMid = otherBox.top + otherBox.height / 2
        const isBefore =
          drag.row.compareDocumentPosition(other) &
          Node.DOCUMENT_POSITION_FOLLOWING

        if (isBefore ? midY > otherMid : midY < otherMid) {
          // Re-anchor: the node moved, so its untransformed origin moved with it and the
          // running offset has to be measured from the new home or the row jumps.
          const beforeTop = box.top

          list.insertBefore(
            drag.row,
            isBefore ? other.nextSibling : other,
          )

          const afterTop =
            drag.row.getBoundingClientRect().top

          drag.startY += afterTop - beforeTop
          drag.row.style.transform = `translateY(${e.clientY - drag.startY}px)`
          break
        }
      }
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
      const handle = (e.target as HTMLElement).closest(
        ".rowdrag",
      )

      if (!handle) return

      const row =
        handle.closest<HTMLElement>("li[data-set]")

      if (!row) return

      e.preventDefault()
      drag = {
        isArmed: e.pointerType === "touch",
        isDragging: false,
        nextSibling: row.nextSibling,
        offset: 0,
        row,
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
 * Splice one shelf's new order back into the FULL set order.
 *
 * `PATCH /api/sets-order` takes the complete order and appends anything it was not told
 * about — so sending one shelf's ids would sweep every other set to the end of `sets.yaml`.
 * Permuting only the slots the shelf's own ids occupy leaves every other row exactly where
 * it was, and is also what makes reordering correct while a GROUP FILTER is on: the hidden
 * rows never move, because their slots are never touched.
 */
export function spliceOrder(
  fullOrder: readonly string[],
  shelfOrder: readonly string[],
): string[] {
  const moving = new Set(shelfOrder)
  let next = 0

  return fullOrder.map((id) =>
    moving.has(id) ? (shelfOrder[next++] as string) : id,
  )
}
