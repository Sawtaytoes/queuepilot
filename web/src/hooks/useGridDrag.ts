import { type RefObject, useEffect } from "react"

import { api } from "../lib/api"
import { flipMove } from "../lib/flip"
import {
  findVerticalScrollRegion,
  scrollRegionBounds,
  scrollRegionBy,
  scrollRegionTop,
} from "../lib/verticalScrollRegion"
import { busy } from "../state/busy"
import { toggleSelectThrough } from "../state/selection"
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
 *
 * ### Two LANES, and the drag across the divider is the promote
 *
 * The container is no longer one `<ul>`. It holds a `ul.grid[data-lane]` per lane —
 * `priority` and `random` — and the gesture spans both, because dropping a tile in
 * the other lane is how an entry is promoted or demoted
 * (decision `2026-08-26-the-queue-page-is-two-lanes-and-the-drag-is-the-promote`).
 * Three consequences, each of which had to be handled rather than assumed:
 *
 *  * **The slot snapshot is per lane**, and an EMPTY lane contributes its own box as a
 *    slot. Without that, a queue with nothing promoted has no geometry to aim at and
 *    the first promote is undraggable — which is the case the drop strip exists for.
 *  * **The pool is not hand-orderable**, so a drag that starts and ends in `random`
 *    commits nothing. It is not disabled, though: the same press dragged UP is a
 *    promote, and the two cannot be told apart until the pointer comes up.
 *  * **The write is two calls, and the order is one list.** `placement` first (so the
 *    lane is true before anything reads it), then `/order` with BOTH lanes
 *    concatenated — the file is a single sequence and the engine plays the priority
 *    entries in file order, so priority-then-pool is the only order that means what
 *    the screen shows.
 */

const DRAG_THRESHOLD = 6
const AUTO_SCROLL_EDGE = 72
const AUTO_SCROLL_MAX_STEP = 18

