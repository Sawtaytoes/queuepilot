import type { MenuItem, MenuProps } from "@charcuterie/ui"
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Menu,
  SegmentedControl,
  Spinner,
  VirtualizedGrid,
} from "@charcuterie/ui"
import type { ReactElement } from "react"
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"

import { CheckboxGroup } from "../components/CheckboxGroup"
import { EditionBadge } from "../components/EditionBadge"
import { Poster } from "../components/Poster"
import { Tip } from "../components/Tip"
import { api } from "../lib/api"
import { startLabel } from "../lib/tileFace"
import type {
  ChannelMember,
  Library,
  PendingItem,
  PendingResponse,
  RegistrySet,
  StartPoint,
} from "../lib/types"
import { refreshData } from "../state/live"
import {
  openSetModal,
  openStartModal,
} from "../state/overlays"
import { usePendingView } from "../state/pendingView"
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
 * One LIST row's height in CSS px, as the windowed grid's starting guess.
 *
 * A row is a fixed 84px poster beside the words, so it varies only with how many lines the
 * title takes and whether the buttons wrap — a much tighter spread than the poster wall's.
 * Corrected by measurement on the first mount, exactly like `TILE_BLOCK_SIZE`.
 */
const ROW_BLOCK_SIZE = 132

/**
 * The narrowest a LIST row may be before the grid takes a column away.
 *
 * Measured, not chosen: "Add to ▾" + "Start at…" + "Dismiss" with their gaps is ~285px, the
 * poster column is 84px and the gap between them 12px. At 330px the three buttons wrapped to
 * a second line on every show — which is the ragged-height problem this view exists to avoid,
 * arriving by a different door.
 */
const ROW_MIN_INLINE_SIZE = 400

/** Add this to a queue. */
const PlusGlyph = () => (
  <svg
    aria-hidden="true"
    height="14"
    viewBox="0 0 14 14"
    width="14"
  >
    <path
      d="M7 1.5v11M1.5 7h11"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
    />
  </svg>
)

/** Choose where this starts. A clock face, not the "⏱" character: a glyph that is a tofu
 *  box in some fonts is the same defect the Watched chip was written to avoid. */
const StartGlyph = () => (
  <svg
    aria-hidden="true"
    height="14"
    viewBox="0 0 14 14"
    width="14"
  >
    <circle
      cx="7"
      cy="7"
      fill="none"
      r="5.5"
      stroke="currentColor"
      strokeWidth="1.6"
    />
    <path
      d="M7 3.8V7l2.3 1.6"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.6"
    />
  </svg>
)

/** Dismiss — the same ✕ the queue tile's remove control draws. */
const CrossGlyph = () => (
  <svg
    aria-hidden="true"
    height="12"
    viewBox="0 0 12 12"
    width="12"
  >
    <path
      d="M1.5 1.5l9 9M10.5 1.5l-9 9"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
    />
  </svg>
)

/**
 * A pending item, dressed as the entry the start picker takes.
 *
 * `StartModal` is driven by `EntryActions`, whose `item` is a queue entry or a channel
 * member — both of which exist in a set. A pending item is in NO set yet, which is the whole
 * point of picking its start here: the choice is held in this view and written after the add
 * (decision `2026-08-22-pending-picks-the-start-episode-before-the-add`).
 *
 * `index: -1` is the one lie in it, and it is unreachable: `index` addresses a member inside
 * a channel's stored array, and the only writer this entry ever gets is the local `save`
 * below.
 */
