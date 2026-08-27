import { Button } from "@charcuterie/ui"
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"

import { hasMemberList, isStartable } from "../lib/tileFace"
import { applyVocab, vocabForSet } from "../lib/vocab"
import {
  closeTileMenu,
  openMembersModal,
  openStartModal,
  useOverlays,
} from "../state/overlays"
import { useStore } from "../state/store"
import { commitStart } from "./startCommit"

/**
 * The tile context menu (right-click / long-press): **only what the card cannot do.**
 *
 * *Play this next / Move to the Priority queue / Move to the Random pool / Start from an
 * episode… / Start automatically (clear override) / Skip “<item>”*.
 *
 * **Remove is not here.** Every editable grid puts a ✕ on the tile
 * (decision `2026-08-21-any-tile-in-an-editable-grid-gets-the-remove-control`), so the menu
 * used to open on a queue tile holding one row that repeated the control six pixels away —
 * "I'd prefer options that aren't on the card". The lane rows are what the menu is for: a
 * promote was a drag across the lane divider and nothing else, which is a gesture, not an
 * action you can find.
 * (decisions `2026-08-26-the-tile-menu-carries-what-the-card-cannot`,
 *  `2026-07-31-start-episode-is-picked-in-a-modal`)
 *
 * `#tilemenu` is always in the document and toggles `hidden`, matching the vanilla
 * markup that `verify-start-modal.mjs` selects as `#tilemenu:not([hidden])`.
 */
