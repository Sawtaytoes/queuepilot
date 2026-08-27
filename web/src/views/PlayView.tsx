import { Button, EmptyState } from "@charcuterie/ui"
import {
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react"
import { Link, useLocation } from "react-router"
import { LandingFilterBar } from "../components/LandingFilterBar"
import {
  isPullSet,
  OpenQueueButton,
} from "../components/OpenQueueButton"
import { PeopleRow } from "../components/PeopleRow"
import { SelectListbox } from "../components/SelectListbox"
import {
  spliceOrder,
  useRowReorder,
} from "../hooks/useRowReorder"
import { api } from "../lib/api"
import { channelAccountLabel } from "../lib/channels"
import { isRandomOrder } from "../lib/kind"
import { queueNumbers, queueTitle } from "../lib/people"
import {
  membersMatchPeople,
  resolveMembers,
  rosterOrder,
} from "../lib/tonight"
import type {
  QueuesResponse,
  RegistrySet,
  SetsResponse,
} from "../lib/types"
import { PLEX_WORDS } from "../lib/vocab"
import {
  parseOnly,
  parsePeople,
} from "../state/landingFilter"
import {
  openPlayMenu,
  openSetModal,
} from "../state/overlays"
import { usePeople } from "../state/people"
import { WATCH_PLAY_PATH } from "../state/route"
import {
  bumpRevision,
  getState,
  load,
  rotationChannels,
  setStatus,
  useStore,
} from "../state/store"

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
 * The two kinds, as the card says them out loud.
 *
 * Ordered Queue and Curated Pool were the same object with different default playback —
 * both are hand-picked titles — so they share one badge. Rules queues are the other kind
 * (membership from library/ratings rules). The badge is the ONLY place the page says them;
 * there are no shelf headings left to carry them.
 * (decision `2026-08-23-kind-is-picks-or-rules`; supersedes the three-name split in
 * `2026-08-16-filtered-pools-curated-pools-ordered-queues`)
 */
type SetKind = "picks" | "rules"

const KIND_WORD: Record<SetKind, string> = {
  picks: "Picks",
  rules: "Rules",
}

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

/** A tier-select value → `{set, profile?}` (JSON for a binding option, a bare id
 * otherwise). */
function parseTierValue(v: string): {
  set: string
  profile?: string
} {
  if (v?.startsWith("{")) {
    try {
      return JSON.parse(v)
    } catch {
      /* fall through */
    }
  }

  return { set: v }
}

function PlayCard({
  kind,
  label,
  meta,
  onPlay,
  people,
  set,
  tier,
  to,
}: {
  /**
   * Where this card GOES — a real link target, not an `onClick` that calls `navigate()`.
   * Middle-click, ⌘/Ctrl-click, "Open in new tab", "Copy link address" and the status-bar
   * preview all come from the ELEMENT being an anchor; none of them can be added to a
   * `<button>` by styling it like a link.
   * (decision `2026-08-15-navigation-is-an-anchor-not-a-button`)
   *
   * It is a react-router `<Link>` rather than a bare `<a>` as of 2026-08-16. Under the
   * hash router a plain `<a href="#/q/1">` needed no handler — setting the hash WAS the
   * navigation. A path `<a href="/q/1">` is not the same thing: the browser would leave
   * the page and refetch the whole app. `<Link>` still RENDERS an `<a href>`, so every
   * affordance above survives; it just intercepts the plain left-click.
   */
  to: string
  kind: SetKind
  label: string
  meta: string
  onPlay: (anchor: DOMRect) => void
  /**
   * WHO THIS QUEUE IS FOR — a `PeopleRow`, or null for a card that has no trays.
   *
   * The same row the Picks page draws in a shelf heading, and it is here for the reason it
   * is there: it is the only thing on the card that says a queue apart from its neighbour
   * once you stop reading the name. A shelf can lean on its posters for that; a landing card
   * has none, so this row is doing MORE work here, not less
   * (decision `2026-08-25-a-queue-is-people-plus-an-activity`).
   *
   * A RULES card carries one too, as of 2026-08-26. It used to be null here on the argument
   * that a filtered pool is bound to one provider ACCOUNT and its meta line already names it.
   * That conflated two facts: the account is which Plex profile the pool signs in as, and the
   * trays are who the pool is FOR. The owner reported the gap from the other end — there was
   * no way to put anybody on Shorts or Movies at all
   * (decision `2026-08-26-a-rules-queue-carries-people-too`).
   */
  people?: ReactNode
  /** The registry entry, for `delivery`, the accent + the start button's words. Absent =
   * push (pre-provider callers). */
  set?: Pick<
    RegistrySet,
    "id" | "delivery" | "provider_kind" | "vocabulary"
  >
  tier?: ReactNode
}) {
  return (
    // Each card wears its own set's colour, so the landing says at a glance which service
    // each button will talk to — the Kavita card's Open button is Kavita-green beside the
    // Plex cards' amber. (decision `2026-08-15-a-queue-wears-its-providers-colour`)
    <li
      className="playcard"
      // The id the reorder hook reads off the DOM after a drag — the cards it moves are
      // nodes, not React state, so the new order has to be legible from the elements.
      data-set={set?.id}
      data-kind={kind}
      data-provider={set?.provider_kind || undefined}
    >
      <div className="cardhead">
        {/* TOUCH ONLY, and CSS decides that — the glyph is `display: none` on a fine pointer,
            where the whole card is grabbable and this would be an empty gutter indenting
            every name for a control shown on hover. It survives on a coarse pointer because
            whole-card touch dragging would cost the page its scroll surface, and because
            there is no hover there to reveal an affordance with. Hidden from assistive tech:
            it is a pointer affordance, and reordering is not the only way to get anywhere.
            (decision `2026-08-19-the-whole-card-is-the-drag-handle-on-a-fine-pointer`) */}
        <span
          aria-hidden="true"
          className="rowdrag"
          title="Drag to reorder"
        >
          ≡
        </span>
        <Link className="rowname" to={to}>
          {label}
        </Link>
        {/* Not a `<Badge>`: charcuterie's badge is a status pill with an intent colour,
            and this is a permanent classification rather than a state that changes. It
            also has to sit flush against a heading that may wrap to two lines, which the
            pill's own line-height fights. */}
        <span className="cardkind">{KIND_WORD[kind]}</span>
      </div>
      {/* ITS OWN ROW, above the meta rather than inside it. The faces are 26px tall and the
          meta is 0.83rem text; sharing a line would set the row's height from the faces and
          leave the count floating half-way up it. Above the meta and not below, because the
          two lines answer "whose is this" and then "how big is it" — the order somebody
          scanning a wall of cards asks them in. */}
      {people}
      {/* THE META OWNS A LINE. It used to be the first child of `.cardfoot`, sharing the
          row with the start button, and `.cardfoot` wraps — so whether the button ended up
          beside the meta or on a line of its own was decided by how many characters that
          card's meta happened to have. Three cards in one row of the live grid had three
          different layouts: "17 entries · random pool" fit, so its button sat right;
          "Younger Kids · rotation · ratings-filtered" did not, so its button dropped to a
          second line and (with nothing pushing it over) sat LEFT; "Younger Kids · weighted
          rewatch" fit again. Same component, same CSS, three shapes.

          Out here the line is unconditional: name, then meta, then the action on the floor,
          on every card at every width. */}
      <p className="rowmeta">{meta}</p>
      <div className="cardfoot">
        {tier}
        {isPullSet(set) ? (
          // Nothing to cast to — the launcher URL is the whole affordance.
          <OpenQueueButton set={set!} />
        ) : (
          <>
            {/* A Charcuterie `Button`, `intent="accent"` — what `.playbtn`'s solid accent skin
              painted by hand. The class STAYS as a DOM handle: `PlayMenu` asks
              `t.closest(".playbtn")` so pressing this does not close the menu it opens. */}
            <Button
              className="playbtn"
              intent="accent"
              onClick={(e) =>
                onPlay(
                  e.currentTarget.getBoundingClientRect(),
                )
              }
            >
              ▶ Play on ▾
            </Button>
          </>
        )}
      </div>
    </li>
  )
}

/**
 * One filtered pool's card.
 *
 * **A pool is locked to ONE account, so there is normally no picker here.** The tier dropdown
 * existed because these pools predate being able to switch the Shield's Plex profile from the
 * app: one pool had to carry every tier's binding and you chose at play time. Every pool is
 * single-account now, and a control with one option is not a choice — it is a label wearing a
 * chevron. So the account moves into the card's meta line as TEXT, and the card gets the same
 * shape as a Curated Pool / Ordered Queue card: name, kind, meta, one start button.
 * (decision `2026-08-17-a-filtered-pool-is-locked-to-one-account`)
 *
 * The picker is not deleted, only conditional: a pool that still carries two or more bindings
 * (a hand-edit, an older `sets.yaml`) keeps choosing at play time rather than silently playing
 * as whichever binding happens to be first.
 */
function ChannelCard({
  channel,
  duplicateNumber,
}: {
  channel: RegistrySet
  /** The number after the activity when two nameless pools would read identically, or null.
   *  Ignored outright when the pool has a name of its own. */
  duplicateNumber: number | null
}) {
  const people = usePeople()
  const isRewatch = channel.behavior === "rewatch"
  const options = channel.has_explicit_profiles
    ? (channel.profiles || []).map((b) => ({
        label: b.plex_user || channel.label,
        value: JSON.stringify({
          profile: b.plex_user,
          set: channel.id,
        }),
      }))
    : [{ label: channel.label, value: channel.id }]

  // Seed to the channel's saved default profile when it names a real binding, so Play
  // reaches for the right tier without the user re-picking; else the first binding.
  // (decision `2026-08-07-default-profile-per-channel`)
  const defaultValue =
    channel.has_explicit_profiles && channel.default_profile
      ? (channel.profiles || [])
          .filter(
            (b) => b.plex_user === channel.default_profile,
          )
          .map((b) =>
            JSON.stringify({
              profile: b.plex_user,
              set: channel.id,
            }),
          )[0]
      : undefined

  const [tierValue, setTierValue] = useState(
    defaultValue ?? options[0]?.value ?? channel.id,
  )

  const hasChoice = options.length > 1
  // `tierValue` is local state seeded ONCE, and the options are not: another tab (or a
  // hand-edit picked up over SSE) can delete the binding this card is still holding. Falling
  // back to the current default rather than trusting the stale value is what stops the card
  // from quietly playing as an account the pool no longer has.
  const value = options.some((o) => o.value === tierValue)
    ? tierValue
    : (defaultValue ?? options[0]?.value ?? channel.id)
  // The account this pool is locked to, for the meta line. Null when the tier picker is on
  // screen — the card is asking rather than telling.
  //
  // This used to gate on `has_explicit_profiles`, on the belief that a legacy flat set's
  // SYNTHESIZED binding reports the channel's own label and would read as "Shows · Shows".
  // The server does not do that — the synthesized binding carries the real `plex_user` — so
  // the gate was dropping the account from every legacy pool. It only ever looked right
  // against the live `sets.yaml`, where those pools are NAMED after the accounts they play
  // as. `channelAccountLabel` compares the two instead, which is the check that claim was
  // reaching for. (decision `2026-08-26-a-picks-queue-lives-on-the-picks-screen…`)
  const boundAccount = hasChoice
    ? null
    : channelAccountLabel(channel)
  // It is ALWAYS said now. It used to be dropped while you stood inside that account's own
  // group, where it was the heading repeated — but there is no group page to stand in any
  // more, so `accountInGroup` had one caller and one answer and is gone with the chips
  // (decision `2026-08-26-the-landing-filters-by-people-and-the-group-chips-go`).
  const onlyAccount = boundAccount
  const behaviour = isRewatch
    ? "weighted rewatch"
    : "rotation · ratings-filtered"

  return (
    <PlayCard
      kind="rules"
      // Its own name when it has one — "Shorts", "Movies" — and its ACTIVITY when it has
      // not. A rules pool is as much a `watching` thing as a curated queue is, so the same
      // rule applies to both cards on this grid
      // (decision `2026-08-26-a-queue-name-is-optional-and-the-activity-fills-in`).
      label={queueTitle(channel, duplicateNumber)}
      set={channel}
      // Whose pool this is comes FIRST — "Shows" and "Shows & Shorts" are the same words
      // until you know one is Younger Kids and the other Older Kids, and that used to be
      // readable only off the dropdown this card no longer has.
      meta={
        onlyAccount
          ? `${onlyAccount} · ${behaviour}`
          : behaviour
      }
      // A rules pool has trays now, so it wears the same row of faces a picks card does.
      // The account in the meta line beside it is a DIFFERENT fact — which Plex profile
      // this pool signs in as — and the two disagree often enough to be worth showing
      // together (decision `2026-08-26-a-rules-queue-carries-people-too`).
      people={
        <PeopleRow
          groups={people.groups}
          members={people.byQueue[channel.id] ?? []}
          people={people.people}
        />
      }
      to={`/channels/${encodeURIComponent(channel.id)}`}
      onPlay={(anchor) => {
        // With one binding the card does not ask — it plays as the account the pool is
        // configured for, which is what `tierValue` already holds.
        const t = parseTierValue(value)

        openPlayMenu({
          anchor,
          behavior: isRewatch ? "rewatch" : undefined,
          profile: t.profile,
          setId: t.set,
        })
      }}
      tier={
        hasChoice ? (
          <SelectListbox
            className="rowtier"
            label={`Profile for ${channel.label}`}
            onChange={setTierValue}
            options={options}
            size="sm"
            value={value}
          />
        ) : null
      }
    />
  )
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
    rotationChannels(reg).map((s) => s.id),
  )
  const out: Entry[] = []
  const seen = new Set<string>()

  const classify = (id: string): Entry | null => {
    const set = reg?.sets.find((s) => s.id === id)

    if (set && rotations.has(id))
      return { id, kind: "rules", set }

    const q = data?.sets[id]

    if (q?.source !== "queue") return null

    // Hand-picked membership — formerly split into Ordered Queue (`movies`) and Curated
    // Pool (`anime`). Both are Picks; stored kind still drives playback until placement
    // lands (decision `2026-08-23-kind-is-picks-or-rules`).
    return { id, kind: "picks" }
  }

  for (const id of [
    ...(reg?.sets ?? []).map((s) => s.id),
    ...(data?.order ?? []),
  ]) {
    if (seen.has(id)) continue

    seen.add(id)

    const entry = classify(id)

    if (entry) out.push(entry)
  }

  return out
}