type Press = {
  card: HTMLElement
  x: number
  y: number
  type: string
  isDragging: boolean
  hasMoved: boolean
  pointerId: number
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
  /** The element holding every `ul.grid[data-lane]` — not a lane itself. */
  gridRef: RefObject<HTMLElement | null>,
  currentSet: string | null,
  /**
   * The queue's OWN default lane (`add_as`), already resolved by the caller.
   *
   * It is what an entry with no `placement` of its own means, so it is what decides
   * whether a dropped tile needs a `placement` written at all: land in the lane you
   * already inherit and the entry should keep saying nothing, not gain a redundant
   * override that then stops following the queue.
   */
  setLane: "priority" | "random",
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

    const scrollRegion = findVerticalScrollRegion(grid)

    let press: Press | null = null
    let selectionClickCard: HTMLElement | null = null

    const beginDrag = () => {
      if (!press) return

      press.isDragging = true
      // Keep the pointer routed here after the browser starts moving the page beneath it.
      // This is especially important while edge scrolling carries the original tile out of
      // the viewport.
      try {
        press.card.setPointerCapture?.(press.pointerId)
      } catch {
        // The pointer may have been cancelled in the same frame as the hold timer. The
        // window listeners still own the gesture, so capture is useful but not required.
      }
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

      if (press?.card.hasPointerCapture?.(press.pointerId))
        press.card.releasePointerCapture(press.pointerId)

      document.body.classList.remove("gdrag")
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
      press = null
      busy.gridPress = false
    }

    function onMove(e: PointerEvent) {
      if (!press) return

      const isFar =
        Math.hypot(
          e.clientX - press.x,
          e.clientY - press.y,
        ) > DRAG_THRESHOLD

      if (!press.isDragging) {
        if (press.type === "touch") {
          // The hold timer starts a touch drag. Any earlier movement belongs to the page.
          if (isFar) endPress()

          return
        } else if (isFar) {
          beginDrag()
        } else {
          return
        }

        if (!press.isDragging) return
      }

      // Ignore normal finger jitter after the tile lifts. This keeps a stationary hold from
      // mutating the DOM or saving an unchanged order when the pointer wanders by one pixel.
      if (!press.hasMoved && !isFar) return

      e.preventDefault()

      // COALESCE to one reposition per animation frame. `pointermove` fires far faster than
      // the screen repaints — a deliberate half-second drag across the Cards grid measured 20
      // reorders, each starting a 180ms glide on ~7 tiles while the previous glides were still
      // running. The gesture cannot look settled if it is restarted more often than it is
      // drawn, so the handler now only records where the pointer IS and the work happens once
      // per frame.
      press.hasMoved = true
      press.at = { x: e.clientX, y: e.clientY }
      queueReposition()
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
    /**
     * One aimable position. `tile` is the tile whose slot this is, or null for the
     * whole-lane box an EMPTY lane contributes — the only geometry a lane with nothing
     * in it has, and the reason the first promote on a fresh queue is draggable at all.
     */
    type Slot = {
      lane: HTMLElement
      rect: DOMRect
      tile: HTMLElement | null
    }

    let slots: Slot[] = []

    const lanesOf = (root: HTMLElement) => [
      ...root.querySelectorAll<HTMLElement>(
        "ul.grid[data-lane]",
      ),
    ]

    const captureSlots = () => {
      slots = []

      for (const lane of lanesOf(grid!)) {
        const tiles = [
          ...lane.querySelectorAll<HTMLElement>("li.tile"),
        ]

        // A lane holding only the dragged tile still has to be aimable, or a drag that
        // starts in a one-entry Priority lane cannot be put back.
        if (!tiles.length) {
          slots.push({
            lane,
            rect: lane.getBoundingClientRect(),
            tile: null,
          })

          continue
        }

        for (const tile of tiles)
          slots.push({
            lane,
            rect: tile.getBoundingClientRect(),
            tile,
          })
      }
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
      //
      // The lane comes from the winning slot rather than from a hit test of its own. A
      // point-in-lane test reads more obvious and is worse: the gap BETWEEN two lanes is
      // inside neither, so a pointer resting on the divider belongs nowhere and the tile
      // snaps back to where it started for as long as it hovers there.
      let best: Slot | null = null
      let bestDist = Infinity
      let isAfter = false

      for (const slot of slots) {
        const r = slot.rect
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const d = Math.hypot(
          (px - cx) / Math.max(1, r.width),
          (py - cy) / Math.max(1, r.height),
        )

        if (d < bestDist) {
          bestDist = d
          best = slot
          // Past the slot's own centre horizontally means the tile belongs AFTER it.
          isAfter = px > cx
        }
      }

      if (!best) return

      const lane = best.lane
      // An empty lane's slot names no tile — the card simply goes in it.
      const others = [
        ...lane.querySelectorAll<HTMLElement>(
          "li.tile:not(.dragging)",
        ),
      ]
      const ref = !best.tile
        ? null
        : (() => {
            const i = others.indexOf(best.tile!)

            // The winning tile IS the dragged one (it is excluded from `others`, so the
            // index misses): the card is already where the pointer is.
            if (i < 0) return undefined

            return (
              (isAfter ? others[i + 1] : others[i]) ?? null
            )
          })()

      if (ref === undefined) return

      if (
        lane === press.card.parentElement &&
        (ref === press.card ||
          ref === press.card.nextElementSibling)
      )
        return

      // FLIP over EVERY tile on the page, not just this lane's: a promote empties a slot in
      // one lane and opens one in the other, so the tiles that move are in both.
      const moving = [
        ...grid!.querySelectorAll<HTMLElement>(
          "li.tile:not(.dragging)",
        ),
      ]

      flipMove(
        moving,
        () => lane.insertBefore(press!.card, ref),
        press.card,
      )
    }

    /**
     * Scroll the grid's vertical owner while the pointer rests near its visible edge.
     *
     * A phone only shows a few cards at once. A drag therefore has to move the page as well
     * as the tile, or every destination below that first viewport is unreachable. Slot boxes
     * are viewport-relative, so each actual scroll refreshes them before the next hit test.
     */
    const autoScroll = () => {
      if (!press?.isDragging || !press.at) return false

      const { bottom, top } =
        scrollRegionBounds(scrollRegion)
      const y = press.at.y
      let delta = 0

      if (y < top + AUTO_SCROLL_EDGE)
        delta =
          -AUTO_SCROLL_MAX_STEP *
          (1 - Math.max(0, y - top) / AUTO_SCROLL_EDGE)
      else if (y > bottom - AUTO_SCROLL_EDGE)
        delta =
          AUTO_SCROLL_MAX_STEP *
          (1 - Math.max(0, bottom - y) / AUTO_SCROLL_EDGE)

      if (!delta) return false

      const before = scrollRegionTop(scrollRegion)
      scrollRegionBy(scrollRegion, delta)
      const after = scrollRegionTop(scrollRegion)

      if (after === before) return false

      captureSlots()

      return true
    }

    const queueReposition = () => {
      if (!press || press.frame != null) return

      press.frame = requestAnimationFrame(() => {
        if (!press) return

        press.frame = undefined
        const didScroll = autoScroll()
        reposition()

        // Continue without another pointermove. The finger is stationary at the viewport
        // edge while the page and its newly reachable destinations move underneath it.
        if (didScroll) queueReposition()
      })
    }

    async function onUp(event: PointerEvent) {
      if (!press) return

      const {
        card,
        hasMoved,
        isDragging,
        nextSibling,
        parent,
      } = press

      endPress()

      if (!isDragging) {
        const { key, set } = card.dataset

        if (!set || !key) return

        // "Move mode": once something is checked, a plain poster tap toggles it
        // too, so a whole run can be selected without hunting for checkboxes.
        if (busy.selectedCount > 0) {
          // The browser emits `click` after this pointerup. In Cards/Rows density the tap can
          // have landed on the title link, but selection mode owns the item tap, so suppress
          // that later navigation after recording which card it belongs to.
          selectionClickCard = card
          toggleSelectThrough(
            set,
            key,
            lanesOf(grid!).flatMap((lane) =>
              [
                ...lane.querySelectorAll<HTMLElement>(
                  "li.tile",
                ),
              ]
                .map((tile) => tile.dataset.key)
                .filter((tileKey): tileKey is string =>
                  Boolean(tileKey),
                ),
            ),
            event.shiftKey,
          )

          return
        }

        // Otherwise the tap opens this entry. Reached only when the press did NOT
        // move past the threshold, so a drag can never land here.
        onOpenEntry?.(set, key)

        return
      }

      card.classList.remove("dragging")

      // A stationary touch hold only armed the drag. It did not move anything, so it must
      // not save the existing order or open the tile menu as a second gesture.
      if (!hasMoved) return

      // WHERE IT LANDED, read off the DOM before React is handed it back.
      const landedLane =
        card.closest<HTMLElement>("ul.grid[data-lane]")
          ?.dataset.lane === "priority"
          ? "priority"
          : "random"
      const startedLane =
        parent?.dataset.lane === "priority"
          ? "priority"
          : "random"

      // Both lanes, in screen order, as ONE list. The file is a single sequence and the
      // engine plays the priority entries in file order, so priority-then-pool is the only
      // order that means what the screen shows.
      const keys = lanesOf(grid!).flatMap((lane) =>
        [
          ...lane.querySelectorAll<HTMLElement>("li.tile"),
        ].map((li) => li.dataset.key!),
      )

      // Hand the DOM back to React, then let the optimistic state update repaint
      // it in the new order within the same tick.
      parent?.insertBefore(card, nextSibling)

      const set = currentSet
      const key = card.dataset.key

      if (!set || !key) return

      // A drag that began and ended in the POOL changes nothing: the pool is not
      // hand-ordered, because its order does not survive playback — it is shuffled. The
      // gesture is still allowed to start there, because the same press dragged UP is a
      // promote and the two are indistinguishable until the pointer comes up.
      if (
        landedLane === "random" &&
        startedLane === "random"
      ) {
        await load()

        return
      }

      const q = getState().data?.sets[set]

      if (q) {
        const byKey = new Map(
          q.items.map((it) => [it.key, it]),
        )

        q.items = keys
          .map((k) => byKey.get(k)!)
          .filter(Boolean)

        const hit = byKey.get(key)

        // The optimistic lane, under the SAME sparse rule the server writes: an entry that
        // lands in the lane it already inherits keeps saying nothing, so it goes on
        // following the queue if the queue's own default is changed later.
        if (hit)
          hit.placement =
            landedLane === setLane ? null : landedLane

        bumpRevision()
      }

      const isPromote = landedLane !== startedLane

      setStatus(isPromote ? "Moving…" : "Saving order…")

      try {
        // PLACEMENT FIRST, then the order. The other way round leaves a window in which the
        // file says an entry is in a lane the order does not put it in, and a scan landing in
        // that window builds a lineup off the half-written file.
        if (isPromote) {
          await api(
            "PATCH",
            `/api/queues/${set}/items/${encodeURIComponent(key)}/placement`,
            {
              placement:
                landedLane === setLane ? "" : landedLane,
            },
          )
        }

        await api("PATCH", `/api/queues/${set}/order`, {
          keys,
        })
        setStatus(
          isPromote
            ? landedLane === "priority"
              ? "Moved to the Priority queue"
              : "Moved to the Random pool"
            : "Order saved",
          "ok",
        )
      } catch (e) {
        setStatus(
          `${isPromote ? "Move" : "Reorder"} failed: ${(e as Error).message}`,
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
        target.closest(".tilechrome") ||
        target.closest(".remove") ||
        target.closest(".check") ||
        target.closest(".priority-position") ||
        // `.editbtn` is in the badge row (inside `.cap`), so the thumb test below would
        // already skip it — named anyway so a future move back onto the poster cannot
        // open the sheet under the pencil.
        target.closest(".editbtn") ||
        // `.tileplay` is the one control that lives INSIDE `.thumb`, so unlike ✓ and ✕
        // it is not excluded by the poster test below. It has to be named here and not
        // left to its own `stopPropagation`: that stops the CLICK, while this gesture is
        // built on pointerdown/pointerup listeners bound to the window, which a click
        // handler cannot reach. Without this, ▶ opened the device menu and the entry
        // sheet on top of it, from one tap.
        target.closest(".tileplay")
      )
        return // their own clicks
      // Outside selection mode, the poster stays the open/drag surface. Once selection is
      // active, the whole non-control part of a card toggles it. This is important in Cards
      // and Rows density, where the poster is only a small part of the item.
      if (
        !target.closest(".thumb") &&
        busy.selectedCount === 0
      )
        return
      // PRIMARY button only. `pointerdown` fires for the right button too, so a right-click
      // on the poster opened a press that its own `pointerup` then settled as a TAP — which
      // opens the entry sheet. The tile menu the right-click had just opened went under it,
      // and the one gesture did two things. Touch and pen both report button 0.
      if (e.button !== 0) return

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
        hasMoved: false,
        isDragging: false,
        nextSibling: card.nextSibling,
        parent: card.parentElement,
        pointerId: e.pointerId,
        type: e.pointerType,
        x: e.clientX,
        y: e.clientY,
      }
      busy.gridPress = true

      if (e.pointerType === "touch") {
        // A touch hold has ONE meaning on the poster: pick it up. Starting at the arm point
        // removes the narrow interval between "not armed yet" and the later contextmenu.
        // Tap still opens the entry sheet because it releases before this timer. The entry
        // sheet carries the same Play / lane actions the old stationary long press exposed.
        // (decision `2026-08-29-a-touch-hold-is-the-drag-and-it-scrolls`)
        press.holdTimer = setTimeout(() => {
          if (!press) return

          beginDrag()
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
    const onClickCapture = (e: MouseEvent) => {
      if (selectionClickCard?.contains(e.target as Node)) {
        e.preventDefault()
        e.stopPropagation()
      }

      selectionClickCard = null
    }
    // A long press is the MENU or the DRAG, never both.
    //
    // This event IS the long press on touch, so by the time it fires the gesture has
    // declared itself: the finger never moved, the tile menu is about to open, and the
    // press must stop being a candidate drag. `endPress` drops the window listeners with
    // it, so the `pointerup` that follows cannot settle as a tap and open the entry sheet
    // under the menu either.
    // (decision `2026-08-26-a-long-press-is-the-menu-or-the-drag-never-both`)
    //
    // The `preventDefault` is unchanged and still only about the poster: the browser's own
    // menu (Save image, Copy image) must not pop over it. A right-click elsewhere on the
    // tile opens OUR menu.
    const onContextMenu = (e: MouseEvent) => {
      // A browser can synthesize `contextmenu` later in the same touch hold. Once the tile
      // is armed, suppress that second interpretation and keep the drag alive.
      if (press?.type === "touch" && press.isDragging) {
        e.preventDefault()
        e.stopPropagation()

        return
      }

      if (press) {
        // Put the node back where React last rendered it before dropping the press, the
        // same restore `onUp` does. With the pick-up deferred a still finger is never
        // dragging by now, so this is a belt-and-braces branch, not the common path.
        if (press.isDragging) {
          press.card.classList.remove("dragging")
          press.parent?.insertBefore(
            press.card,
            press.nextSibling,
          )
        }

        endPress()
      }

      if ((e.target as HTMLElement).closest(".thumb"))
        e.preventDefault()
    }

    grid.addEventListener("pointerdown", onPointerDown)
    grid.addEventListener("touchmove", onTouchMove, {
      passive: false,
    })
    grid.addEventListener("dragstart", onDragStart)
    grid.addEventListener("click", onClickCapture, true)
    grid.addEventListener("contextmenu", onContextMenu)

    return () => {
      grid.removeEventListener("pointerdown", onPointerDown)
      grid.removeEventListener("touchmove", onTouchMove)
      grid.removeEventListener("dragstart", onDragStart)
      grid.removeEventListener(
        "click",
        onClickCapture,
        true,
      )
      grid.removeEventListener("contextmenu", onContextMenu)
      endPress()
    }
  }, [currentSet, gridRef, setLane])
}