export function TileMenu() {
  const { tileMenu } = useOverlays()
  const { reg } = useStore()
  const vocab = vocabForSet(
    reg?.sets,
    tileMenu?.entry.setId,
  )
  const t = (s: string) => applyVocab(s, vocab)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{
    left: number
    top: number
  } | null>(null)

  // Clamp into the viewport (a tile near the right/bottom edge would otherwise push
  // the menu off-screen). Measured after render, because the height depends on how
  // many actions the entry has.
  useLayoutEffect(() => {
    if (!tileMenu || !ref.current) {
      setPos(null)

      return
    }

    const r = ref.current.getBoundingClientRect()

    setPos({
      left: Math.max(
        4,
        Math.min(
          tileMenu.x,
          window.innerWidth - r.width - 4,
        ),
      ),
      top: Math.max(
        4,
        Math.min(
          tileMenu.y,
          window.innerHeight - r.height - 4,
        ),
      ),
    })

    // `preventScroll`, and it is not a nicety: the effect above has ALREADY clamped the menu
    // into the viewport, so there is nothing to scroll to — but a plain `focus()` scrolls
    // anyway on a narrow screen, that scroll fires the `scroll` listener below, and the menu
    // closes itself in the same frame it opened. It read as a long-press that did nothing.
    // (decision `2026-08-26-a-long-press-is-the-menu-or-the-drag-never-both`)
    ref.current
      .querySelector("button")
      ?.focus({ preventScroll: true })
  }, [tileMenu])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest("#tilemenu"))
        closeTileMenu()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeTileMenu()
    }

    document.addEventListener(
      "pointerdown",
      onPointerDown,
      true,
    )
    document.addEventListener("keydown", onKeyDown)
    // Close when the page actually MOVES under the menu — the menu is `position: fixed` and
    // pinned to where the tile WAS, so a scroll leaves it pointing at nothing.
    //
    // A zero-delta scroll event does not count. Chromium fires one at the document, with the
    // scroll position unchanged, in the frame the menu opens over a grid that was scrolled
    // into view — and closing on that made the long-press look like it did nothing at all:
    // the menu opened and vanished before it painted. An INNER scroller (the Home shelf's
    // strip) has no position to compare, so any scroll from one still closes.
    // (decision `2026-08-26-a-long-press-is-the-menu-or-the-drag-never-both`)
    const at = { x: window.scrollX, y: window.scrollY }
    const onScroll = (e: Event) => {
      const isPage =
        e.target === document ||
        e.target === document.scrollingElement

      if (
        isPage &&
        window.scrollX === at.x &&
        window.scrollY === at.y
      )
        return

      closeTileMenu()
    }

    window.addEventListener("scroll", onScroll, true)

    return () => {
      document.removeEventListener(
        "pointerdown",
        onPointerDown,
        true,
      )
      document.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("scroll", onScroll, true)
    }
  }, [])

  const entry = tileMenu?.entry
  const item = entry?.item

  return (
    <div
      className="ctxmenu"
      hidden={!tileMenu}
      id="tilemenu"
      ref={ref}
      style={
        pos ? { left: pos.left, top: pos.top } : undefined
      }
    >
      {/* Charcuterie `Button`s, `ghost` (nothing until hover) — the same shape `PlayMenu`'s
          device rows already use, and for the same reason: this is a hand-rolled menu whose
          ROWS are still ordinary buttons. `.ctxmenu button`'s skin is deleted; what stays is
          layout (`justify-content`, `width`, `text-align`), exactly as `.qmenu button` does.
          Every row is `neutral` now — the one `danger` row was Remove, and Remove is the ✕
          on the card.
          (decisions `2026-08-21-a-component-configured-by-props-not-a-borrowed-class`,
          `2026-08-02-adopting-a-component-means-deleting-its-skin`) */}
      {/* PLAY THIS NEXT — the head of the Priority queue, which is the one position the
          lane rows below cannot reach: "Move to the Priority queue" appends, so a promote
          never displaces what is already promoted. Hidden when the entry already leads that
          queue, where the row would do nothing. */}
      {entry?.lane &&
      !(
        entry.lane.current === "priority" &&
        entry.lane.isFirst
      ) ? (
        <Button
          appearance="ghost"
          intent="neutral"
          isFullWidth
          onClick={() => {
            closeTileMenu()
            entry.lane?.playNext()
          }}
        >
          Play this next
        </Button>
      ) : null}
      {/* THE PROMOTE / THE DEMOTE. The same write the drag across the lane divider makes
          (`useGridDrag`), which until now was the only way to make one — and a drag is hard
          to aim on touch and impossible to discover. The wording is the lanes' own names, so
          the row, the lane heading and the toast all say the same thing. */}
      {entry?.lane ? (
        <Button
          appearance="ghost"
          intent="neutral"
          isFullWidth
          onClick={() => {
            closeTileMenu()
            entry.lane?.moveTo(
              entry.lane.current === "priority"
                ? "random"
                : "priority",
            )
          }}
        >
          {entry.lane.current === "priority"
            ? "Move to the Random pool"
            : "Move to the Priority queue"}
        </Button>
      ) : null}
      {entry && item && isStartable(item) ? (
        <Button
          appearance="ghost"
          intent="neutral"
          isFullWidth
          onClick={() => openStartModal(entry)}
        >
          {item.start
            ? t("Change start episode…")
            : t("Start from an episode…")}
        </Button>
      ) : null}
      {entry && item && isStartable(item) && item.start ? (
        <Button
          appearance="ghost"
          intent="neutral"
          isFullWidth
          onClick={() => {
            closeTileMenu()
            void commitStart(entry, null)
          }}
        >
          Start automatically (clear override)
        </Button>
      ) : null}
      {/* WHAT PLAYS — the whole inside of the entry, in one list. The row below skips the ONE
          item that is next; this is how you reach the other four, and how three duplicate cuts
          of one film in a collection get dealt with in one save rather than three
          (owner, 2026-08-26: "it won't let me skip the duplicate ... ones and select only the
          one I want"). Offered on the same shapes `Start from…` is — a movie has one item
          inside it, which is itself. */}
      {entry && hasMemberList(item) ? (
        <Button
          appearance="ghost"
          intent="neutral"
          isFullWidth
          onClick={() => openMembersModal(entry)}
        >
          {item?.type === "collection"
            ? "Choose what plays…"
            : t("Choose which episodes play…")}
        </Button>
      ) : null}
      {/* SKIP — "not this one", which is a different ask from "not this show". It drops the
          one item the entry is about to play (the episode, the collection child) and leaves
          the entry where it is, so the next scan moves on to the following one. `neutral`,
          not `danger`: nothing is deleted, and it is undone from the queue's Skipped panel.
          Absent entirely on an entry with no item inside it to skip — a movie IS its own
          item, and Remove is the answer there. */}
      {entry?.skip ? (
        <Button
          appearance="ghost"
          intent="neutral"
          isFullWidth
          onClick={() => {
            closeTileMenu()
            entry.skip?.()
          }}
        >
          {entry.skipLabel || "Skip this one"}
        </Button>
      ) : null}
    </div>
  )
}
