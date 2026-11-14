import { Button, EmptyState } from "@charcuterie/ui"
import {
  Fragment,
  useCallback,
  useMemo,
  useRef,
} from "react"
import { Link, useLocation } from "react-router"
import { AlsoInDivider } from "../components/AlsoInDivider"
import { LandingFilterBar } from "../components/LandingFilterBar"
import { PeopleRow } from "../components/PeopleRow"
import {
  spliceOrder,
  useRowReorder,
} from "../hooks/useRowReorder"
import { api } from "../lib/api"
import { isRandomOrder } from "../lib/kind"
import { queueListNumbers, queueTitle } from "../lib/people"
import { WATCH_PLAY_PATH } from "../lib/routePaths"
import type { PeopleMatch } from "../lib/tonight"
import {
  missingRequiredPeople,
  peopleMatch,
  resolveMembers,
  rosterOrder,
  splitByMatch,
} from "../lib/tonight"
import type {
  QueuesResponse,
  RegistrySet,
  SetsResponse,
} from "../lib/types"
import { PLEX_WORDS } from "../lib/vocab"
import {
  parsePeople,
  parseProviders,
} from "../state/landingFilter"
import {
  openPlayMenu,
  openSetModal,
} from "../state/overlays"
import { usePeople } from "../state/people"
import {
  bumpRevision,
  getState,
  load,
  rotationChannels,
  setStatus,
  useStore,
} from "../state/store"
import { ChannelCard } from "./ChannelCard"
import { PlayCard } from "./PlayCard"

/**
 * ADMIN — the management landing. Every pool and queue as a posterless card: manage it or
 * open it for playback.
 * The configurators (posters, drag, filters) live behind the "Configure ›" links.
 * (decision `2026-07-21-queues-vs-channels-taxonomy-play-first-ia`)
 *
 * **ONE wrapped grid, not three columns.** Until 2026-08-19 the three kinds were three
 * fixed columns, and the shape of the page was decided by the taxonomy rather than by
 * what the household owns: a install with no curated pools painted two thirds of the
 * screen blank, and the household's real install ran the Ordered Queues column eight
 * cards deep beside a column of three. The kinds have not gone away — each card SAYS
 * which kind it is — but they no longer choose the layout, so the cards wrap to fill
 * whatever width there is and the Narrow View is one honest column instead of three
 * headings to scroll past.
 * (decision `2026-08-19-the-landing-is-one-wrapped-grid-of-typed-cards`)
 *
 * The filtered pools are DATA-DRIVEN, one card per rotation pool — Shows & Shorts,
 * Shows, Shorts, Movies, and any future rotation. It used to hardcode two function
 * buckets and fold every `progress` channel into the first, which listed
 * "Younger Kids / Older Kids" three times each once the kid channels were split.
 * Each card's tier picker lists only THAT pool's own bindings, so a tier can
 * never appear twice. (decision `2026-07-29-dynamic-channels-first-class-and-deletable`)
 */

/**
 * A Picks card's meta line: how many entries, and which LANE they play in.
 *
 * The lane belongs here rather than on the badge — both lanes are Picks, and a second
 * badge would read as a second product kind (decision `2026-08-23-kind-is-picks-or-rules`).
 * It does have to be somewhere: with the badge alone every hand-picked card on this landing
 * said `PICKS` and a count and nothing else, so sixteen cards were identical while a
 * Priority queue and a Random pool play in completely different orders. The Rules cards
 * beside them have always carried a meta clause ("rotation · ratings-filtered"), so this is
 * a shape already on the page rather than a new one.
 */
function picksMeta(
  count: number,
  set:
    | { kind?: unknown; source?: unknown; add_as?: unknown }
    | undefined,
): string {
  const lane = isRandomOrder(set)
    ? "random pool"
    : "priority queue"

  return `${count} entries · ${lane}`
}

/** What one card needs to render, in the order the grid lays them out. */
type Entry =
  | { kind: "rules"; id: string; set: RegistrySet }
  | { kind: "picks"; id: string }

