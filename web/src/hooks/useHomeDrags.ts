import { type RefObject, useEffect } from "react"

import { api } from "../lib/api"
import { flipMove } from "../lib/flip"
import { busy } from "../state/busy"
import { refreshData } from "../state/live"
import { bumpRevision, getState, load, setStatus } from "../state/store"

/**
 * The two Home gestures, both on the shelves container:
 *
 * 1. **Shelf reorder** — drag the ≡ handle vertically to reorder whole queues.
 * 2. **Poster drag** — reorder WITHIN a shelf, or drop onto another shelf to MOVE
 *    the title between queues. The hovered shelf highlights and the tile inserts at
 *    the horizontally-nearest slot.
 *
 * Both use the same press model as the grid (mouse: past threshold = drag; touch:
 * ~200 ms long-press arms, so a swipe still scrolls), both auto-scroll the page near
 * its edges so a shelf or a poster can travel further than one screen, and both are
 * transform-only + single-node `insertBefore` for the reason `useGridDrag` documents
 * at length.
 *
 * Two React-specific details:
 *
 * - The dragged node is restored to where React last rendered it before any state
 *   update, so React reorders from a DOM it believes.
 * - The empty-shelf placeholder is **hidden, not removed**. The vanilla code did
 *   `target.querySelector('.empty')?.remove()` when dropping into an empty queue;
 *   removing a React-owned node makes React's next commit throw `NotFoundError` on
 *   `removeChild`. Hiding it looks identical and leaves the tree intact.
 */

const DRAG_THRESHOLD = 6

type ShelfDrag = {
  shelf: HTMLElement
  nextSibling: ChildNode | null
}

type HomePress = {
  card: HTMLElement
  fromSet: string
  x: number
  y: number
  type: string
  isDragging: boolean
  isArmed: boolean
  holdTimer?: ReturnType<typeof setTimeout>
  parent: HTMLElement | null
  nextSibling: ChildNode | null
  hiddenEmpty: HTMLElement | null
}