export function PlayView({
  isHidden,
}: {
  isHidden: boolean
}) {
  const { data, reg } = useStore()
  const people = usePeople()
  const { search } = useLocation()
  const only = parseOnly(search)
  const selected = parsePeople(search)

  const kindOf = (id: string) =>
    reg?.sets.find((s) => s.id === id)?.provider_kind ?? ""

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
  const matches = (
    id: string,
    forPeople: readonly string[],
    forOnly: string | null,
  ) =>
    (!forOnly || kindOf(id) === forOnly) &&
    membersMatchPeople(membersOf.get(id) ?? [], forPeople)

  const isShown = (id: string) =>
    matches(id, selected, only)

  const labelForKind = (kind: string) =>
    reg?.sets.find((s) => s.provider_kind === kind)
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
   */
  const numbers = useMemo(
    () => queueNumbers(reg?.sets ?? [], people.byQueue),
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
    forOnly: string | null,
  ) =>
    entries.filter((e) => matches(e.id, forPeople, forOnly))
      .length

  const shown = entries.filter((e) => isShown(e.id))

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
    const full = (state.reg?.sets ?? []).map((x) => x.id)

    if (!full.length) return

    const next = spliceOrder(full, gridOrder)

    if (next.join("\u0000") === full.join("\u0000")) return // dropped where it started

    // OPTIMISTIC, and not merely for polish: the drop restores the dragged node to where
    // React last rendered it (so React reconciles against a DOM it believes), which means
    // the card visibly snaps BACK until new data arrives. Waiting for `load()` would hold
    // that snap-back for as long as `/api/queues` takes — 7-9 s warm against Plex.
    const rank = new Map(next.map((id, i) => [id, i]))
    const byRank = (a: string, b: string) =>
      (rank.get(a) ?? 0) - (rank.get(b) ?? 0)

    if (state.reg) {
      state.reg.sets = [...state.reg.sets].sort((a, b) =>
        byRank(a.id, b.id),
      )
    }

    if (state.data)
      state.data.order = [...state.data.order].sort(byRank)

    bumpRevision()
    setStatus("Saving order…")
    void api("PATCH", "/api/sets-order", { ids: next })
      .then(() => setStatus("Order saved", "ok"))
      .catch(async (e: Error) => {
        setStatus(`Reorder failed: ${e.message}`, "err")
        // The optimistic order is now a lie; re-read so the page shows what is on disk.
        await load()
      })
  }, [])

  useRowReorder(gridRef, commitOrder, !isHidden)

  return (
    <main className="view" hidden={isHidden} id="play">
      {isHidden ? null : (
        <LandingFilterBar
          // `/admin` and nothing else. This page had three possible base paths while the
          // groups were routes; it has one now, and the filters ride in the query.
          basePath="/admin"
          countFor={countFor}
          labelForKind={labelForKind}
          only={only}
          people={rosterOrder(people.people)}
          providerKinds={providerKinds}
          search={search}
          selected={selected}
        />
      )}
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
        <Link id="gocollection" to="/board-game-collection">
          Board game collection &rsaquo;
        </Link>
        <Link id="gopending" to="/pending">
          What is new and unqueued ›
        </Link>
        <Link id="gochannels" to="/channels">
          Configure rules ›
        </Link>
        <Link id="goqueues" to="/queues">
          Configure picks ›
        </Link>
      </p>

      {/*
        Nothing to show is a real state now that there are no headings to stand in for the
        cards. Unfiltered it means a fresh install (the links above are the way out of it);
        under a filter it means nobody has a queue that matches every name you ticked, which
        is worth saying rather than leaving as a blank page that reads like a failed load.
      */}
      {!isHidden && reg && !shown.length ? (
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
        {isHidden
          ? null
          : shown.map((e) =>
              e.kind === "rules" ? (
                <ChannelCard
                  channel={e.set}
                  duplicateNumber={
                    numbers.get(e.id) ?? null
                  }
                  key={e.id}
                />
              ) : (
                <PlayCard
                  key={e.id}
                  kind="picks"
                  // The REGISTRY's label, not the queues payload's: only the registry carries
                  // `has_explicit_label`, which is what separates a name somebody typed from
                  // the id the server falls back to.
                  label={queueTitle(
                    reg?.sets.find(
                      (x) => x.id === e.id,
                    ) ?? {
                      // No registry entry yet — one payload arrived before the other. All
                      // that is known is the queues payload's label, so it is treated as
                      // EXPLICIT: showing it beats showing an activity guessed from nothing.
                      activity: "watching",
                      has_explicit_label: true,
                      label: data!.sets[e.id]!.label,
                    },
                    numbers.get(e.id) ?? null,
                  )}
                  // The registry entry, so a Plex Picks card and a Plex Rules card two
                  // cards apart render in the same amber rather than one of them in the
                  // neutral accent.
                  set={reg?.sets.find((x) => x.id === e.id)}
                  // THE LIST INHERITS THE TRAYS, the same way the Picks page's shelves do.
                  // `usePeople` is a store slice of its own and is loaded once at start-up,
                  // so this costs the landing no extra request and no extra render on a
                  // queue-editor save.
                  people={
                    <PeopleRow
                      groups={people.groups}
                      members={people.byQueue[e.id] ?? []}
                      people={people.people}
                    />
                  }
                  meta={picksMeta(
                    data!.sets[e.id]!.items.length,
                    reg?.sets.find((x) => x.id === e.id) ??
                      data!.sets[e.id],
                  )}
                  to={`/q/${e.id}`}
                  onPlay={(anchor) =>
                    openPlayMenu({ anchor, setId: e.id })
                  }
                />
              ),
            )}
      </ul>
    </main>
  )
}
