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
      {entry && item && isStartable(item) ? (
        <button
          onClick={() => openStartModal(entry)}
          type="button"
        >
          {item.start
            ? t("Change start episode…")
            : t("Start from an episode…")}
        </button>
      ) : null}
      {entry && item && isStartable(item) && item.start ? (
        <button
          onClick={() => {
            closeTileMenu()
            void commitStart(entry, null)
          }}
          type="button"
        >
          Start automatically (clear override)
        </button>
      ) : null}
      {entry?.remove ? (
        <button
          className="danger"
          onClick={() => {
            closeTileMenu()
            entry.remove?.()
          }}
          type="button"
        >
          {entry.removeLabel || "Remove"}
        </button>
      ) : null}
    </div>
  )
}
