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
  /** The latest pointer position, read once per frame instead of once per event. */
  at?: { x: number; y: number }
  /** The pending reposition frame, so a burst of moves schedules exactly one. */
  frame?: number
  /** Where React last rendered this node, so it can be put back before setState. */
  parent: HTMLElement | null
  nextSibling: ChildNode | null
}

export function useGridDrag(
  gridRef: RefObject<HTMLElement | null>,
  currentSet: string | null,
  isChannel: boolean,
  /**
   * A tap on a poster while NOTHING is selected — open this entry.
   *
   * That gesture was dead before: the comment in `onUp` said a plain poster tap
   * "does nothing" until move mode is on, which left the largest target on the tile
   * doing less than the 26px ▶ sitting in the middle of it. The owner picked "tap the
   * poster opens the entry" over "tap plays it", so the sheet is where playing,
   * editing, choosing a start point and removing all live at full size.
   * (decision `2026-08-17-a-poster-tap-opens-the-entry-sheet`)
   *
   * Ordering matters and is why this is here rather than an `onClick` on the tile: a
   * DRAG must never also open the sheet, and only this hook knows whether the press
   * moved. Move mode still wins — with a selection running, a tap keeps toggling it.
   */
  onOpenEntry?: (setId: string, key: string) => void,
) {
  // `onOpenEntry` is deliberately absent from the dependency list. This effect installs
  // imperative pointer listeners that must survive a re-render — re-running it on every
  // new callback identity would tear them down mid-gesture, which is the same class of
  // bug as the re-render-during-drag this hook's header documents. The one value passed
  // in is `openEntryEditor`, a module-level store action with a stable identity, so the
  // closure cannot go stale.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const grid = gridRef.current

    if (!grid) return

    let press: Press | null = null

    const beginDrag = () => {
      // A channel's member order is irrelevant — there is nothing to reorder.
      if (isChannel || !press) return

      press.isDragging = true
      // BEFORE the dragging class lands: the class lifts the tile (scale/rotate on .thumb) but
      // not its slot, and capturing first keeps the snapshot free of any of the drag's own
      // styling.
      captureSlots()
      press.card.classList.add("dragging")
      document.body.classList.add("gdrag") // enables the sibling glide transition
    }

    const endPress = () => {
      if (press?.holdTimer) clearTimeout(press.holdTimer)
      // Drop the queued reposition too, or a frame that lands after the pointer is up moves
      // the tile once more and the saved order is not the one on screen.
      if (press?.frame != null)
        cancelAnimationFrame(press.frame)

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

      // COALESCE to one reposition per animation frame. `pointermove` fires far faster than
      // the screen repaints — a deliberate half-second drag across the Cards grid measured 20
      // reorders, each starting a 180ms glide on ~7 tiles while the previous glides were still
      // running. The gesture cannot look settled if it is restarted more often than it is
      // drawn, so the handler now only records where the pointer IS and the work happens once
      // per frame.
      press.at = { x: e.clientX, y: e.clientY }

      if (press.frame != null) return

      press.frame = requestAnimationFrame(() => {
        if (press) press.frame = undefined
        reposition()
      })
    }

    /**
     * The grid's SLOTS, captured once when the drag arms.
     *
     * This is the fix for the ping-pong, and the reason a live measurement cannot work. The
     * dragged tile stays IN FLOW (that is deliberate — decision
     * `2026-07-21-ui-interaction-states-standard` keeps the drag transform-only so scroll
     * anchoring never reflows the page). So wherever it is placed, every sibling after it
     * shifts by one slot — which moves the very tiles the next decision is measured against.
     * Insert at 2, the neighbours slide, the nearest tile is now a different one, insert back
     * at 0, they slide back. Instrumented on a two-row Cards drag: 0-2-0-2-0-2-3-2, twenty-two
     * direction reversals in twenty-three steps.
     *
     * The SLOTS, though, do not move. Reordering the same N tiles leaves the same N cells in
     * the same places — only which tile sits in which cell changes. So the pointer is compared
     * against geometry that the drag cannot disturb, and the loop is gone.
     */
    let slots: DOMRect[] = []

    const captureSlots = () => {
      slots = [
        ...grid!.querySelectorAll<HTMLElement>("li.tile"),
      ].map((t) => t.getBoundingClientRect())
    }

    /** Move the dragged tile to wherever the latest pointer position says it belongs. */
    function reposition() {
      if (!press?.isDragging || !press.at || !slots.length)
        return

      const { x: px, y: py } = press.at

      // Which slot is the pointer in? Nearest CENTRE, measured in slot widths and heights
      // rather than pixels: a Posters tile is roughly square but a Cards tile is 438 x 136, so
      // a raw hypot is three times more sensitive horizontally and aiming at the row above
      // barely registers against a neighbour in the same row.
      let index = 0
      let bestDist = Infinity

      for (let i = 0; i < slots.length; i += 1) {
        const r = slots[i]!
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const d = Math.hypot(
          (px - cx) / Math.max(1, r.width),
          (py - cy) / Math.max(1, r.height),
        )

        if (d < bestDist) {
          bestDist = d
          // Past the slot's own centre horizontally means the tile belongs AFTER it.
          index = px > cx ? i + 1 : i
        }
      }

      // `index` is where the card should sit among ALL tiles, so it addresses the sibling list
      // directly: inserting before the Nth sibling puts the card at overall position N,
      // wherever it happens to be right now.
      const others = [
        ...grid!.querySelectorAll<HTMLElement>(
          "li.tile:not(.dragging)",
        ),
      ]
      const ref = others[index] ?? null

      if (
        ref === press.card ||
        ref === press.card.nextElementSibling
      )
        return

      flipMove(
        others,
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
        const { key, set } = card.dataset

        if (!set || !key) return

        // "Move mode": once something is checked, a plain poster tap toggles it
        // too, so a whole run can be selected without hunting for checkboxes.
        if (busy.selectedCount > 0) {
          toggleSelect(set, key)

          return
        }

        // Otherwise the tap opens this entry. Reached only when the press did NOT
        // move past the threshold, so a drag can never land here.
        onOpenEntry?.(set, key)

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
        target.closest(".check") ||
        // `.tileplay` is the one control that lives INSIDE `.thumb`, so unlike ✓ and ✕
        // it is not excluded by the poster test below. It has to be named here and not
        // left to its own `stopPropagation`: that stops the CLICK, while this gesture is
        // built on pointerdown/pointerup listeners bound to the window, which a click
        // handler cannot reach. Without this, ▶ opened the device menu and the entry
        // sheet on top of it, from one tap.
        target.closest(".tileplay")
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