/**
 * Every playable set, in ONE list, in file order.
 *
 * The registry is what carries the order — it is `sets.yaml`'s own, and it is what
 * `PATCH /api/sets-order` reads and writes, so laying the grid out by anything else would
 * make a drag land somewhere other than where it was dropped. `data.order` is consulted
 * only for the sets the registry cannot classify on its own (a picks set's member count
 * lives on the queues payload), and anything the registry does not name is appended rather
 * than dropped — a set that arrives in one payload before the other should render late,
 * not vanish.
 */
function buildEntries(
  reg: SetsResponse | null,
  data: QueuesResponse | null,
): Entry[] {
  const rotations = new Set(
    rotationChannels(reg).map(
      (rotationChannel) => rotationChannel.id,
    ),
  )
  const out: Entry[] = []
  const seen = new Set<string>()

  const classify = (id: string): Entry | null => {
    const set = reg?.sets.find((set) => set.id === id)

    if (set && rotations.has(id))
      return { id, kind: "rules", set }

    const queueSet = data?.sets[id]

    if (queueSet?.source !== "queue") return null

    // Hand-picked membership — formerly split into Ordered Queue (`movies`) and Curated
    // Pool (`anime`). Both are Picks; stored kind still drives playback until placement
    // lands (decision `2026-08-23-kind-is-picks-or-rules`).
    return { id, kind: "picks" }
  }

  for (const id of [
    ...(reg?.sets ?? []).map(
      (registrySet) => registrySet.id,
    ),
    ...(data?.order ?? []),
  ]) {
    if (seen.has(id)) continue

    seen.add(id)

    const entry = classify(id)

    if (entry) out.push(entry)
  }

  return out
}