export function useHomeDrags(shelvesRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const shelvesEl = shelvesRef.current

    if (!shelvesEl) return

    // --- shelf (queue) reorder: drag the ≡ handle vertically ------------------ //
    let shelfDrag: ShelfDrag | null = null

    function onShelfMove(e: PointerEvent) {
      if (!shelfDrag) return

      e.preventDefault()

      // Dragging near the viewport edge scrolls the page so a shelf can travel
      // further than one screen (collapse-all also makes long hauls easy).
      if (e.clientY < 80) window.scrollBy(0, -24)
      else if (e.clientY > window.innerHeight - 80) window.scrollBy(0, 24)

      const others = [
        ...shelvesEl!.querySelectorAll<HTMLElement>(".shelf:not(.dragging)"),
      ].filter((s) => !s.hidden)

      if (!others.length) return

      let best: HTMLElement | null = null
      let bestDist = Infinity
      let isAfter = false

      for (const s of others) {
        const r = s.getBoundingClientRect()
        const cy = r.top + r.height / 2
        const d = Math.abs(e.clientY - cy)

        if (d < bestDist) {
          bestDist = d
          best = s
          isAfter = e.clientY > cy
        }
      }

      if (!best) return

      const ref = isAfter ? best.nextElementSibling : best

      if (
        ref === shelfDrag.shelf ||
        ref === shelfDrag.shelf.nextElementSibling
      ) {
        return
      }

      flipMove(
        others,
        () => shelvesEl!.insertBefore(shelfDrag!.shelf, ref),
        shelfDrag.shelf,
      )
    }

    async function onShelfUp() {
      if (!shelfDrag) return

      const { nextSibling, shelf } = shelfDrag

      shelfDrag = null
      busy.shelfDrag = false
      window.removeEventListener("pointermove", onShelfMove)
      window.removeEventListener("pointerup", onShelfUp)
      window.removeEventListener("pointercancel", onShelfUp)
      shelf.classList.remove("dragging")
      document.body.classList.remove("sdrag")

      const domOrder = [
        ...shelvesEl!.querySelectorAll<HTMLElement>(".shelf"),
      ].map((s) => s.dataset.set!)

      shelvesEl!.insertBefore(shelf, nextSibling)

      const data = getState().data

      if (!data) return

      // Rotation channels are not shelves, so they keep their spot at the end.
      const rest = data.order.filter((id) => !domOrder.includes(id))
      const next = [...domOrder, ...rest]

      data.order = next
      bumpRevision()
      setStatus("Saving queue order…")

      try {
        await api("PATCH", "/api/sets-order", { ids: next })

        // Re-assert the order we just persisted. The PATCH rewrites sets.yaml,
        // which pings SSE — and a `liveRefresh` whose GET was issued BEFORE that
        // write completes lands afterwards carrying the OLD order and silently
        // reverts the shelves. (The poster drag has no such window: it refetches
        // after its write instead of writing the order locally.)
        const live = getState().data

        if (live) {
          live.order = next
          bumpRevision()
        }

        setStatus("Queue order saved", "ok")
      }
      catch (e) {
        setStatus("Reorder failed: " + (e as Error).message, "err")
        await load()
      }
    }

    const onShelfHandleDown = (e: PointerEvent) => {
      const handle = (e.target as HTMLElement).closest(".shelfdrag")

      if (!handle) return

      const shelf = handle.closest<HTMLElement>(".shelf")

      if (!shelf) return

      e.preventDefault()
      shelfDrag = { nextSibling: shelf.nextSibling, shelf }
      busy.shelfDrag = true
      shelf.classList.add("dragging")
      document.body.classList.add("sdrag") // enables the sibling glide transition
      window.addEventListener("pointermove", onShelfMove, { passive: false })
      window.addEventListener("pointerup", onShelfUp)
      window.addEventListener("pointercancel", onShelfUp)
    }

    // --- Home poster drag: reorder WITHIN + move BETWEEN shelves --------------- //
    let hpress: HomePress | null = null

    const stripsOnScreen = () => [
      ...shelvesEl!.querySelectorAll<HTMLElement>(
        ".shelf:not(.collapsed):not([hidden]) .strip",
      ),
    ]

    const beginHomeDrag = () => {
      if (!hpress) return

      hpress.isDragging = true
      hpress.card.classList.add("dragging")
      document.body.classList.add("hdrag") // disables strip snap/smooth while dragging
    }

    const clearDropTargets = () => {
      shelvesEl!
        .querySelectorAll(".shelf.drop-target")
        .forEach((s) => s.classList.remove("drop-target"))
    }

    const endHomePress = () => {
      if (hpress?.holdTimer) clearTimeout(hpress.holdTimer)

      document.body.classList.remove("hdrag")
      window.removeEventListener("pointermove", onHomeMove)
      window.removeEventListener("pointerup", onHomeUp)
      window.removeEventListener("pointercancel", onHomeUp)
      hpress = null
      busy.homePress = false
    }

    function onHomeMove(e: PointerEvent) {
      if (!hpress) return

      if (!hpress.isDragging) {
        const isFar =
          Math.hypot(e.clientX - hpress.x, e.clientY - hpress.y) > DRAG_THRESHOLD

        if (hpress.type === "touch") {
          if (!hpress.isArmed) {
            // A swipe, not a drag — let the browser scroll.
            if (isFar) endHomePress()

            return
          }
        }
        else if (isFar) {
          beginHomeDrag()
        }
        else {
          return
        }

        if (!hpress.isDragging) return
      }

      e.preventDefault()

      // Page auto-scroll for cross-shelf hauls.
      if (e.clientY < 90) window.scrollBy(0, -24)
      else if (e.clientY > window.innerHeight - 90) window.scrollBy(0, 24)

      // Which shelf is the pointer over (a little vertical slack so the gap rows
      // count)?
      let target: HTMLElement | null = null

      for (const strip of stripsOnScreen()) {
        const r = strip.closest(".strip-wrap")!.getBoundingClientRect()

        if (e.clientY >= r.top - 14 && e.clientY <= r.bottom + 14) {
          target = strip

          break
        }
      }

      clearDropTargets()

      if (!target) return

      target.closest(".shelf")!.classList.add("drop-target")

      // Strip auto-scroll near its left/right edge.
      const wr = target.closest(".strip-wrap")!.getBoundingClientRect()

      if (e.clientX < wr.left + 70) target.scrollBy({ behavior: "auto", left: -18 })
      else if (e.clientX > wr.right - 70) {
        target.scrollBy({ behavior: "auto", left: 18 })
      }

      // Dropping into an empty queue: hide the placeholder rather than removing it
      // (see the header comment).
      const empty = target.querySelector<HTMLElement>(".empty")

      if (empty && empty !== hpress.hiddenEmpty) {
        empty.style.display = "none"
        hpress.hiddenEmpty = empty
      }

      const tiles = [
        ...target.querySelectorAll<HTMLElement>("li.tile:not(.dragging)"),
      ]

      if (!tiles.length) {
        target.appendChild(hpress.card)

        return
      }

      let best: HTMLElement | null = null
      let bestDist = Infinity
      let isAfter = false

      for (const t of tiles) {
        const r = t.getBoundingClientRect()
        const cx = r.left + r.width / 2
        const d = Math.abs(e.clientX - cx)

        if (d < bestDist) {
          bestDist = d
          best = t
          isAfter = e.clientX > cx
        }
      }

      if (!best) return

      const ref = isAfter ? best.nextElementSibling : best

      if (ref === hpress.card) return
      // Already there.
      if (
        hpress.card.parentNode === target &&
        ref === hpress.card.nextElementSibling
      ) {
        return
      }

      flipMove(tiles, () => target!.insertBefore(hpress!.card, ref), hpress.card)
    }

    async function onHomeUp() {
      if (!hpress) return

      const { card, fromSet, hiddenEmpty, isDragging, nextSibling, parent } =
        hpress

      endHomePress()
      clearDropTargets()

      if (hiddenEmpty) hiddenEmpty.style.display = ""

      if (!isDragging) return // a plain tap on a Home poster does nothing

      card.classList.remove("dragging")

      const strip = card.closest<HTMLElement>(".strip")

      if (!strip) return

      const toSet = strip.closest<HTMLElement>(".shelf")!.dataset.set!
      const keys = [...strip.querySelectorAll<HTMLElement>("li.tile")].map(
        (li) => li.dataset.key!,
      )

      // Hand the DOM back to React before the optimistic state update.
      parent?.insertBefore(card, nextSibling)

      const data = getState().data

      if (!data) return

      const from = data.sets[fromSet]
      const to = data.sets[toSet]

      setStatus("Saving…")

      try {
        if (toSet === fromSet) {
          if (to) {
            const byKey = new Map(to.items.map((it) => [it.key, it]))

            to.items = keys.map((k) => byKey.get(k)!).filter(Boolean)
            bumpRevision()
          }

          await api("PATCH", `/api/queues/${toSet}/order`, { keys })
          setStatus("Order saved", "ok")
        }
        else {
          const key = card.dataset.key!
          const moved = from?.items.find((it) => it.key === key)

          if (from && to && moved) {
            from.items = from.items.filter((it) => it.key !== key)

            const byKey = new Map([...to.items, moved].map((it) => [it.key, it]))

            to.items = keys.map((k) => byKey.get(k)!).filter(Boolean)
            bumpRevision()
          }

          await api("PATCH", "/api/queues/move", {
            fromSet,
            key,
            toKeys: keys,
            toSet,
          })
          setStatus(`Moved to ${data.sets[toSet]!.label}`, "ok")
        }

        // Freshen counts/order quietly; keeps the page where it is.
        refreshData()
      }
      catch (e) {
        setStatus("Save failed: " + (e as Error).message, "err")
        await load()
      }
    }

    const onPosterDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement

      // Posters only — headers/captions do their own thing.
      if (!target.closest(".thumb")) return

      const card = target.closest<HTMLElement>("li.tile")

      if (!card || !card.closest(".strip")) return

      if (e.pointerType !== "touch") e.preventDefault()

      hpress = {
        card,
        fromSet: card.dataset.set!,
        hiddenEmpty: null,
        isArmed: e.pointerType !== "touch",
        isDragging: false,
        nextSibling: card.nextSibling,
        parent: card.parentElement,
        type: e.pointerType,
        x: e.clientX,
        y: e.clientY,
      }
      busy.homePress = true

      if (e.pointerType === "touch") {
        hpress.holdTimer = setTimeout(() => {
          if (hpress) {
            hpress.isArmed = true
            beginHomeDrag()
          }
        }, 200)
      }

      window.addEventListener("pointermove", onHomeMove, { passive: false })
      window.addEventListener("pointerup", onHomeUp)
      window.addEventListener("pointercancel", onHomeUp)
    }

    const onDragStart = (e: Event) => e.preventDefault() // no native image drags
    // A touch long-press arms the drag, but that same press fires the browser's
    // native context menu over a poster and steals the gesture — suppress it there.
    const onContextMenu = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".thumb")) e.preventDefault()
    }
    // Once a touch drag is armed, stop the browser's native panning
    // (preventDefault on touchmove is what actually blocks scrolling — pointer
    // events alone can't).
    const onTouchMove = (e: TouchEvent) => {
      if (hpress?.isDragging) e.preventDefault()
    }

    shelvesEl.addEventListener("pointerdown", onShelfHandleDown)
    shelvesEl.addEventListener("pointerdown", onPosterDown)
    shelvesEl.addEventListener("dragstart", onDragStart)
    shelvesEl.addEventListener("contextmenu", onContextMenu)
    shelvesEl.addEventListener("touchmove", onTouchMove, { passive: false })

    return () => {
      shelvesEl.removeEventListener("pointerdown", onShelfHandleDown)
      shelvesEl.removeEventListener("pointerdown", onPosterDown)
      shelvesEl.removeEventListener("dragstart", onDragStart)
      shelvesEl.removeEventListener("contextmenu", onContextMenu)
      shelvesEl.removeEventListener("touchmove", onTouchMove)
      endHomePress()
    }
  }, [shelvesRef])
}
