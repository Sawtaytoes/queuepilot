import type { MenuItem } from "@charcuterie/ui"
import { Menu } from "@charcuterie/ui"
import { useState } from "react"
import { useNavigate } from "react-router"
import { api } from "../lib/api"
import { entryTitle } from "../lib/searchGroups"
import type { RegistrySet, SearchHit } from "../lib/types"
import { refreshData } from "../state/live"
import { openSetModal } from "../state/overlays"
import {
  queueIds,
  setStatus,
  useStore,
} from "../state/store"
import {
  homeScroll,
  setCollapsed,
  setFilter,
  useUi,
} from "../state/ui"
import { EditionBadge } from "./EditionBadge"
import { Poster } from "./Poster"
import { SearchDropdown } from "./SearchDropdown"
import { SelectListbox } from "./SelectListbox"

/**
 * The Home toolbar: one search across every library any queue draws from, plus the
 * queue filter and the create/navigate buttons.
 *
 * Each result offers "Add to" listing only the queues whose libraries include
 * that result's section — and **the results stay open after an add**, so several
 * titles can fan out to different queues in one go.
 *
 * `#tools` is a single element the app re-parents between `#gslot-wide` (the
 * sticky header) and `#gslot-narrow` (the top of the Home content) at 760px,
 * because the header is far too tight in the Narrow View. `ui-test` asserts the physical
 * parent, so this must render inside the slot rather than merely look like it does.
 */