const asStartEntry = (
  item: PendingItem,
  start: StartPoint | null,
): ChannelMember => ({
  childCount: null,
  cover: null,
  index: -1,
  nextEp: null,
  ratingKey: item.ratingKey,
  resolved: true,
  start,
  title: item.title,
  type: item.type,
  year: item.year,
})

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
  const { density, setDensity } = usePendingView()
  const [items, setItems] = useState<PendingItem[] | null>(
    null,
  )
  /**
   * The start episode chosen for an item that is not in a queue yet, keyed by ratingKey.
   *
   * Held here and written on the add, which is the order the owner asked for: *"You pick the
   * episode first, then Add to writes it."* It is deliberately NOT persisted — a choice you
   * made and never added is a choice you abandoned, and a stale one would be written into
   * whatever queue you picked days later.
   */
  const [starts, setStarts] = useState<
    Record<string, StartPoint>
  >({})
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

  /**
   * Add one item to one queue.
   *
   * Takes an id and a label rather than a `RegistrySet`, because "New queue…" adds to a
   * queue that was created a moment ago and is not in the registry the view is holding yet.
   */
  const addTo = async (
    item: PendingItem,
    set: { id: string; label: string },
  ) => {
    // No `setOpenMenu(null)` here: choosing an item is what dismisses a `Menu`, and
    // `onDismiss` already clears this.
    setStatus(`Adding to ${set.label}…`)

    try {
      // `added: false` means the queue ALREADY names this item — by a bare title, which keys
      // differently from the ratingKey posted here and so used to slip past the duplicate
      // check and land a second copy. Saying "Added" for that would be a lie, and it is the
      // exact case the owner reported.
      /*
        A COLLECTION is written as a collection entry, not as a rating key.

        `{collection: "<name>"}` is what the engine expands to the ordered members, which is
        the whole reason the owner wants collections on this screen — "I wanna add the
        collection, not a single or set of movies to retain order". The route takes
        `type: 'collection'` and normalizes the value; posting the collection's ratingKey
        instead would write one entry that plays one item.
      */
      const isCollection = item.type === "collection"
      const { added, key } = await api<{
        added?: boolean
        key?: string
      }>("POST", `/api/queues/${set.id}/items`, {
        position: "bottom",
        type: isCollection ? "collection" : undefined,
        value: isCollection
          ? { title: item.title }
          : {
              ratingKey: item.ratingKey,
              title: `${item.title}${item.year ? ` (${item.year})` : ""}`,
            },
      })

      /*
        The start point, written as a SECOND call against the entry the add just made.

        Not a `start` field on the add itself: `POST /items` takes a value and a position and
        answers the entry's key, and `PATCH /items/:key/start` is the one writer of a start
        point everywhere else in this app (the tile menu, the start modal, the entry sheet).
        A second door into the same write is a second place for the two to disagree.

        Only on a real add. `added: false` means the queue already names this item, and its
        existing entry has a start of its own that this screen has never seen — overwriting
        it from here would be an edit nobody asked for.
      */
      const start = starts[item.ratingKey]

      if (added !== false && key && start) {
        await api(
          "PATCH",
          `/api/queues/${set.id}/items/${encodeURIComponent(key)}/start`,
          { start },
        )
      }

      setStatus(
        added === false
          ? `“${item.title}” is already in ${set.label}`
          : start
            ? `Added “${item.title}” to ${set.label}, starting at ${startLabel(
                start,
              ).replace(/^Start /, "")}`
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
      setStarts(
        ({ [item.ratingKey]: _gone, ...rest }) => rest,
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
    /*
      `MenuProps["items"]` rather than `MenuEntry[]`: the separator's type is declared in
      Charcuterie's `Menu.tsx` but is NOT re-exported from the package index (only `MenuItem`
      and `MenuProps` are), so this is how the entry union is named from outside. An upstream
      gap, of the same kind as `FieldProps` spreading no rest props — worth closing there
      rather than working around further here.
    */
  ): MenuProps["items"] => [
    ...(compatible.length === 0
      ? [
          {
            isDisabled: true,
            key: "none",
            label: `No queue draws from “${item.librarySectionTitle}” yet — make one below.`,
            onSelect: () => {},
          } satisfies MenuItem,
        ]
      : compatible.map(
          (s): MenuItem => ({
            key: s.id,
            label: s.label,
            onSelect: () => void addTo(item, s),
          }),
        )),
    /*
      Make the queue this item is going into, without leaving the screen.

      The owner's report: *"I also cannot add a queue from here either. I wanted to create a
      new one to add one of the movies. Not a huge deal, but it would be nice to have that
      option somewhere. It's not in the dropdown."*

      A separator and a last row, so it never sits among the queues that already exist —
      choosing a queue and making one are different kinds of act, and the rule between them
      is what says so. `role="separator"`, which the arrow keys pass straight over.
    */
    { key: "sep", type: "separator" },
    {
      key: "new",
      label: "New queue…",
      onSelect: () =>
        openSetModal(null, undefined, {
          // The item's own library, ticked. Without it the new queue draws from nothing and
          // the add that follows would have nowhere to land.
          presetLibraries: [String(item.sectionId)],
          onCreated: (setId) =>
            void addTo(item, {
              id: setId,
              // The label the modal wrote is not read back here — `addTo` only names the
              // queue in a toast, and the registry refresh that follows carries the real
              // one onto the screen.
              label: "the new queue",
            }),
        }),
    },
  ]

  /**
   * Open the start picker for an item that is not in a queue yet.
   *
   * The same modal every other start point goes through — same episode list, same watched
   * marks, same "picked, never typed" rule — pointed at a local `save` instead of a PATCH.
   * Clearing (the modal's own "Start automatically") drops the pending choice.
   */
  const pickStart = (item: PendingItem) => {
    openStartModal({
      item: asStartEntry(
        item,
        starts[item.ratingKey] ?? null,
      ),
      refresh: () => {},
      save: async (start: StartPoint | null) => {
        setStarts((prev) => {
          const { [item.ratingKey]: _gone, ...rest } = prev

          return start
            ? { ...rest, [item.ratingKey]: start }
            : rest
        })
        // `commitStart` closes the modal before calling `save`; this resolves so its
        // success toast is the one that lands. Nothing is written until the add.
      },
      // No set: this item belongs to none yet, so the picker loads episodes from Plex
      // directly and speaks Plex's vocabulary. Every library Pending draws from is a Plex
      // video library, so there is no provider to choose.
      setId: null,
    })
  }

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
        <>
          {/*
            Two views of the same list, the way the queue grid has had since it was built.
            The owner asked for both here for the same reason — a wall of posters to skim,
            a list when the words matter (decision
            `2026-08-22-pending-has-a-poster-view-and-a-list-view`).
          */}
          <div className="pendingtoolbar">
            <span className="pcount">
              {`${items.length} pending`}
            </span>
            <SegmentedControl
              items={[
                { label: "Posters", value: "posters" },
                { label: "List", value: "list" },
              ]}
              label="View"
              onChange={(v) =>
                setDensity(
                  v === "list" ? "list" : "posters",
                )
              }
              selectedValue={density}
            />
          </div>

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

          `minColumnInlineSize` is the density's own: 158px for the poster wall (the width
          this page already had — without it the grid takes `AdaptiveGrid`'s 384px floor and
          a 2:3 poster in a 600px column is 900px tall), and 400px for a list row, which is
          what fits "Add to ▾ / Start at… / Dismiss" beside an 84px poster on one line.

          `key={density}` remounts on the switch. The grid measures rows and caches what it
          measured; a 340px poster tile and a 132px list row share nothing, and reusing the
          cache leaves the first screenful of the new view laid out to the old one's heights.
          */}
            <VirtualizedGrid
              getItemKey={(item) => item.ratingKey}
              itemBlockSize={
                density === "list"
                  ? ROW_BLOCK_SIZE
                  : TILE_BLOCK_SIZE
              }
              items={items}
              key={density}
              label="Pending titles"
              maxColumns={
                density === "list" ? 4 : MAX_COLUMNS
              }
              minColumnInlineSize={
                density === "list"
                  ? ROW_MIN_INLINE_SIZE
                  : 158
              }
              renderItem={(item) => {
                const compatible = queuesFor(item.sectionId)
                const start = starts[item.ratingKey]
                // Only a SHOW has an episode to start at. A film starts where films start.
                const isStartable = item.type === "show"

                /*
                  The Add-to menu, shared by both views because it is the same menu — only
                  its trigger differs (a named button in the list, a ＋ on a poster).

                  A `Menu`, NOT a `Picker`/`Listbox`: a `menuitem` DOES something and an
                  `option` IS something, and choosing "Bob — Movies" here POSTs the add and
                  keeps no selected value — the tile leaves the list entirely
                  (decision `2026-08-21-an-add-to-menu-is-a-menu-not-a-picker`).
                */
                const addMenu = (trigger: ReactElement) => (
                  <Menu
                    className="addtomenu"
                    isVisible={openMenu === item.ratingKey}
                    items={menuItemsFor(item, compatible)}
                    onDismiss={() => setOpenMenu(null)}
                    trigger={trigger}
                  />
                )

                const toggleMenu = () =>
                  setOpenMenu((cur) =>
                    cur === item.ratingKey
                      ? null
                      : item.ratingKey,
                  )

                /*
                  Title, library, and the chosen start — the words, in both views.

                  Nothing here is clamped and nothing is padded to a fixed height. A uniform
                  card was drawn and rejected: *"I don't like that because I'm losing content
                  and we're creating gaps."* So a long title takes the lines it needs and the
                  controls sit directly under whatever the words came to. The POSTER is the
                  one fixed thing, which is what keeps a row of artwork aligned.
                */
                const words = (
                  <>
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
                    {/* A collection says so, and says how big it is: the tile is otherwise
                        identical to a film's, and "The Muppets" the collection sits beside
                        "The Muppets" the film. `childCount` is Plex's own. */}
                    {item.type === "collection" ? (
                      <Badge
                        appearance="outline"
                        /* LAYOUT only, and the exception the component rule allows: the
                           tile is a flex column, so without `align-self: start` the chip
                           stretches the full width of the card. It carries no look — the
                           look is `appearance`/`intent`/`size`. NOT the app's
                           `.badge.collection`, which is the two-part queue-tile chip and
                           would render unstyled here for want of a `.badgename`. */
                        className="pcollection"
                        intent="accent"
                        size="sm"
                      >
                        {item.childCount
                          ? `Collection · ${item.childCount}`
                          : "Collection"}
                      </Badge>
                    ) : null}
                    <span className="glib">
                      {item.librarySectionTitle}
                    </span>
                    {/* Chosen, not yet written. The add is what writes it, so the tile has to
                        say so or the choice is invisible until it lands in a queue. */}
                    {start ? (
                      <span className="pstart">
                        {startLabel(start)}
                      </span>
                    ) : null}
                  </>
                )

                if (density === "list") {
                  return (
                    <div className="pendingrow">
                      <Poster
                        cover={null}
                        ratingKey={item.ratingKey}
                      />
                      <div className="pendingrowtext">
                        {words}
                        <div className="pendingactions">
                          {addMenu(
                            /*
                              A Charcuterie `Button`, and the class it used to carry
                              (`.addto`) is gone rather than kept as a handle: its only
                              stylesheet rules are `.results .addto`, and a Pending tile has
                              no `.results` ancestor, so the trigger painted as bare text
                              while looking styled in the source.

                              `Menu` CLONES its trigger, so the element has to forward what
                              the clone injects — `Button` spreads everything it does not
                              destructure onto the native `<button>`, so the `ref`, the ARIA
                              and the dismiss handlers all land.
                            */
                            <Button
                              appearance="outline"
                              data-testid="pending-addto"
                              iconEnd={
                                <span aria-hidden="true">
                                  ▾
                                </span>
                              }
                              intent="accent"
                              onClick={toggleMenu}
                              size="sm"
                            >
                              Add to
                            </Button>,
                          )}
                          {isStartable ? (
                            <Button
                              appearance="outline"
                              data-testid="pending-start"
                              intent="neutral"
                              onClick={() =>
                                pickStart(item)
                              }
                              size="sm"
                            >
                              {start
                                ? "Change start…"
                                : "Start at…"}
                            </Button>
                          ) : null}
                          {/*
                            `outline`/`neutral`, NOT `ghost`: ghost is transparent until
                            hovered, which is the defect this was fixed for rather than a fix
                            for it. And not `danger` — dismissing writes one ratingKey to
                            `pending.yaml`, deletes nothing and adds nothing, so red would
                            overstate it twenty times over on a full page.
                          */}
                          <Button
                            appearance="outline"
                            data-testid="pending-dismiss"
                            intent="neutral"
                            onClick={() =>
                              void dismiss(item)
                            }
                            size="sm"
                          >
                            Dismiss
                          </Button>
                        </div>
                      </div>
                    </div>
                  )
                }

                return (
                  <div className="pendingtile">
                    <Poster
                      cover={null}
                      ratingKey={item.ratingKey}
                    />
                    {words}
                    {/*
                      Icon controls, because a 158px column cannot hold three named buttons
                      and wrapping them is what pushed the controls of every tile to a
                      different height. `IconButton` REQUIRES a `label`, which is the
                      accessible name and the tooltip's words — the glyph never has to carry
                      the meaning alone.
                    */}
                    <div className="pendingactions">
                      {addMenu(
                        <Tip label="Add to a queue">
                          <IconButton
                            appearance="outline"
                            data-testid="pending-addto"
                            intent="accent"
                            label="Add to a queue"
                            onClick={toggleMenu}
                            size="sm"
                          >
                            <PlusGlyph />
                          </IconButton>
                        </Tip>,
                      )}
                      {isStartable ? (
                        <Tip
                          label={
                            start
                              ? `Starts at ${startLabel(start).replace(/^Start /, "")} — change it`
                              : "Choose the episode this starts at"
                          }
                        >
                          <IconButton
                            appearance="outline"
                            data-testid="pending-start"
                            intent={
                              start ? "accent" : "neutral"
                            }
                            label={
                              start
                                ? "Change the start episode"
                                : "Choose the start episode"
                            }
                            onClick={() => pickStart(item)}
                            size="sm"
                          >
                            <StartGlyph />
                          </IconButton>
                        </Tip>
                      ) : null}
                      <Tip label="Dismiss">
                        <IconButton
                          appearance="outline"
                          data-testid="pending-dismiss"
                          intent="neutral"
                          label="Dismiss"
                          onClick={() => void dismiss(item)}
                          size="sm"
                        >
                          <CrossGlyph />
                        </IconButton>
                      </Tip>
                    </div>
                  </div>
                )
              }}
            />
          </div>
        </>
      )}
    </main>
  )
}
