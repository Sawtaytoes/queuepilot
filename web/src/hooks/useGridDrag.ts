import { type RefObject, useEffect } from "react"

import { api } from "../lib/api"
import { flipMove } from "../lib/flip"
import { busy } from "../state/busy"
import { toggleSelect } from "../state/selection"
import {
  bumpRevision,
  getState,
  load,
  setStatus,
} from "../state/store"

/**
 * The queue grid's whole-poster gesture: **tap = select, drag = reorder.**
 *
 * The ENTIRE poster is the drag surface (no tiny grip). A press that moves past a
 * small threshold becomes a drag; a press that doesn't is a tap. On touch we wait
 * for a short long-press before arming, so a quick vertical swipe still scrolls the
 * grid instead of dragging it.
 * (decision `2026-07-20-queue-web-ui-ux-and-write-format`)
 *
 * Why this stays imperative in a React port
 * -----------------------------------------
 * The drag moves ONE node with `insertBefore` and lets `flipMove` glide the
 * siblings via transforms. It deliberately never re-renders: a re-render mid-drag
 * re-inserts the dragged element beside its fresh copy and the drop then saves a
 * duplicated order — that bug shipped once, and `2026-07-21-ui-interaction-states-standard`
 * records the rule ("use transform-only FLIP, never a re-render, during drag").
 *
 * The one thing React adds: because the gesture mutated the DOM behind React's
 * back, the dragged node is put BACK where React last rendered it before state is
 * updated. React then performs the reorder itself from a DOM it believes, which is
 * the only way to avoid a stale-fiber `insertBefore`. The restore is invisible —
 * the optimistic state update lands in the same tick.
 */

const DRAG_THRESHOLD = 6

type Press = {
  card: HTMLElement
  x: number
  y: number
  type: string
  isDragging: boolean
  isArmed: boolean
  holdTimer?: ReturnType<typeof setTimeout>
  /** Where React last rendered this node, so it can be put back before setState. */
  parent: HTMLElement | null
  nextSibling: ChildNode | null
}

