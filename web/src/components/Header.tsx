import {
  Button,
  ButtonLink,
  ColorSchemeSwitcher,
  IconButton,
  Header as PageFrameHeader,
  ProgressBar,
} from "@charcuterie/ui"
import { useEffect, useRef, useState } from "react"

/** Which header popover is open. Only one at a time, mux-magic's `PageHeader` model:
 * a left "nav" menu (back / rename) and a right "actions" menu (undo / redo / scheme).
 * These are the MOBILE mechanism — on desktop the same controls sit inline on the bar
 * and the toggles are `display:none`. */
type OpenMenu = "actions" | null

import { api } from "../lib/api"
import { queryClient } from "../lib/queryClient"
import { busy } from "../state/busy"
import { refreshData } from "../state/live"
import {
  bumpRevision,
  getState,
  refreshHistoryButtons,
  refreshHistorySnapshot,
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
  navigation?: React.ReactNode
  children?: React.ReactNode
}

export function Header({
  back,
  children,
  editableSetId,
  heading,
  isSubHidden,
  navigation,
  sub,
}: Props) {
  const { history, isRevalidating, status } = useStore()
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

      // Undo restores the whole store, not only queues.yaml. Repaint the store-backed shelf,
      // registry and people slices before the slower provider-backed refresh, and invalidate any
      // route-local server queries that may also describe the restored rows.
      await refreshHistorySnapshot()
      void queryClient.invalidateQueries()
      setStatus(dir === "undo" ? "Undone" : "Redone", "ok")
      // The file write pings SSE too. Resolve the lightweight snapshot's tiles immediately rather
      // than waiting for that event, which may already have fired while undo was writing.
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
    <PageFrameHeader id="apphead" ref={headerRef}>
      <div className="app-header-content">
        <div className="bar">
          {navigation}
          {/* "‹ Play" goes to a page, so it is a link too — same reasoning as the landing rows.
            `href` falls back to `/` only while `hidden`, since an anchor with no href is not
            focusable and would silently drop out of the tab order the moment `back` is null.
            A `ButtonLink` rather than a router `Link` in a borrowed skin: it is still an
            `<a href>` (middle-click, ⌘-click, "copy link address") and it still routes,
            because `main.tsx` injects react-router into the link seam. */}
          <ButtonLink
            appearance="outline"
            hidden={!back}
            href={back?.target ?? "/"}
            id="back"
            intent="neutral"
          >
            {back?.label ?? "← All queues"}
          </ButtonLink>
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
            <IconButton
              appearance="outline"
              className="namepen"
              hidden={!editableSetId}
              id="editname"
              intent="neutral"
              label="Rename"
              onClick={begin}
            >
              <PencilIcon />
            </IconButton>
          </Tip>
          {/* The desktop chrome cluster: undo / redo / scheme / the Home toolbar slot,
            pushed right with `margin-left: auto`. The h1 has `flex:1; min-width:0` and
            ellipsises, so it yields to this width. In the Narrow View the whole cluster is
            `display:none` and the right popover below mirrors it — the header is far too
            tight in the Narrow View to carry it inline (that was the 300px-tall header bug).
            `ui-test` reads `#gslot-wide #tools`, so that id and its child stay put. */}
          <div className="chrome">
            {/* Charcuterie `IconButton`s, and this pair is the component's OWN worked example:
              its docstring names "plex-channels renders raw glyphs (`↶`, `↷`, `▶`, `⚙`, `≡`)
              straight into a `<button>`" as the reason it exists. `label` is required and
              becomes the `aria-label`, so the name cannot go missing the way it can on a
              hand-rolled one — and the glyph stops being the accessible name.

              `.ghost` is Charcuterie's `outline`; `disabled` becomes `isDisabled`, which is
              the prop `ButtonProps` deliberately keeps instead of the native one.
              (decision `2026-08-21-a-component-configured-by-props-not-a-borrowed-class`) */}
            <Tip label="Undo last change">
              <IconButton
                appearance="outline"
                id="undo"
                intent="neutral"
                isDisabled={!history.undo}
                label="Undo last change"
                onClick={() => void runHistory("undo")}
              >
                <UndoIcon />
              </IconButton>
            </Tip>
            <Tip label="Redo">
              <IconButton
                appearance="outline"
                id="redo"
                intent="neutral"
                isDisabled={!history.redo}
                label="Redo"
                onClick={() => void runHistory("redo")}
              >
                <RedoIcon />
              </IconButton>
            </Tip>
            {/* Follows the OS light/dark scheme; cycles light → dark → system, persists
              the pick to localStorage (`charcuterie-scheme`) and writes `data-scheme`
              on `<html>`. */}
            <ColorSchemeSwitcher icons={schemeIcons} />
            <div id="gslot-wide">{children}</div>
          </div>

          {/* Narrow-View-only right toggle → the actions popover. */}
          <IconButton
            appearance="outline"
            aria-expanded={openMenu === "actions"}
            aria-haspopup="menu"
            className="menu-toggle"
            id="menu-actions"
            intent="neutral"
            label="Actions menu"
            onClick={() =>
              setOpenMenu((m) =>
                m === "actions" ? null : "actions",
              )
            }
          >
            <MoreIcon />
          </IconButton>

          {/* RIGHT popover (actions) — the Narrow View mirror of `.chrome`. Undo/redo here carry
            no id: the canonical `#undo`/`#redo` live inline in `.chrome` (the e2e suite
            clicks those at desktop width), and duplicate ids would be invalid. */}
          <div
            aria-hidden={openMenu !== "actions"}
            className={`hmenu hmenu-right${openMenu === "actions" ? " open" : ""}`}
            role="menu"
          >
            <Button
              appearance="outline"
              className="hmenu-item"
              intent="neutral"
              isDisabled={!history.undo}
              isFullWidth
              onClick={() => {
                setOpenMenu(null)
                void runHistory("undo")
              }}
              role="menuitem"
            >
              ↶ Undo
            </Button>
            <Button
              appearance="outline"
              className="hmenu-item"
              intent="neutral"
              isDisabled={!history.redo}
              isFullWidth
              onClick={() => {
                setOpenMenu(null)
                void runHistory("redo")
              }}
              role="menuitem"
            >
              ↷ Redo
            </Button>
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
        {/* PHASE 3 in progress: the page is painted from cache and the providers are being
          re-read behind it. A line at the top edge of the header rather than a chip beside
          the title, because the tiles that are about to change are BELOW it and at every
          scroll position — the owner asked to be told before they move, not after.

          Charcuterie's `ProgressBar`, indeterminate: the pass has no measurable progress (it
          is one request that either lands or does not), and an empty determinate bar reads as
          stalled. It is REMOVED from the DOM rather than hidden, so there is no permanent
          rule under the header that a later layout change has to work around. */}
        {isRevalidating ? (
          <ProgressBar
            id="revalidating"
            intent="accent"
            isIndeterminate
            label="Checking Plex and Kavita for changes"
            size="sm"
          />
        ) : null}
      </div>
    </PageFrameHeader>
  )
}

function PencilIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="18"
    >
      <path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z" />
    </svg>
  )
}

function UndoIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="18"
    >
      <path d="m9 7-5 5 5 5M4 12h9a6 6 0 0 1 6 6" />
    </svg>
  )
}

function RedoIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="18"
    >
      <path d="m15 7 5 5-5 5M20 12h-9a6 6 0 0 0-6 6" />
    </svg>
  )
}

function MoreIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      height="18"
      viewBox="0 0 24 24"
      width="18"
    >
      <circle cx="12" cy="5" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="12" cy="19" r="1.7" />
    </svg>
  )
}
