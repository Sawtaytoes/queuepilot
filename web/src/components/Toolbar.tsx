import { Button } from "@charcuterie/ui"
import { useEffect, useState } from "react"
import { api, thumbUrl } from "../lib/api"
import type { SearchHit } from "../lib/types"
import { refreshData } from "../state/live"
import { openSetModal } from "../state/overlays"
import { navigate } from "../state/route"
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
import { SearchDropdown } from "./SearchDropdown"
import { SelectListbox } from "./SelectListbox"

/**
 * The Home toolbar: one search across every library any queue draws from, plus the
 * queue filter and the create/navigate buttons.
 *
 * Each result offers "Add to ▾" listing only the queues whose libraries include
 * that result's section — and **the results stay open after an add**, so several
 * titles can fan out to different queues in one go.
 *
 * `#tools` is a single element the app re-parents between `#gslot-desktop` (the
 * sticky header) and `#gslot-mobile` (the top of the Home content) at 760px,
 * because the header is far too tight on a phone. `ui-test` asserts the physical
 * parent, so this must render inside the slot rather than merely look like it does.
 */
export function Toolbar() {
  const { data, reg } = useStore()
  const { collapsed, filter } = useUi()
  const [openMenu, setOpenMenu] = useState<number | null>(
    null,
  )
  const [addPosition, setAddPosition] = useState("top")

  /**
   * Escape closes the Add-to menu, from wherever focus happens to be.
   *
   * The menu already handles Escape on its own `onKeyDown`, and its `ref` focuses
   * the first button so that handler can hear it — but the menu has a state with NO
   * buttons ("No queue includes … — add it to a queue via its ⚙"). In that state
   * focus stays on the `.addto` trigger, which is a SIBLING of the menu, so the
   * menu's handler never fires and Escape did nothing at all. The menu then stayed
   * open indefinitely and the next click on `.addto` read as a toggle-CLOSED.
   *
   * A document listener is the right level for this: a menu is a dismissable layer,
   * and "Escape dismisses the topmost layer" is not a property of any one node
   * inside it.
   */
  useEffect(() => {
    if (openMenu === null) return

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null)
    }

    document.addEventListener("keydown", onKey)

    return () =>
      document.removeEventListener("keydown", onKey)
  }, [openMenu])

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
            const label = `${hit.title}${hit.year ? ` (${hit.year})` : ""}`
            const compatible = (reg?.sets ?? []).filter(
              (s) =>
                s.source === "queue" &&
                s.sections.includes(hit.sectionId),
            )

            return {
              content: (
                <>
                  <img
                    alt=""
                    src={thumbUrl(hit.ratingKey)}
                  />
                  <span className="ginfo">
                    {hit.title}{" "}
                    <span className="y">
                      {hit.year || ""}
                    </span>
                    <span className="glib">
                      {libTitle(hit.sectionId)}
                    </span>
                  </span>
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
                    Add to ▾
                  </button>
                  {openMenu === index ? (
                    <div
                      className="qmenu"
                      data-density="compact"
                      onKeyDown={(e) => {
                        const btns = [
                          ...e.currentTarget.querySelectorAll(
                            "button",
                          ),
                        ]

                        if (!btns.length) return

                        const i = btns.indexOf(
                          document.activeElement as HTMLButtonElement,
                        )

                        if (
                          e.key === "ArrowDown" ||
                          e.key === "ArrowUp"
                        ) {
                          e.preventDefault()
                          btns[
                            (i +
                              (e.key === "ArrowDown"
                                ? 1
                                : -1) +
                              btns.length) %
                              btns.length
                          ]?.focus()
                        } else if (e.key === "Escape") {
                          setOpenMenu(null)
                        }
                      }}
                      ref={(el) => {
                        el?.querySelector("button")?.focus()
                      }}
                    >
                      {compatible.length === 0 ? (
                        <p>
                          {`No queue includes “${libTitle(hit.sectionId)}” — add it to a queue via its ⚙.`}
                        </p>
                      ) : (
                        compatible.map((s) => (
                          // ghost Button, skin deleted — see PlayMenu. Still a native
                          // <button> (the qmenu keyboard nav queries `button` and
                          // focuses via document.activeElement).
                          <Button
                            appearance="ghost"
                            intent="neutral"
                            isFullWidth
                            key={s.id}
                            onClick={async (e) => {
                              e.stopPropagation()
                              setOpenMenu(null)
                              setStatus(
                                `Adding to ${s.label}…`,
                              )

                              try {
                                await api(
                                  "POST",
                                  `/api/queues/${s.id}/items`,
                                  {
                                    position: addPosition,
                                    value: {
                                      ratingKey:
                                        hit.ratingKey,
                                      title: label,
                                    },
                                  },
                                )
                                setStatus(
                                  `Added “${hit.title}” to ${s.label}`,
                                  "ok",
                                )
                                // Background: update the shelves but keep the
                                // results open for the next pick.
                                refreshData()
                              } catch (err) {
                                setStatus(
                                  "Add failed: " +
                                    (err as Error).message,
                                  "err",
                                )
                              }
                            }}
                          >
                            {s.label}
                          </Button>
                        ))
                      )}
                    </div>
                  ) : null}
                </>
              ),
              // The Add-to button and the menu own their own clicks; a row pick is
              // "open my menu", so it must not fire from inside them.
              ignoreSelector: ".addto, .qmenu",
              // Row pick (click anywhere on it, or Enter) = open its Add-to menu.
              pick: () =>
                setOpenMenu((cur) =>
                  cur === index ? null : index,
                ),
            }
          }}
        >
          <label className="addpos">
            Add to
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
          navigate("#/channels")
        }}
        type="button"
      >
        Channels ›
      </button>
    </div>
  )
}
