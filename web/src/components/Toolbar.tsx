import type { MenuItem } from "@charcuterie/ui"
import { Button, Menu } from "@charcuterie/ui"
import { useState } from "react"
import { api } from "../lib/api"
import { queueItemAddBody } from "../lib/searchGroups"
import type { RegistrySet, SearchHit } from "../lib/types"
import { refreshData } from "../state/live"
import {
  openDynModal,
  openSetModal,
} from "../state/overlays"
import { usePeople } from "../state/people"
import {
  curatedIds,
  setStatus,
  useStore,
} from "../state/store"
import { setCollapsed, setFilter, useUi } from "../state/ui"
import { EditionBadge } from "./EditionBadge"
import { Poster } from "./Poster"
import { QueuePeopleBadge } from "./QueuePeopleBadge"
import { SearchDropdown } from "./SearchDropdown"
import { Modal } from "./Modal"

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
  const { data, reg } = useStore()
  const people = usePeople()
  const { collapsed, filter, hasCollapsePreference } =
    useUi()
  const [openMenu, setOpenMenu] = useState<number | null>(
    null,
  )
  const [isChoosingType, setIsChoosingType] = useState(false)

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

  // Every Picks queue, which is every shelf this page draws — so Collapse all collapses
  // all of them. It was the priority-lane half until 2026-08-26, back when the random-lane
  // half was listed on the Rules page instead.
  const ids = curatedIds(data)
  const isAllCollapsed =
    ids.length > 0 &&
    (!hasCollapsePreference ||
      ids.every((id) => collapsed.has(id)))

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
              `/api/search?q=${encodeURIComponent(q)}&collections=1`,
            )

            return results
          }}
          inputId="gsearch"
          listId="gresults"
          onClose={() => setOpenMenu(null)}
          placeholder="Add to any queue — search all libraries…"
          rowFor={(hit, index) => {
            const isCollection = hit.type === "collection"
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
                  // New titles lead the queue. Collections use the same explicit typed
                  // payload as the queue page, so the server stores `{collection: <name>}`
                  // rather than treating the collection's rating key as an ordinary item.
                  queueItemAddBody(hit),
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
                  `Add failed: ${(err as Error).message}`,
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
                    // The queue's name, then WHO it is for. Every queue is called after its
                    // activity now, so four rows read "Movies & Shows" and the add lands
                    // wherever you guessed (owner, 2026-08-26).
                    label: (
                      <>
                        {s.label}
                        <QueuePeopleBadge
                          groups={people.groups}
                          members={
                            people.byQueue[s.id] ?? []
                          }
                          people={people.people}
                        />
                      </>
                    ),
                    onSelect: () => void addToQueue(s),
                  }))

            return {
              content: (
                <>
                  <Poster
                    cover={hit.cover}
                    ratingKey={
                      isCollection && !hit.hasThumb
                        ? null
                        : hit.ratingKey
                    }
                  />
                  <span className="ginfo">
                    {/* `.gtitle` keeps title, year and edition on ONE line — `.ginfo` is a
                        flex column, so each of them would otherwise stack. */}
                    <span className="gtitle">
                      {hit.title}{" "}
                      {isCollection ? (
                        <>
                          <span className="collbadge">
                            Collection
                          </span>{" "}
                          <span className="y">{`${hit.childCount || 0} items`}</span>
                        </>
                      ) : (
                        <>
                          <span className="y">
                            {hit.year || ""}
                          </span>
                          <EditionBadge hit={hit} />
                        </>
                      )}
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
                      /*
                        The SAME control the Pending tile's Add-to is — `outline` /
                        `accent` / `sm` — because they do the same thing one route apart,
                        and `.results .addto` was a second hand-painted spelling of it.
                        `Menu` CLONES its trigger and `Button` spreads what it does not
                        destructure onto the native `<button>`, so the `ref`, the ARIA and
                        the dismiss handlers all still land.
                      */
                      <Button
                        appearance="outline"
                        data-testid="results-addto"
                        iconEnd={
                          // Decoration only — `useRole` already writes
                          // `aria-haspopup="menu"` and `aria-expanded` here.
                          <span aria-hidden="true">▾</span>
                        }
                        intent="accent"
                        onClick={(e) => {
                          e.stopPropagation()
                          setOpenMenu((cur) =>
                            cur === index ? null : index,
                          )
                        }}
                        size="sm"
                      >
                        Add to
                      </Button>
                    }
                  />
                </>
              ),
              // The Add-to button owns its own clicks; a row pick is "open my menu", so
              // it must not fire from inside it. `.qmenu` used to be listed here too —
              // the panel is a PORTAL child of <body> now, so it is not inside the `<li>`
              // this delegated handler walks up from and cannot reach it at all.
              // ⚠️ Keyed on the `data-testid`, because the trigger is a `Button` and no
              // longer wears `.addto` — this selector is BEHAVIOUR, not a test hook: miss
              // it and a click on Add-to also fires the row's own pick.
              ignoreSelector:
                '[data-testid="results-addto"]',
              // Row pick (click anywhere on it, or Enter) = open its Add-to menu.
              pick: () =>
                setOpenMenu((cur) =>
                  cur === index ? null : index,
                ),
            }
          }}
        ></SearchDropdown>
      </div>

      <input
        id="qfilter"
        onChange={(e) => setFilter(e.target.value.trim())}
        placeholder="Filter queues…"
        type="search"
        value={filter}
      />
      {/* Three Charcuterie `Button`s, configured by props. `.ghost` here is Charcuterie's
          `outline` — the app class paints a surface background AND a border, which is what
          `outline` means; the borderless one is Charcuterie's `ghost`. `#tools button.accent`
          gave `＋ New queue` an accent border and accent text that fill on hover, which is
          exactly `intent="accent"` over the same `outline`.

          `#tools button.ghost`'s tighter padding and smaller face are NOT restated: `#tools`
          already carries `data-density="compact"`, so the component sizes itself from the
          density axis rather than from a per-toolbar override.
          (decision `2026-08-21-a-component-configured-by-props-not-a-borrowed-class`) */}
      <Button
        appearance="outline"
        id="collapseall"
        intent="neutral"
        onClick={() =>
          setCollapsed(
            isAllCollapsed ? new Set() : new Set(ids),
          )
        }
      >
        {isAllCollapsed ? "Expand all" : "Collapse all"}
      </Button>
      <Button
        appearance="outline"
        id="newqueue"
        intent="accent"
        onClick={() => setIsChoosingType(true)}
      >
        ＋ New queue
      </Button>
      <Modal
        footer={null}
        id="queue-type-modal"
        isOpen={isChoosingType}
        onClose={() => setIsChoosingType(false)}
        title="Queue type"
        titleId="queue-type-title"
      >
        <p>Choose how QueuePilot fills this queue.</p>
        <div className="queue-type-options">
          <Button
            appearance="outline"
            intent="accent"
            onClick={() => {
              setIsChoosingType(false)
              openSetModal(null, "priority")
            }}
            type="button"
          >
            <strong>Picks</strong>
            <span>Choose titles yourself, then arrange them in priority and random lanes.</span>
          </Button>
          <Button
            appearance="outline"
            intent="accent"
            onClick={() => {
              setIsChoosingType(false)
              openDynModal(null)
            }}
            type="button"
          >
            <strong>Rules</strong>
            <span>Set eligibility filters and let QueuePilot select matching titles.</span>
          </Button>
        </div>
      </Modal>
    </div>
  )
}
