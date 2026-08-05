import { ColorSchemeSwitcher } from "@charcuterie/ui"
import { useEffect, useRef, useState } from "react"

import { api } from "../lib/api"
import { busy } from "../state/busy"
import { refreshData } from "../state/live"
import { navigate } from "../state/route"
import {
  bumpRevision,
  getState,
  refreshHistoryButtons,
  setStatus,
  useStore,
} from "../state/store"
import { schemeIcons } from "./SchemeIcons"

/**
 * The sticky header: back, the heading (which is also the rename field), the status
 * toast, undo/redo, and the desktop slot the Home toolbar mounts into.
 *
 * **The heading IS the rename control.** A pen sits beside it and clicking either
 * turns the `<h1>` into an input prefilled with the label; Enter/blur PATCHes
 * `{label}`, Esc cancels. The id is immutable, so this only ever changes the
 * display label — an NFC card pointed at the set keeps working
 * (decision `2026-07-21-sets-registry-immutable-ids`).
 *
 * While the input is up, `busy.headingEdit` blocks the live refresh: a repaint
 * mid-rename would throw the typed text away.
 */

type Props = {
  heading: string
  sub: string
  isSubHidden: boolean
  back: { target: string; label: string } | null
  /** The set whose label the heading edits, or null. */
  editableSetId: string | null
  children?: React.ReactNode
}

export function Header({
  back,
  children,
  editableSetId,
  heading,
  isSubHidden,
  sub,
}: Props) {
  const { history, status } = useStore()
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const settledRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const headerRef = useRef<HTMLElement>(null)

  // F4: publish the header's MEASURED height to `--header-h`, replacing the hardcoded 90px
  // that `#chfilters`'s sticky `top` and the (missing) scroll offsets assumed. The header
  // grows when the toolbar wraps, so a constant was always going to be wrong for someone;
  // this self-corrects. A ResizeObserver is the right tool — it fires on the wrap, not just
  // on a viewport resize.
  useEffect(() => {
    const el = headerRef.current

    if (!el) return

    const ro = new ResizeObserver(([entry]) => {
      document.documentElement.style.setProperty(
        "--header-h",
        `${entry.contentRect.height}px`,
      )
    })

    ro.observe(el)

    return () => ro.disconnect()
  }, [])

  // Leaving the view (or losing the editable set) must not strand the input.
  useEffect(() => {
    if (!editableSetId && isEditing) {
      setIsEditing(false)
      busy.headingEdit = false
    }
  }, [editableSetId, isEditing])

  useEffect(() => {
    if (!isEditing) return

    inputRef.current?.focus()
    inputRef.current?.select()
  }, [isEditing])

  const begin = () => {
    if (!editableSetId || isEditing) return

    settledRef.current = false
    setDraft(getState().data?.sets[editableSetId]?.label ?? heading)
    setIsEditing(true)
    busy.headingEdit = true
  }

  const finish = async (isSaving: boolean) => {
    if (settledRef.current) return

    settledRef.current = true
    setIsEditing(false)
    busy.headingEdit = false

    const value = draft.trim()
    const before = editableSetId
      ? getState().data?.sets[editableSetId]?.label
      : undefined

    if (!isSaving || !value || !editableSetId || value === before) return

    setStatus("Renaming…")

    try {
      await api("PATCH", `/api/sets/${editableSetId}`, { label: value })

      const set = getState().data?.sets[editableSetId]

      if (set) {
        set.label = value
        bumpRevision()
      }

      setStatus("Renamed", "ok")
    }
    catch (e) {
      setStatus("Rename failed: " + (e as Error).message, "err")
    }
  }

  const runHistory = async (dir: "undo" | "redo") => {
    setStatus(dir === "undo" ? "Undoing…" : "Redoing…")

    try {
      const out = await api<{ ok?: boolean; error?: string }>(
        "POST",
        `/api/${dir}`,
      )

      if (!out.ok) throw new Error(out.error)

      setStatus(dir === "undo" ? "Undone" : "Redone", "ok")
      // The file write pings SSE too, but refresh immediately for snappy feedback.
      refreshData()
      void refreshHistoryButtons()
    }
    catch (e) {
      setStatus(`${dir} failed: ${(e as Error).message}`, "err")
    }
  }

  return (
    <header ref={headerRef}>
      <div className="bar">
        <button
          className="ghost"
          hidden={!back}
          id="back"
          onClick={() => back && navigate(back.target)}
          type="button"
        >
          {back?.label ?? "← All queues"}
        </button>
        <h1 id="heading" onClick={begin}>
          {isEditing
            ? (
                <input
                  id="headingedit"
                  maxLength={60}
                  onBlur={() => void finish(true)}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      void finish(true)
                    }
                    else if (e.key === "Escape") {
                      e.preventDefault()
                      void finish(false)
                    }
                  }}
                  ref={inputRef}
                  type="text"
                  value={draft}
                />
              )
            : heading}
        </h1>
        <button
          className="ghost namepen"
          hidden={!editableSetId}
          id="editname"
          onClick={begin}
          title="Rename"
          type="button"
        >
          ✎
        </button>
        <span
          id="status"
          style={{
            color:
              status.kind === "err"
                ? "var(--color-intent-danger-content)"
                : status.kind === "ok"
                  ? "var(--color-intent-success-content)"
                  : "var(--color-content-muted)",
          }}
        >
          {status.msg}
        </span>
        <button
          className="ghost"
          disabled={!history.undo}
          id="undo"
          onClick={() => void runHistory("undo")}
          title="Undo last change"
          type="button"
        >
          ↶
        </button>
        <button
          className="ghost"
          disabled={!history.redo}
          id="redo"
          onClick={() => void runHistory("redo")}
          title="Redo"
          type="button"
        >
          ↷
        </button>
        {/* Follows the OS light/dark scheme; cycles light → dark → system, persists
            the pick to localStorage (`charcuterie-scheme`) and writes `data-scheme`
            on `<html>`. All three seams are the browser defaults the component ships;
            the app only supplies its own glyphs. */}
        <ColorSchemeSwitcher icons={schemeIcons} />
        {/* F4: the Home toolbar now shares the `.bar` row (was its own third row), pushed
            right with `margin-left: auto`. The h1 has `flex:1; min-width:0` and ellipsises,
            so it yields to the toolbar's width. Desktop only — on mobile `children` is null
            here and the toolbar re-mounts at the top of the Home content. `ui-test` reads
            `#gslot-desktop #tools`, so the id and its child stay put. */}
        <div id="gslot-desktop">{children}</div>
      </div>
      <p className="sub" hidden={isSubHidden} id="sub">
        {sub}
      </p>
    </header>
  )
}