export function PlayView() {
  const { data, reg } = useStore()
  const people = usePeople()
  const { search } = useLocation()
  const only = parseProviders(search)
  const selected = parsePeople(search)

  const kindOf = (id: string) =>
    reg?.sets.find((set) => set.id === id)?.provider_kind ??
    ""

  /**
   * Every set's trays, resolved to what the filter reads.
   *
   * A GROUP MEMBER IS NOT FLATTENED to its people — "at least one of Grace or Linus" is a
   * set, a number and a spare, and flattening it into two ids turns "either is enough" into
   * "both are required", which is the rule inverted. `resolveMembers` is the same function
   * Tonight uses, over the same two payloads.
   */
  const membersOf = useMemo(() => {
    const out = new Map<
      string,
      ReturnType<typeof resolveMembers>
    >()

    for (const [setId, members] of Object.entries(
      people.byQueue,
    )) {
      out.set(
        setId,
        resolveMembers(
          members,
          people.people,
          people.groups,
        ),
      )
    }

    return out
  }, [people])

  /**
   * The one predicate the grid filters through. People first (who is this for), provider
   * second (which backend) — the two are independent, which is the whole reason each is a
   * chip rather than a level of the route.
   *
   * Two empties, and both branches are load-bearing. **Nobody ticked is no filter at all**,
   * or the page would open showing nothing. **A set nobody is filed on is never filtered
   * out**, or one tick would make every unfiled queue unreachable. Both live in
   * `membersMatchPeople`, which is the browser's mirror of the server's own rule
   * (`queuePeople.ts queueMatchesSelection`) — the two are one implementation on each side
   * of the wire on purpose, so Play and Tonight can never offer different answers.
   */
  const matchOf = (
    id: string,
    forPeople: readonly string[],
    forOnly: readonly string[],
  ): PeopleMatch =>
    forOnly.length && !forOnly.includes(kindOf(id))
      ? { missingRequired: 0, tier: "none" }
      : peopleMatch(membersOf.get(id) ?? [], forPeople)

  const labelForKind = (kind: string) =>
    reg?.sets.find((set) => set.provider_kind === kind)
      ?.vocabulary?.name ||
    PLEX_WORDS.name ||
    kind

  /** Every provider kind in the registry, in registry order — de-duplicated by first
   *  appearance rather than sorted, so the chips read in the order the file does. */
  const providerKinds = useMemo(
    () => [
      ...new Set(
        (reg?.sets ?? [])
          .map((set) => set.provider_kind)
          .filter(Boolean),
      ),
    ],
    [reg],
  )

  const entries = useMemo(
    () => buildEntries(reg, data),
    [data, reg],
  )

  /**
   * The number a nameless queue wears after its activity, over the WHOLE registry.
   *
   * Computed on the registry rather than on `shown`, so a filter never renumbers what is
   * left. "Movies & Shows 2" has to be the same card whether or not Linus is ticked; a
   * number that moves with the filter is a different card every time you look.
   * `queueListNumbers`, the Queues page's own numbering, so the two screens and the native TV
   * catalog cannot give one queue two numbers.
   */
  const numbers = useMemo(
    () => queueListNumbers(reg?.sets ?? [], people.byQueue),
    [reg, people.byQueue],
  )

  /**
   * WHAT A CHIP WILL SHOW YOU, counted over the same predicate the grid uses.
   *
   * Not "how many queues is this person on" — that number stops predicting the tap the
   * moment a second person is ticked, and a count that mis-predicts is worse than none.
   */
  const countFor = (
    forPeople: readonly string[],
    forOnly: readonly string[],
  ) =>
    entries.filter(
      (entry) =>
        matchOf(entry.id, forPeople, forOnly).tier !==
        "none",
    ).length
  /**
   * Is there a queue that NAMES all of these people? The filter bar's dead-end test.
   *
   * `(membersOf.get(e.id)?.length ?? 0) > 0` is the whole difference from `countFor`: a queue
   * nobody is filed on passes every people filter by design, so a plain count answers yes for
   * two people who share nothing.
   */
  const hasQueueFor = (
    forPeople: readonly string[],
    forOnly: readonly string[],
  ) =>
    entries.some(
      (entry) =>
        (membersOf.get(entry.id)?.length ?? 0) > 0 &&
        matchOf(entry.id, forPeople, forOnly).tier !==
          "none",
    )

  /**
   * The grid in its two tiers. `shown` stays the flat list every other reader of this view
   * wants — the empty state, the reorder — and `tiers.exact.length` is where the rule goes.
   */
  const tiers = splitByMatch(entries, (entry) =>
    matchOf(entry.id, selected, only),
  )
  const shown = [...tiers.exact, ...tiers.also]
  /** WHO the also-in cards still want, in roster order — the divider's own sentence. */
  const alsoNames = (() => {
    const wanted = new Set(
      tiers.also.flatMap((entry) =>
        missingRequiredPeople(
          membersOf.get(entry.id) ?? [],
          selected,
        ),
      ),
    )

    return rosterOrder(people.people)
      .filter((person) => wanted.has(person.id))
      .map((person) => person.displayName)
  })()

  // --- reorder ---------------------------------------------------------------- //
  // The grid is ONE list now, so a drop permutes one list — but it is still only a SLICE
  // of `sets.yaml` whenever a group or provider filter is on, and `PATCH /api/sets-order`
  // takes the complete order and appends anything it was not told about. So the drop sends
  // the whole file order back with only the visible slots permuted, and every card a
  // filter is currently hiding stays exactly where it was.
  const gridRef = useRef<HTMLUListElement>(null)

  const commitOrder = useCallback((gridOrder: string[]) => {
    // Read the LIVE store rather than this render's props: a drop lands after an arbitrary
    // amount of dragging, and the alternative is holding whatever `reg` was when the
    // listeners were bound.
    const state = getState()
    const full = (state.reg?.sets ?? []).map(
      (registrySet) => registrySet.id,
    )

    if (!full.length) return

    const next = spliceOrder(full, gridOrder)

    if (next.join("\u0000") === full.join("\u0000")) return // dropped where it started

    // OPTIMISTIC, and not merely for polish: the drop restores the dragged node to where
    // React last rendered it (so React reconciles against a DOM it believes), which means
    // the card visibly snaps BACK until new data arrives. Waiting for `load()` would hold
    // that snap-back for as long as `/api/queues` takes — 7-9 s warm against Plex.
    const rank = new Map(
      next.map((id, index) => [id, index]),
    )
    const byRank = (left: string, right: string) =>
      (rank.get(left) ?? 0) - (rank.get(right) ?? 0)

    if (state.reg) {
      state.reg.sets = [...state.reg.sets].sort(
        (left, right) => byRank(left.id, right.id),
      )
    }

    if (state.data)
      state.data.order = [...state.data.order].sort(byRank)

    bumpRevision()
    setStatus("Saving order…")
    void api("PATCH", "/api/sets-order", { ids: next })
      .then(() => setStatus("Order saved", "ok"))
      .catch(async (error: Error) => {
        setStatus(`Reorder failed: ${error.message}`, "err")
        // The optimistic order is now a lie; re-read so the page shows what is on disk.
        await load()
      })
  }, [])

  useRowReorder(gridRef, commitOrder, true)

  return (
    <div className="view" id="play">
      <LandingFilterBar
        // `/admin` and nothing else. This page had three possible base paths while the
        // groups were routes; it has one now, and the filters ride in the query.
        basePath="/admin"
        countFor={countFor}
        hasQueueFor={hasQueueFor}
        labelForKind={labelForKind}
        only={only}
        people={rosterOrder(people.people)}
        providerKinds={providerKinds}
        search={search}
        selected={selected}
      />
      {/*
        Where you GO from here. These were three "Configure ›" links, one per shelf heading,
        and the headings are gone — so they gather into one quiet row. It stays rendered even
        when the grid is empty: this row is the only way to create the first pool or queue,
        and hiding it would make a fresh install a dead end.
      */}
      <p className="playlinks">
        {/*
          CREATE, on the page that lists what you own. The landing had no version of this
          until 2026-08-21 — `#tools` carries the app's other "＋ New queue", and
          `body.queue-view #tools` hides that whole toolbar here on purpose, so the only
          route to a new queue was Configure ordered queues › and then the button. Reported
          from a group page: "Even here, I can't add a new queue."

          A local affordance rather than un-hiding the toolbar: the hide is what keeps the
          queue filter, Collapse all and the add-to-any-queue search out of this header,
          which is the same reason Pending sets the class. `ChannelsView` already solves it
          this way with its own ＋ Rules queue / ＋ Picks queue pair.

          Its own id, NOT a second `#newqueue`: `narrow-scroll-test` and `ui-test` both
          `click('#newqueue')` on /queues, PlayView renders BEFORE QueuesView, and a
          duplicate id would hand them this hidden button instead.

          It seeds `movies` — Priority-by-default Picks, still the stored value until
          `add_as` lands — because the modal's Type picker still asks Priority vs Random.
          A Rules queue is a different editor (`openDynModal`) and stays behind
          Configure rules ›.
        */}
        {/* A Charcuterie `Button`. `.playlinks button.accent` is the second of the only two
            rules `.accent` ever had, and it says the same thing `#tools`' does: an accent
            border and accent text that fill on hover — `appearance="outline"
            intent="accent"`.

            `size="sm"`, because `.playlinks button.ghost` sized this control DOWN
            (`padding: 6px 12px`, `font-size: 0.9rem`) so it would sit in a row of text
            links without dominating it. That is a real requirement and it survives as a
            PROP — the size axis the component already has — rather than as a per-row CSS
            override that outranks the component. */}
        <Button
          appearance="outline"
          id="playnewqueue"
          intent="accent"
          onClick={() => openSetModal(null, "priority")}
          size="sm"
        >
          ＋ New picks queue
        </Button>
        {/* What to Watch/Play, first among the links because it is where choosing starts —
            the rest of this row configures the app. */}
        <Link id="gotonight" to={WATCH_PLAY_PATH}>
          What to Watch/Play &rsaquo;
        </Link>
        {/* THE COLLECTION, beside What to Watch/Play rather than under Configure: marking a
            game played is an activity, not a setting you change. */}
        <Link
          id="gocollection"
          to="/collection/board-games"
        >
          Board game collection &rsaquo;
        </Link>
        <Link id="gopending" to="/pending">
          What is new and unqueued ›
        </Link>
        <Link id="gochannels" to="/channels">
          Configure rules ›
        </Link>
        <Link id="goqueues" to="/picks">
          Configure picks ›
        </Link>
      </p>

      {/*
        Nothing to show is a real state now that there are no headings to stand in for the
        cards. Unfiltered it means a fresh install (the links above are the way out of it);
        under a filter it means nobody has a queue that matches every name you ticked, which
        is worth saying rather than leaving as a blank page that reads like a failed load.
      */}
      {reg && !shown.length ? (
        <EmptyState
          description={
            selected.length || only
              ? "No queue matches everybody you ticked on this provider. Untick a name, or try Anyone."
              : "Configure a picks or rules queue to put something here."
          }
          heading="Nothing to play"
          headingLevel={2}
        />
      ) : null}

      <ul className="playgrid" id="playgrid" ref={gridRef}>
        {shown.map((entry, index) => {
          // The rule sits inside the grid, spanning every column — `useRowReorder` permutes
          // this list's children, so a wrapper per tier would stop a drag crossing the line.
          const divider =
            tiers.also.length > 0 &&
            index === tiers.exact.length ? (
              <li className="playgrid-divide" key="alsoin">
                <AlsoInDivider names={alsoNames} />
              </li>
            ) : null

          return (
            <Fragment key={entry.id}>
              {divider}
              {entry.kind === "rules" ? (
                <ChannelCard
                  channel={entry.set}
                  duplicateNumber={
                    numbers.get(entry.id) ?? null
                  }
                />
              ) : (
                <PlayCard
                  kind="picks"
                  // The REGISTRY's label, not the queues payload's: only the registry carries
                  // `has_explicit_label`, which is what separates a name somebody typed from
                  // the id the server falls back to.
                  label={queueTitle(
                    reg?.sets.find(
                      (set) => set.id === entry.id,
                    ) ?? {
                      // No registry entry yet — one payload arrived before the other. All
                      // that is known is the queues payload's label, so it is treated as
                      // EXPLICIT: showing it beats showing an activity guessed from nothing.
                      activity: "watching",
                      has_explicit_label: true,
                      label: data!.sets[entry.id]!.label,
                    },
                    numbers.get(entry.id) ?? null,
                  )}
                  // The registry entry, so a Plex Picks card and a Plex Rules card two
                  // cards apart render in the same amber rather than one of them in the
                  // neutral accent.
                  set={reg?.sets.find(
                    (set) => set.id === entry.id,
                  )}
                  // THE LIST INHERITS THE TRAYS, the same way the Picks page's shelves do.
                  // `usePeople` is a store slice of its own and is loaded once at start-up,
                  // so this costs the landing no extra request and no extra render on a
                  // queue-editor save.
                  people={
                    <PeopleRow
                      groups={people.groups}
                      members={
                        people.byQueue[entry.id] ?? []
                      }
                      people={people.people}
                    />
                  }
                  meta={picksMeta(
                    data!.sets[entry.id]!.items.length,
                    reg?.sets.find(
                      (set) => set.id === entry.id,
                    ) ?? data!.sets[entry.id],
                  )}
                  to={`/q/${entry.id}`}
                  onPlay={(anchor) =>
                    openPlayMenu({
                      anchor,
                      setId: entry.id,
                    })
                  }
                />
              )}
            </Fragment>
          )
        })}
      </ul>
    </div>
  )
}
