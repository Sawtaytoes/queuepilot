import { ColorSchemeSwitcher } from "@charcuterie/ui"
import { useEffect, useRef, useState } from "react"
import { Link } from "react-router"

/** Which header popover is open. Only one at a time, mux-magic's `PageHeader` model:
 * a left "nav" menu (back / rename) and a right "actions" menu (undo / redo / scheme).
 * These are the MOBILE mechanism — on desktop the same controls sit inline on the bar
 * and the toggles are `display:none`. */
type OpenMenu = "nav" | "actions" | null

import { api } from "../lib/api"
import { busy } from "../state/busy"
import { refreshData } from "../state/live"
import {
  bumpRevision,
  getState,
  refreshHistoryButtons,
  setStatus,
  useStore,
} from "../state/store"
import { schemeIcons } from "./SchemeIcons"
import { Tip } from "./Tip"

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
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
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

  // The two header popovers are a dismissable layer: a click anywhere outside a
  // toggle or an open panel closes it, and Escape closes the topmost. Same shape as
  // mux-magic's `PageHeader` — a document listener, not a per-node handler, because
  // "click-away dismisses the layer" is not a property of any one node inside it.
  useEffect(() => {
    if (!openMenu) return

    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null

      if (t?.closest(".menu-toggle, .hmenu")) return

      setOpenMenu(null)
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null)
    }

    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)

    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [openMenu])

  const begin = () => {
    if (!editableSetId || isEditing) return

    settledRef.current = false
    setDraft(
      getState().data?.sets[editableSetId]?.label ??
        heading,
    )
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

    if (
      !isSaving ||
      !value ||
      !editableSetId ||
      value === before
    )
      return

    setStatus("Renaming…")

    try {
      await api("PATCH", `/api/sets/${editableSetId}`, {
        label: value,
      })

      const set = getState().data?.sets[editableSetId]

      if (set) {
        set.label = value
        bumpRevision()
      }

      setStatus("Renamed", "ok")
    } catch (e) {
      setStatus(
        `Rename failed: ${(e as Error).message}`,
        "err",
      )
    }
  }

  const runHistory = async (dir: "undo" | "redo") => {
    setStatus(dir === "undo" ? "Undoing…" : "Redoing…")

    try {
      const out = await api<{
        ok?: boolean
        error?: string
      }>("POST", `/api/${dir}`)

      if (!out.ok) throw new Error(out.error)

      setStatus(dir === "undo" ? "Undone" : "Redone", "ok")
      // The file write pings SSE too, but refresh immediately for snappy feedback.
      refreshData()
      void refreshHistoryButtons()
    } catch (e) {
      setStatus(
        `${dir} failed: ${(e as Error).message}`,
        "err",
      )
    }
  }

  return (
    <header ref={headerRef}>
      <div className="bar">
        {/* Mobile-only left toggle → the nav popover (back / rename). Hidden when it
            would open empty (the Play landing has neither). Desktop shows #back inline. */}
        <button
          aria-expanded={openMenu === "nav"}
          aria-haspopup="menu"
          aria-label="Navigation menu"
          className="ghost menu-toggle"
          hidden={!back && !editableSetId}
          id="menu-nav"
          onClick={() =>
            setOpenMenu((m) => (m === "nav" ? null : "nav"))
          }
          type="button"
        >
          ☰
        </button>
        {/* "‹ Play" goes to a page, so it is a link too — same reasoning as the landing rows.
            `to` falls back to `/` only while `hidden`, since an anchor with no href is not
            focusable and would silently drop out of the tab order the moment `back` is null. */}
        <Link
          className="ghost"
          hidden={!back}
          id="back"
          to={back?.target ?? "/"}
        >
          {back?.label ?? "← All queues"}
        </Link>
        <h1 id="heading" onClick={begin}>
          {isEditing ? (
            <input
              id="headingedit"
              maxLength={60}
              onBlur={() => void finish(true)}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  void finish(true)
                } else if (e.key === "Escape") {
                  e.preventDefault()
                  void finish(false)
                }
              }}
              ref={inputRef}
              type="text"
              value={draft}
            />
          ) : (
            heading
          )}
        </h1>
        <Tip label="Rename">
          <button
            aria-label="Rename"
            className="ghost namepen"
            hidden={!editableSetId}
            id="editname"
            onClick={begin}
            type="button"
          >
            ✎
          </button>
        </Tip>
        {/* The desktop chrome cluster: undo / redo / scheme / the Home toolbar slot,
            pushed right with `margin-left: auto`. The h1 has `flex:1; min-width:0` and
            ellipsises, so it yields to this width. On mobile the whole cluster is
            `display:none` and the right popover below mirrors it — the header is far too
            tight on a phone to carry it inline (that was the 300px-tall header bug).
            `ui-test` reads `#gslot-desktop #tools`, so that id and its child stay put. */}
        <div className="chrome">
          <Tip label="Undo last change">
            <button
              aria-label="Undo last change"
              className="ghost"
              disabled={!history.undo}
              id="undo"
              onClick={() => void runHistory("undo")}
              type="button"
            >
              ↶
            </button>
          </Tip>
          <Tip label="Redo">
            <button
              aria-label="Redo"
              className="ghost"
              disabled={!history.redo}
              id="redo"
              onClick={() => void runHistory("redo")}
              type="button"
            >
              ↷
            </button>
          </Tip>
          {/* Follows the OS light/dark scheme; cycles light → dark → system, persists
              the pick to localStorage (`charcuterie-scheme`) and writes `data-scheme`
              on `<html>`. */}
          <ColorSchemeSwitcher icons={schemeIcons} />
          <div id="gslot-desktop">{children}</div>
        </div>

        {/* Mobile-only right toggle → the actions popover. */}
        <button
          aria-expanded={openMenu === "actions"}
          aria-haspopup="menu"
          aria-label="Actions menu"
          className="ghost menu-toggle"
          id="menu-actions"
          onClick={() =>
            setOpenMenu((m) =>
              m === "actions" ? null : "actions",
            )
          }
          type="button"
        >
          ⋮
        </button>

        {/* LEFT popover (nav). Mounted in both states so it can transition; `.hmenu` is
            `display:none` on desktop entirely. */}
        <div
          aria-hidden={openMenu !== "nav"}
          className={`hmenu hmenu-left${openMenu === "nav" ? " open" : ""}`}
          role="menu"
        >
          {back ? (
            <a
              className="ghost hmenu-item"
              href={back.target}
              onClick={() => setOpenMenu(null)}
              role="menuitem"
            >
              {back.label}
            </a>
          ) : null}
          {editableSetId ? (
            <button
              className="ghost hmenu-item"
              onClick={() => {
                setOpenMenu(null)
                begin()
              }}
              role="menuitem"
              type="button"
            >
              ✎ Rename
            </button>
          ) : null}
        </div>

        {/* RIGHT popover (actions) — the mobile mirror of `.chrome`. Undo/redo here carry
            no id: the canonical `#undo`/`#redo` live inline in `.chrome` (the e2e suite
            clicks those at desktop width), and duplicate ids would be invalid. */}
        <div
          aria-hidden={openMenu !== "actions"}
          className={`hmenu hmenu-right${openMenu === "actions" ? " open" : ""}`}
          role="menu"
        >
          <button
            className="ghost hmenu-item"
            disabled={!history.undo}
            onClick={() => {
              setOpenMenu(null)
              void runHistory("undo")
            }}
            role="menuitem"
            type="button"
          >
            ↶ Undo
          </button>
          <button
            className="ghost hmenu-item"
            disabled={!history.redo}
            onClick={() => {
              setOpenMenu(null)
              void runHistory("redo")
            }}
            role="menuitem"
            type="button"
          >
            ↷ Redo
          </button>
          <div className="hmenu-scheme">
            <ColorSchemeSwitcher icons={schemeIcons} />
          </div>
        </div>
      </div>

      {/* The info line: the sub help/now-playing text, and the status toast beside it.
          `#status` used to sit on the `.bar` pinned to `width: 9ch`, so a real message
          ("Play failed on … Connection refused") wrapped into a ~12-line column that
          forced the header ~300px tall. Here it shares the full-width row with `#sub`,
          each on ONE ellipsised line (full text on hover via a `Tooltip`), so the header
          height is stable no matter the message. Kept as two elements so `#sub` always
          carries its own text (channels-test reads it) independent of any active toast. */}
      <div className="infoline">
        <p className="sub" hidden={isSubHidden} id="sub">
          {sub}
        </p>
        <Tip label={status.msg}>
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
        </Tip>
      </div>
    </header>
  )
}