export function useGridDrag(
  gridRef: RefObject<HTMLElement | null>,
  currentSet: string | null,
  isChannel: boolean,
) {
  useEffect(() => {
    const grid = gridRef.current

    if (!grid) return

    let press: Press | null = null

    const beginDrag = () => {
      // A channel's member order is irrelevant — there is nothing to reorder.
      if (isChannel || !press) return

      press.isDragging = true
      press.card.classList.add("dragging")
      document.body.classList.add("gdrag") // enables the sibling glide transition
    }

    const endPress = () => {
      if (press?.holdTimer) clearTimeout(press.holdTimer)

      document.body.classList.remove("gdrag")
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
      press = null
      busy.gridPress = false
    }

    function onMove(e: PointerEvent) {
      if (!press) return

      if (!press.isDragging) {
        const isFar =
          Math.hypot(
            e.clientX - press.x,
            e.clientY - press.y,
          ) > DRAG_THRESHOLD

        if (press.type === "touch") {
          // Moved before the long-press armed → it's a scroll, let go.
          if (!press.isArmed) {
            if (isFar) endPress()

            return
          }
        } else if (isFar) {
          beginDrag()
        } else {
          return
        }

        if (!press.isDragging) return
      }

      e.preventDefault()

      // Wrapped grid: drop next to the tile whose CENTER is nearest the pointer, on
      // whichever side the pointer is. The old "first tile whose midpoint is right
      // of the cursor" scan fell through to the end whenever you dropped on the
      // right side of a row, dumping the poster at the bottom.
      const tiles = [
        ...grid!.querySelectorAll<HTMLElement>(
          "li.tile:not(.dragging)",
        ),
      ]

      if (!tiles.length) return

      let best: HTMLElement | null = null
      let bestDist = Infinity
      let isAfter = false

      for (const t of tiles) {
        const r = t.getBoundingClientRect()
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const d = Math.hypot(e.clientX - cx, e.clientY - cy)

        if (d < bestDist) {
          bestDist = d
          best = t
          isAfter = e.clientX > cx
        }
      }

      if (!best) return

      const ref = isAfter ? best.nextElementSibling : best

      if (
        ref === press.card ||
        ref === press.card.nextElementSibling
      )
        return

      flipMove(
        tiles,
        () => grid!.insertBefore(press!.card, ref),
        press.card,
      )
    }

    async function onUp() {
      if (!press) return

      const { card, isDragging, nextSibling, parent } =
        press

      endPress()

      if (!isDragging) {
        // "Move mode": once something is checked, a plain poster tap toggles it
        // too. Before that, a poster tap does nothing (the checkbox is the only
        // selector), so a click that doesn't move is never mistaken for a
        // selection instead of a drag.
        if (
          busy.selectedCount > 0 &&
          card.dataset.set &&
          card.dataset.key
        ) {
          toggleSelect(card.dataset.set, card.dataset.key)
        }

        return
      }

      card.classList.remove("dragging")

      const keys = [
        ...grid!.querySelectorAll<HTMLElement>("li.tile"),
      ].map((li) => li.dataset.key!)

      // Hand the DOM back to React, then let the optimistic state update repaint
      // it in the new order within the same tick.
      parent?.insertBefore(card, nextSibling)

      const set = currentSet

      if (!set) return

      const q = getState().data?.sets[set]

      if (q) {
        const byKey = new Map(
          q.items.map((it) => [it.key, it]),
        )

        q.items = keys
          .map((k) => byKey.get(k)!)
          .filter(Boolean)
        bumpRevision()
      }

      setStatus("Saving order…")

      try {
        await api("PATCH", `/api/queues/${set}/order`, {
          keys,
        })
        setStatus("Order saved", "ok")
      } catch (e) {
        setStatus(
          `Reorder failed: ${(e as Error).message}`,
          "err",
        )
        await load()
      }
    }

    // The one thing that beats `touch-action: pan-y`: a non-passive touchmove.
    // Once a touch drag is live, `preventDefault` on the POINTER move is not enough
    // — the spec lets the browser keep the pan-y (vertical) axis for native scroll,
    // so dragging BETWEEN ROWS (vertical motion) was stolen by the scroller and, on
    // a touch-only device like a Windows tablet, every drag just scrolled. The Home
    // shelves already carry this exact listener; the grid needs it too.
    const onTouchMove = (e: TouchEvent) => {
      if (press?.isDragging) e.preventDefault()
    }

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement

      if (
        target.closest(".remove") ||
        target.closest(".check")
      )
        return // their own clicks
      if (!target.closest(".thumb")) return // drag/select only from the poster

      const card = target.closest<HTMLElement>("li.tile")

      if (!card) return
      // Finished tiles are inert (remove via × / the "Remove all completed" button).
      if (card.classList.contains("done")) return

      // Mouse/pen: suppress the native image drag + text selection so our gesture
      // owns the press. Touch must NOT preventDefault here — the browser needs it
      // to pan/scroll until we arm.
      if (e.pointerType !== "touch") e.preventDefault()

      press = {
        card,
        isArmed: e.pointerType !== "touch",
        isDragging: false,
        nextSibling: card.nextSibling,
        parent: card.parentElement,
        type: e.pointerType,
        x: e.clientX,
        y: e.clientY,
      }
      busy.gridPress = true

      if (e.pointerType === "touch") {
        press.holdTimer = setTimeout(() => {
          if (press) {
            press.isArmed = true
            beginDrag()
          }
        }, 200)
      }

      window.addEventListener("pointermove", onMove, {
        passive: false,
      })
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", onUp)
    }

    // Kill any native drag that starts inside the grid (poster images are draggable
    // by default; a native image drag pre-empts the pointer-drag with a
    // pointercancel).
    const onDragStart = (e: Event) => e.preventDefault()
    // The long-press that arms a touch drag must not also pop the native context
    // menu over the poster. A right-click elsewhere on the tile opens OUR menu.
    const onContextMenu = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".thumb"))
        e.preventDefault()
    }

    grid.addEventListener("pointerdown", onPointerDown)
    grid.addEventListener("touchmove", onTouchMove, {
      passive: false,
    })
    grid.addEventListener("dragstart", onDragStart)
    grid.addEventListener("contextmenu", onContextMenu)

    return () => {
      grid.removeEventListener("pointerdown", onPointerDown)
      grid.removeEventListener("touchmove", onTouchMove)
      grid.removeEventListener("dragstart", onDragStart)
      grid.removeEventListener("contextmenu", onContextMenu)
      endPress()
    }
  }, [currentSet, gridRef, isChannel])
}