export function Toolbar() {
  const navigate = useNavigate()
  const { data, reg } = useStore()
  const { collapsed, filter } = useUi()
  const [openMenu, setOpenMenu] = useState<number | null>(
    null,
  )
  const [addPosition, setAddPosition] = useState("top")

  /*
   * The document-level Escape listener that used to sit here is GONE, and its whole
   * reason for existing went with it.
   *
   * It existed because the hand-rolled menu heard Escape on its own `onKeyDown`, which
   * requires focus to be inside the menu — and the no-compatible-queue state had no
   * focusable row at all, so focus stayed on the `.addto` trigger (a SIBLING of the
   * menu) and Escape did nothing. `Menu`'s dismissal is floating-ui's `useDismiss`,
   * which listens on the DOCUMENT, so Escape closes it from the trigger, from a row, or
   * from anywhere else. Outside-press dismissal came with it.
   */

  const ids = queueIds(data)
  const isAllCollapsed =
    ids.length > 0 && ids.every((id) => collapsed.has(id))

  const libTitle = (sectionId: number) =>
    (reg?.libraries || []).find((x) => x.id === sectionId)
      ?.title ?? `Library ${sectionId}`

  return (
    // F2: `compact` density takes the 44px MIN_TOUCH_TARGET floor down over
    // --control-height-md (2.25rem), de-chunkifying the header controls on desktop via the
    // token axis rather than an app override. The Add-to picker here is now a `SelectListbox`
    // (themed Listbox, no native <select>) — the rich-select fix the Listbox handoff wanted.
    // (decision `2026-08-07-plex-channels-pickers-are-listbox-not-native-select`)
    <div data-density="compact" id="tools">
      <div className="gsearch-wrap">
        <SearchDropdown<SearchHit>
          doSearch={async (q) => {
            const { results } = await api<{
              results: SearchHit[]
            }>(
              "GET",
              `/api/search?q=${encodeURIComponent(q)}`,
            )

            return results
          }}
          inputId="gsearch"
          listId="gresults"
          onClose={() => setOpenMenu(null)}
          placeholder="Add to any queue — search all libraries…"
          rowFor={(hit, index) => {
            // `entryTitle` appends the EDITION when Plex gave the item one — this menu adds
            // to a QUEUE, so it writes the same entry the in-queue add box does and must
            // name the item the same way.
            const label = entryTitle(hit)
            const compatible = (reg?.sets ?? []).filter(
              (s) =>
                s.source === "queue" &&
                s.sections.includes(hit.sectionId),
            )

            const addToQueue = async (s: RegistrySet) => {
              setStatus(`Adding to ${s.label}…`)

              try {
                await api(
                  "POST",
                  `/api/queues/${s.id}/items`,
                  {
                    position: addPosition,
                    value: {
                      ratingKey: hit.ratingKey,
                      title: label,
                    },
                  },
                )
                setStatus(
                  `Added “${hit.title}” to ${s.label}`,
                  "ok",
                )
                // Background: update the shelves but keep the results open for the
                // next pick.
                refreshData()
              } catch (err) {
                setStatus(
                  "Add failed: " + (err as Error).message,
                  "err",
                )
              }
            }

            /**
             * The no-compatible-queue case is one DISABLED item, not an empty menu:
             * `Menu` renders `items` and nothing else, and a panel with no rows says
             * nothing at all. Disabled keeps the sentence announced and skipped by the
             * arrow keys (`MenuAction` never registers a disabled item).
             */
            const menuItems: MenuItem[] =
              compatible.length === 0
                ? [
                    {
                      isDisabled: true,
                      key: "none",
                      label: `No queue includes “${libTitle(hit.sectionId)}” — add it to a queue via its ⚙.`,
                      onSelect: () => {},
                    },
                  ]
                : compatible.map((s) => ({
                    key: s.id,
                    label: s.label,
                    onSelect: () => void addToQueue(s),
                  }))

            return {
              content: (
                <>
                  <Poster
                    cover={hit.cover}
                    ratingKey={hit.ratingKey}
                  />
                  <span className="ginfo">
                    {/* `.gtitle` keeps title, year and edition on ONE line — `.ginfo` is a
                        flex column, so each of them would otherwise stack. */}
                    <span className="gtitle">
                      {hit.title}{" "}
                      <span className="y">
                        {hit.year || ""}
                      </span>
                      <EditionBadge hit={hit} />
                    </span>
                    <span className="glib">
                      {libTitle(hit.sectionId)}
                    </span>
                  </span>
                  {/*
                    A `Menu`, not a `Picker`/`Listbox`: every row PERFORMS an add and
                    leaves no selected value behind (the results deliberately stay open
                    for the next title). `menuitem` does something; `option` is
                    something. The Add-to POSITION control beside the search box is the
                    opposite case and is correctly a `SelectListbox`.
                  */}
                  <Menu
                    className="addtomenu"
                    isVisible={openMenu === index}
                    items={menuItems}
                    onDismiss={() => setOpenMenu(null)}
                    trigger={
                      <button
                        className="addto"
                        onClick={(e) => {
                          e.stopPropagation()
                          setOpenMenu((cur) =>
                            cur === index ? null : index,
                          )
                        }}
                        type="button"
                      >
                        Add to
                        {/* Decoration only — `useRole` already writes
                            `aria-haspopup="menu"` and `aria-expanded` here. */}
                        <span aria-hidden="true"> ▾</span>
                      </button>
                    }
                  />
                </>
              ),
              // The Add-to button owns its own clicks; a row pick is "open my menu", so
              // it must not fire from inside it. `.qmenu` used to be listed here too —
              // the panel is a PORTAL child of <body> now, so it is not inside the `<li>`
              // this delegated handler walks up from and cannot reach it at all.
              ignoreSelector: ".addto",
              // Row pick (click anywhere on it, or Enter) = open its Add-to menu.
              pick: () =>
                setOpenMenu((cur) =>
                  cur === index ? null : index,
                ),
            }
          }}
        >
          <label className="addpos">
            <span className="addlbl">Add to</span>
            {/* No `key`: `addPosition` is this toolbar's own `useState` and nothing
                else writes it, so the DOM and React have one owner between them.
                Keying it would remount the control on the user's own pick and take
                their focus with it. */}
            <SelectListbox
              id="gaddpos"
              label="Add to"
              onChange={setAddPosition}
              options={[
                { label: "Top (plays next)", value: "top" },
                { label: "Bottom", value: "bottom" },
              ]}
              value={addPosition}
            />
          </label>
        </SearchDropdown>
      </div>

      <input
        id="qfilter"
        onChange={(e) => setFilter(e.target.value.trim())}
        placeholder="Filter queues…"
        type="search"
        value={filter}
      />
      <button
        className="ghost"
        id="collapseall"
        onClick={() =>
          setCollapsed(
            isAllCollapsed ? new Set() : new Set(ids),
          )
        }
        type="button"
      >
        {isAllCollapsed ? "Expand all" : "Collapse all"}
      </button>
      <button
        className="ghost accent"
        id="newqueue"
        onClick={() => openSetModal(null, "movies")}
        type="button"
      >
        ＋ New queue
      </button>
      <button
        className="ghost"
        id="channelslink"
        onClick={() => {
          homeScroll.y = window.scrollY
          navigate("/channels")
        }}
        type="button"
      >
        Pools ›
      </button>
    </div>
  )
}
