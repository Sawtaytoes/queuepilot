import type { MenuItem } from "@charcuterie/ui"
import {
  Button,
  EmptyState,
  Menu,
  Spinner,
  VirtualizedGrid,
} from "@charcuterie/ui"
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"

import { CheckboxGroup } from "../components/CheckboxGroup"
import { EditionBadge } from "../components/EditionBadge"
import { Poster } from "../components/Poster"
import { api } from "../lib/api"
import type {
  Library,
  PendingItem,
  PendingResponse,
  RegistrySet,
} from "../lib/types"
import { refreshData } from "../state/live"
import { setStatus, useStore } from "../state/store"

/**
 * One tile's height in CSS px, as the windowed grid's starting guess.
 *
 * Measured off the running page rather than derived: a 158px column carries a 2:3 poster
 * (237px) plus the title, the library name and the two controls. Loaded tiles came back
 * between 166px (no artwork yet) and 496px (a two-line title over wrapped buttons), so this
 * is the middle of a real spread and not a computed ideal.
 *
 * Only the FIRST paint depends on it — `VirtualizedGrid` measures every row it mounts and
 * corrects itself. What a bad guess costs is a scrollbar that resizes under the thumb on the
 * first drag, which is why it is measured at all rather than left at a round number.
 */
const TILE_BLOCK_SIZE = 340

/**
 * The most columns the grid will draw.
 *
 * `auto-fill` gave 7 at 1280px, 10 at 1920px and 14 at 2560px, so 14 keeps today's density
 * everywhere the household actually looks at this page and stops an ultrawide from going to
 * twenty-one. Posters are the one content type that genuinely wants many narrow columns —
 * the shape is 2:3 and the eye reads a wall of them — which is why this is so far above
 * `AdaptiveGrid`'s default of three.
 */
const MAX_COLUMNS = 14

/**
 * PENDING — what arrived in the libraries that nothing is going to play.
 *
 * The owner's ask (2026-08-17): *"a 'Pending' or 'New' area to show if there are new movies or
 * shows added and allow me to specify the queues to add them IF they're not already picked up
 * by one."* The **if** is the feature. Everything recently added is Plex's own Recently Added
 * and needs no app; the useful list is the one that has already subtracted every pool rule and
 * every queue entry.
 *
 * So the three affordances are the three answers to "why is this here?":
 *
 * - **Add to** — it should be in a queue. Only queues whose libraries include the item are
 *   offered, the same rule the Home toolbar's search uses. A Charcuterie `Menu`, because each
 *   row PERFORMS an add and leaves no selected state behind — see the note on the `Menu`
 *   below.
 * - **Dismiss** — no. Per item, because skipping one film must not hide the twelve after it.
 * - **Mark all as seen** — none of this, and do not ask again. One watermark, one write.
 */
