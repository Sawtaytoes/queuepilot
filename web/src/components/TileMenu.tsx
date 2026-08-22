import { Button } from "@charcuterie/ui"
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"

import { isStartable } from "../lib/tileFace"
import { applyVocab, vocabForSet } from "../lib/vocab"
import {
  closeTileMenu,
  openStartModal,
  useOverlays,
} from "../state/overlays"
import { useStore } from "../state/store"
import { commitStart } from "./startCommit"

/**
 * The tile context menu (right-click / long-press): the per-entry actions that used
 * to sit inline on the tile — *Start from an episode… / Start automatically (clear
 * override) / Remove*.
 * (decision `2026-07-31-start-episode-is-picked-in-a-modal`)
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

    ref.current.querySelector("button")?.focus()
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
    window.addEventListener("scroll", closeTileMenu, true)

    return () => {
      document.removeEventListener(
        "pointerdown",
        onPointerDown,
        true,
      )
      document.removeEventListener("keydown", onKeyDown)
      window.removeEventListener(
        "scroll",
        closeTileMenu,
        true,
      )
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
          `intent="danger"` replaces `.ctxmenu button.danger`'s colour.
          (decisions `2026-08-21-a-component-configured-by-props-not-a-borrowed-class`,
          `2026-08-02-adopting-a-component-means-deleting-its-skin`) */}
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
      {entry?.remove ? (
        <Button
          appearance="ghost"
          intent="danger"
          isFullWidth
          onClick={() => {
            closeTileMenu()
            entry.remove?.()
          }}
        >
          {entry.removeLabel || "Remove"}
        </Button>
      ) : null}
    </div>
  )
}