export function PendingView({
  isHidden,
}: {
  isHidden: boolean
}) {
  const { reg } = useStore()
  const [items, setItems] = useState<PendingItem[] | null>(
    null,
  )
  const [openMenu, setOpenMenu] = useState<string | null>(
    null,
  )
  /**
   * The library filter, as the server resolved it.
   *
   * `selected` is what the screen DREW from, not what `pending.yaml` stores — the two differ
   * exactly while nobody has chosen, and showing the stored value there would paint every box
   * unchecked over a page full of items. `isDefault` carries the distinction the resolved
   * list erases, so the reset is offered only when it would do something.
   */
  const [libraries, setLibraries] = useState<Library[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [isDefault, setIsDefault] = useState(true)

  /**
   * The selection the NEXT toggle is computed from.
   *
   * A mirror of `selected`, and not a convenience: a read of the state variable inside a
   * click handler is the value from the render that made the handler. Ticking three boxes
   * faster than the round trip made all three compute from the same base, so the second and
   * third each dropped the one before — the exact shape of "untick them all" leaving boxes
   * ticked.
   */
  const selectedNow = useRef<number[]>([])

  const applySelected = (next: number[]) => {
    selectedNow.current = next
    setSelected(next)
  }

  /**
   * Which read is the newest.
   *
   * `/api/pending` takes a second or two — it is one container read per library — so a
   * second toggle starts before the first has answered, and without a ticket the SLOWER
   * response wins whichever order they were sent in. The screen then shows the libraries
   * from the click before last.
   */
  const loadTicket = useRef(0)

  const load = useCallback(async () => {
    const ticket = ++loadTicket.current
    setItems(null)

    try {
      const found = await api<PendingResponse>(
        "GET",
        "/api/pending",
      )

      // A newer read started while this one was in flight. Its answer is the true one, and
      // it is coming — dropping this reply is the whole point of the ticket.
      if (ticket !== loadTicket.current) return

      setItems(found.items)
      setLibraries(found.libraries ?? [])
      applySelected(found.selected ?? [])
      setIsDefault(found.isDefault ?? true)
    } catch (e) {
      if (ticket !== loadTicket.current) return
      setItems([])
      setStatus(
        `Pending failed: ${(e as Error).message}`,
        "err",
      )
    }
  }, [])

  /**
   * Write a new library selection, then re-read the screen.
   *
   * `null` clears the choice and restores the default, which is a different write from `[]`
   * — "I have not said" against "I said none". The reset button sends the first; unchecking
   * the last box sends the second, and gets a legitimately empty page.
   *
   * The re-read is a full `load()` rather than a local filter of `items`. Narrowing the
   * libraries can only remove rows, so filtering in the browser would look right — but
   * WIDENING them has to fetch, and one path that is always correct beats two where the
   * cheap one is a special case waiting to drift.
   */
  const chooseLibraries = async (next: number[] | null) => {
    // Optimistic, so the box responds to the click rather than to the round trip. `load()`
    // overwrites this with the server's answer either way.
    if (next !== null) applySelected(next)
    setIsDefault(next === null)

    try {
      await api("POST", "/api/pending/libraries", {
        libraries: next,
      })
      await load()
    } catch (e) {
      setStatus(
        `Could not save the libraries: ${(e as Error).message}`,
        "err",
      )
      await load()
    }
  }

  useEffect(() => {
    // Only when the view is actually on screen: this is one container read per video
    // library, and the landing route must not pay for a screen nobody opened.
    if (!isHidden) void load()
  }, [isHidden, load])

  const queuesFor = (sectionId: number): RegistrySet[] =>
    (reg?.sets ?? []).filter(
      (s) =>
        s.source === "queue" &&
        s.sections.includes(sectionId),
    )

  const addTo = async (
    item: PendingItem,
    set: RegistrySet,
  ) => {
    // No `setOpenMenu(null)` here: choosing an item is what dismisses a `Menu`, and
    // `onDismiss` already clears this.
    setStatus(`Adding to ${set.label}…`)

    try {
      // `added: false` means the queue ALREADY names this item — by a bare title, which keys
      // differently from the ratingKey posted here and so used to slip past the duplicate
      // check and land a second copy. Saying "Added" for that would be a lie, and it is the
      // exact case the owner reported.
      const { added } = await api<{ added?: boolean }>(
        "POST",
        `/api/queues/${set.id}/items`,
        {
          position: "bottom",
          value: {
            ratingKey: item.ratingKey,
            title: `${item.title}${item.year ? ` (${item.year})` : ""}`,
          },
        },
      )
      setStatus(
        added === false
          ? `“${item.title}” is already in ${set.label}`
          : `Added “${item.title}” to ${set.label}`,
        "ok",
      )
      refreshData()
      // It is covered now, so it leaves the list without a second round trip.
      setItems((prev) =>
        (prev ?? []).filter(
          (x) => x.ratingKey !== item.ratingKey,
        ),
      )
    } catch (e) {
      setStatus(
        `Add failed: ${(e as Error).message}`,
        "err",
      )
    }
  }

  /**
   * The rows of one tile's Add-to menu.
   *
   * The no-compatible-queue case is a single **disabled** item rather than the loose
   * `<p>` the hand-rolled menu had. `Menu` takes `items`, and an empty `items` is an
   * empty panel that says nothing; a disabled `menuitem` keeps the sentence inside the
   * menu where a screen reader reaches it by arrowing, announces itself as unavailable,
   * and is skipped by the arrow keys because `MenuAction` never registers it. It is the
   * difference between "you cannot do this right now" and "this does not exist".
   */
  const menuItemsFor = (
    item: PendingItem,
    compatible: RegistrySet[],
  ): MenuItem[] =>
    compatible.length === 0
      ? [
          {
            isDisabled: true,
            key: "none",
            label: `No queue draws from “${item.librarySectionTitle}” — add it to one via its ⚙.`,
            onSelect: () => {},
          },
        ]
      : compatible.map((s) => ({
          key: s.id,
          label: s.label,
          onSelect: () => void addTo(item, s),
        }))

  const dismiss = async (item: PendingItem) => {
    setItems((prev) =>
      (prev ?? []).filter(
        (x) => x.ratingKey !== item.ratingKey,
      ),
    )

    try {
      await api("POST", "/api/pending/dismiss", {
        ratingKey: item.ratingKey,
      })
      setStatus(`Dismissed “${item.title}”`, "ok")
    } catch (e) {
      setStatus(
        `Dismiss failed: ${(e as Error).message}`,
        "err",
      )
      await load()
    }
  }

  const markAllSeen = async () => {
    if (!items?.length) return
    if (
      !confirm(
        `Mark all ${items.length} as seen?\n\nThey stop showing up here. Nothing is deleted and nothing is added to a queue.`,
      )
    )
      return

    setItems([])

    try {
      await api("POST", "/api/pending/seen", {})
      setStatus("Marked all as seen", "ok")
    } catch (e) {
      setStatus(`Failed: ${(e as Error).message}`, "err")
      await load()
    }
  }

  return (
    <main className="view" hidden={isHidden} id="pending">
      <div className="pendinghead">
        <p className="muted">
          Added to the libraries below, and{" "}
          <strong>not</strong> picked up by any pool rule or
          queue, and not already watched. Anything a
          Filtered Pool already sweeps up is not listed —
          that is the point of the screen.
        </p>
        <Button
          appearance="ghost"
          id="pending-seen"
          intent="neutral"
          isDisabled={!items?.length}
          onClick={() => void markAllSeen()}
        >
          Mark all as seen
        </Button>
      </div>

      {/*
        WHICH libraries this screen draws from — an include list, and the owner's words for
        why it is not an exclude one:

          "Pending is for new additions not in a queue, not watched, from specific libraries
          (not the inverse). So instead of exclude, just have it be include."

        The difference is what happens to a library nobody has thought about. Under an
        exclude list a new Plex library joins the screen and has to be noticed and named to
        get rid of; under an include list it stays out until someone asks for it. On a
        screen whose whole job is subtraction, that is the correct default direction.

        A `CheckboxGroup`, which is what the set modal's libraries already are — same control,
        same `.libs` grid, so choosing libraries looks the same wherever it happens.
      */}
      <div className="pendinglibs" id="pending-libraries">
        <div className="pendinglibshead">
          <span className="muted">Libraries</span>
          {/*
            Only offered when it would do something. `null` clears the choice and restores
            the default; it is NOT the same write as unchecking every box, which is a real
            answer meaning no libraries at all.
          */}
          <Button
            appearance="ghost"
            intent="neutral"
            isDisabled={isDefault}
            onClick={() => void chooseLibraries(null)}
            size="sm"
          >
            Back to default
          </Button>
        </div>

        <CheckboxGroup
          checked={selected}
          id="pending-libs"
          // Computed from `selectedNow`, never from `selected`: three ticks inside one round
          // trip would otherwise each start from the same stale base and undo each other.
          onToggle={(id, isChecked) =>
            void chooseLibraries(
              isChecked
                ? [...selectedNow.current, id]
                : selectedNow.current.filter(
                    (x) => x !== id,
                  ),
            )
          }
          options={libraries.map((l) => ({
            label: l.title,
            value: l.id,
          }))}
          // The server re-resolves the selection on every write, and "Back to default" can
          // change every box without anyone touching one — the second writer this repo's
          // uncontrolled-checkbox rule wants named.
          seedKey={`${isDefault}:${selected.join(",")}`}
        />
      </div>

      {items === null ? (
        <Spinner label="Looking for new titles…" />
      ) : items.length === 0 ? (
        <EmptyState
          description="Everything in your libraries is already covered by a pool or a queue."
          heading="Nothing pending"
        />
      ) : (
        <div id="pendinggrid">
          {/*
          A `VirtualizedGrid`, because this list is unbounded and the browser was paying for
          all of it. Measured on the live page before the change: 2,162 tiles, 19,933 DOM
          nodes, 2,162 `<img>`, 4,371 `<button>`, 7.8 seconds to settle and ~43fps while
          scrolling. Nothing here was wrong except how much of it existed at once.

          The wrapping `<div id="pendinggrid">` is kept because the grid element is now the
          component's own `<ul>`: `#pendinggrid li` is what four e2e suites and the
          borrowed-class audit select on, and an id passed through the library would have
          been a prop that exists for this repo's test selectors.

          `minColumnInlineSize` is `--tile`, so the density is the one this page already had.
          Without it the grid would take `AdaptiveGrid`'s 384px floor and three columns, and
          a 2:3 poster in a 600px column is 900px tall.
          */}
          <VirtualizedGrid
            getItemKey={(item) => item.ratingKey}
            itemBlockSize={TILE_BLOCK_SIZE}
            items={items}
            label="Pending titles"
            maxColumns={MAX_COLUMNS}
            minColumnInlineSize={158}
            renderItem={(item) => {
              const compatible = queuesFor(item.sectionId)

              return (
                <div className="pendingtile">
                  <Poster
                    cover={null}
                    ratingKey={item.ratingKey}
                  />
                  <span className="ptitle">
                    {item.title}
                    {item.year ? (
                      <span className="y">
                        {" "}
                        {item.year}
                      </span>
                    ) : null}
                    {/* The SHARED badge, not a fifth copy of the same `<span>` — this file
                      carried the copy, and a copy is exactly how the four search pickers
                      ended up with one of them drawing an edition and three not (#139).
                      `PendingItem` names `editionTitle` the same way a `SearchHit` does,
                      which is all the component asks for. */}
                    <EditionBadge hit={item} />
                  </span>
                  <span className="glib">
                    {item.librarySectionTitle}
                  </span>
                  <div className="pendingactions">
                    {/*
                    A `Menu`, NOT a `Picker`/`Listbox`, and the distinction is the one
                    Charcuterie's own `Menu` states: a `menuitem` DOES something, an
                    `option` IS something. Choosing "Bob — Movies" here POSTs the add and
                    keeps no selected value — the tile leaves the list entirely — so
                    `role="menu"` is the true role and a listbox here would be the same
                    mistake mux-magic's `TypePicker` made from the other side.

                    What the hand-rolled `.qmenu` never had, and now comes for free:
                    arrow-key navigation, Home/End, Escape, outside-press dismiss, focus
                    moved into the panel on open and returned to the trigger on close.
                  */}
                    <Menu
                      className="addtomenu"
                      isVisible={
                        openMenu === item.ratingKey
                      }
                      items={menuItemsFor(item, compatible)}
                      onDismiss={() => setOpenMenu(null)}
                      trigger={
                        /*
                        A Charcuterie `Button`, and the class it used to carry (`.addto`)
                        is gone rather than kept as a handle. Its only stylesheet rules
                        are `.results .addto`, and a Pending tile has no `.results`
                        ancestor — so the trigger painted as bare text on this page while
                        looking styled in the source.

                        `Menu` CLONES its trigger rather than wrapping it, so the element
                        has to forward what the clone injects. `Button` does: its props
                        are `ComponentPropsWithRef<"button">` and everything it does not
                        destructure is spread straight onto the native `<button>` — the
                        `ref`, `aria-haspopup`, `aria-expanded`, `aria-controls` and the
                        dismiss handlers all land. `useClonedChild` composes rather than
                        replaces for the two props that are not values, so this `onClick`
                        and floating-ui's own both fire.

                        `outline`/`accent` rather than `solid`: this is the affirmative
                        action on the tile, but the page is a GRID and twenty filled
                        accent buttons is a wall of indigo. Outline is also what every
                        other secondary control in this app wears, and what `Picker`'s
                        trigger wears.
                      */
                        <Button
                          appearance="outline"
                          data-testid="pending-addto"
                          /* Decoration. `useRole` already puts `aria-haspopup="menu"` and
                           `aria-expanded` on this button, so a glyph in the accessible
                           name would only say it twice. */
                          iconEnd={
                            <span aria-hidden="true">
                              ▾
                            </span>
                          }
                          intent="accent"
                          onClick={() =>
                            setOpenMenu((cur) =>
                              cur === item.ratingKey
                                ? null
                                : item.ratingKey,
                            )
                          }
                          size="sm"
                        >
                          Add to
                        </Button>
                      }
                    />
                    {/*
                    Also a `Button`, for the same reason: `.exclude` is only ever
                    `.tile .exclude`, and this list item's class is `pendingtile`. The
                    owner's words were "Dismiss isn't a button", and it was not one.

                    `outline`/`neutral`, NOT `ghost`: ghost is transparent until hovered,
                    which is the defect being fixed rather than a fix for it. And not
                    `danger` — dismissing writes one ratingKey to `pending.yaml`, deletes
                    nothing and adds nothing, so red would overstate it twenty times over
                    on a full grid. Quiet, but visibly a control, and secondary to Add to
                    because Add to is the answer this screen is asking for.
                  */}
                    <Button
                      appearance="outline"
                      data-testid="pending-dismiss"
                      intent="neutral"
                      onClick={() => void dismiss(item)}
                      size="sm"
                    >
                      Dismiss
                    </Button>
                  </div>
                </div>
              )
            }}
          />
        </div>
      )}
    </main>
  )
}
