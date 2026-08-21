import { EmptyState } from "@charcuterie/ui"
import {
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react"
import { Link, useLocation } from "react-router"
import { GroupBar } from "../components/GroupBar"
import {
  isPullSet,
  OpenQueueButton,
} from "../components/OpenQueueButton"
import { SelectListbox } from "../components/SelectListbox"
import {
  spliceOrder,
  useRowReorder,
} from "../hooks/useRowReorder"
import { api } from "../lib/api"
import { labelInGroup } from "../lib/setLabel"
import type {
  Group,
  QueuesResponse,
  RegistrySet,
  SetsResponse,
} from "../lib/types"
import { PLEX_WORDS } from "../lib/vocab"
import {
  ALL_ID,
  findGroup,
  groupPath,
  parseOnly,
} from "../state/group"
import {
  openPlayMenu,
  openSetModal,
} from "../state/overlays"
import {
  bumpRevision,
  getState,
  load,
  rotationChannels,
  setStatus,
  useStore,
} from "../state/store"

/**
 * PLAY — the landing. Every pool and queue as a posterless card: pick one and play it.
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
 * The three kinds, as the card says them out loud.
 *
 * These are the words the taxonomy decision settled, and the badge is now the ONLY place
 * the page says them — there are no shelf headings left to carry them.
 * (decision `2026-08-16-filtered-pools-curated-pools-ordered-queues`)
 */
type SetKind = "curated" | "filtered" | "ordered"

const KIND_WORD: Record<SetKind, string> = {
  curated: "Curated Pool",
  filtered: "Filtered Pool",
  ordered: "Ordered Queue",
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
      <div className="cardfoot">
        <span className="rowmeta">{meta}</span>
        {tier}
        {isPullSet(set) ? (
          // Nothing to cast to — the launcher URL is the whole affordance.
          <OpenQueueButton set={set!} />
        ) : (
          <button
            className="playbtn"
            onClick={(e) =>
              onPlay(
                e.currentTarget.getBoundingClientRect(),
              )
            }
            type="button"
          >
            ▶ Play on ▾
          </button>
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
  groupLabel,
}: {
  channel: RegistrySet
  /** The group being viewed, so the card can drop that name from its own. */
  groupLabel: string | null
}) {
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
  // The account this pool is locked to, for the meta line. `has_explicit_profiles` is what
  // separates a real binding from the synthesized one a legacy flat set reports, whose
  // `plex_user` is the channel's own label and would read as "Shows · Shows".
  const onlyAccount = hasChoice
    ? null
    : channel.has_explicit_profiles
      ? (channel.profiles || [])[0]?.plex_user || null
      : null
  const behaviour = isRewatch
    ? "weighted rewatch"
    : "rotation · ratings-filtered"

  return (
    <PlayCard
      kind="filtered"
      label={labelInGroup(channel.label, groupLabel)}
      set={channel}
      // Whose pool this is comes FIRST — "Shows" and "Shows & Shorts" are the same words
      // until you know one is Younger Kids and the other Older Kids, and that used to be
      // readable only off the dropdown this card no longer has.
      meta={
        onlyAccount
          ? `${onlyAccount} · ${behaviour}`
          : behaviour
      }
      to={`/channels/${encodeURIComponent(channel.id)}`}
      onPlay={(anchor) => {
        // With one binding the card does not ask — it plays as the account the pool is
        // configured for, which is what `tierValue` already holds.
        const t = parseTierValue(value)

        openPlayMenu({
          anchor,
          kind: isRewatch ? "movie" : undefined,
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
  | { kind: "filtered"; id: string; set: RegistrySet }
  | { kind: "curated" | "ordered"; id: string }

/**
 * Every playable set, in ONE list, in file order.
 *
 * The registry is what carries the order — it is `sets.yaml`'s own, and it is what
 * `PATCH /api/sets-order` reads and writes, so laying the grid out by anything else would
 * make a drag land somewhere other than where it was dropped. `data.order` is consulted
 * only for the sets the registry cannot classify on its own (a curated set's `kind` and its
 * member count live on the queues payload), and anything the registry does not name is
 * appended rather than dropped — a set that arrives in one payload before the other should
 * render late, not vanish.
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
      return { id, kind: "filtered", set }

    const q = data?.sets[id]

    if (q?.source !== "queue") return null

    // kind 'movies' = an ordered QUEUE, 'anime' = a curated pool played as a rotation.
    // The same split `queueIds` / `channelSetIds` made when these were separate shelves.
    return {
      id,
      kind: q.kind === "anime" ? "curated" : "ordered",
    }
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
  groupId,
}: {
  isHidden: boolean
  /** The `/g/<id>` segment, or null for the everything view. */
  groupId: string | null
}) {
  const { data, groups, reg } = useStore()
  const { search } = useLocation()
  const only = parseOnly(search)

  const active = findGroup(groups, groupId)
  // A stale bookmark to a deleted group shows EVERYTHING rather than an empty page. The
  // alternative — an error state — punishes the person for our own rename.
  const inGroup = active ? new Set(active.setIds) : null

  const kindOf = (id: string) =>
    reg?.sets.find((s) => s.id === id)?.provider_kind ?? ""

  /**
   * The one predicate the grid filters through. Group first (whose is it), provider
   * second (which backend) — the two are independent, which is the whole reason the
   * provider is a chip and not a level of the route.
   */
  const isShown = (id: string) =>
    (!inGroup || inGroup.has(id)) &&
    (!only || kindOf(id) === only)

  // Counts on the chips are AFTER the provider filter, so the numbers add up to what you
  // are about to see rather than to what the group holds in the abstract.
  const countFor = useMemo(
    () => (group: Group) =>
      group.setIds.filter(
        (id) => !only || kindOf(id) === only,
      ).length,
    // `reg` is what `kindOf` reads; `only` is the filter itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [only, reg],
  )

  const labelForKind = (kind: string) =>
    reg?.sets.find((s) => s.provider_kind === kind)
      ?.vocabulary?.name ||
    PLEX_WORDS.name ||
    kind

  // What the provider chips hang off. `/g/all` has to stay `/g/all` here: sending them to
  // bare `/` would hand the remembered-group redirect a URL that "did not say" and bounce a
  // provider tap on the everything view into somebody's group — the All-chip bug, one
  // control over. Bare `/` is still itself, for the visit that has no memory to answer.
  const basePath = active
    ? groupPath(active)
    : groupId === ALL_ID
      ? `/g/${ALL_ID}`
      : "/"
  // Inside a group, a card drops that group's own name — the heading already says it, and
  // repeating it buries the one word that tells two cards apart. See `lib/setLabel.ts`.
  const groupLabel = active?.label ?? null

  const entries = useMemo(
    () => buildEntries(reg, data),
    [data, reg],
  ).filter((e) => isShown(e.id))

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

    if (next.join(" ") === full.join(" ")) return // dropped where it started

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
      {isHidden || !groups ? null : (
        <GroupBar
          activeId={active?.id ?? null}
          basePath={basePath}
          countFor={countFor}
          groups={groups.groups}
          labelForKind={labelForKind}
          only={only}
          // The kinds of the group you are LOOKING AT, so the card offers Plex/Kavita only
          // where both are actually reachable.
          providerKinds={
            (
              active ??
              groups.groups.find((g) => g.isAll) ?? {
                providerKinds: [],
              }
            ).providerKinds
          }
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
          this way with its own ＋ Filtered pool / ＋ Curated pool pair.

          Its own id, NOT a second `#newqueue`: `narrow-scroll-test` and `ui-test` both
          `click('#newqueue')` on /queues, PlayView renders BEFORE QueuesView, and a
          duplicate id would hand them this hidden button instead.

          It seeds `movies` — an ORDERED QUEUE — because that is the thing that was asked
          for, and because the modal's second field is a Type picker holding both kinds, so
          the choice is asked rather than decided here. A FILTERED pool is a different
          editor (`openDynModal`) and stays behind Configure pools ›.
        */}
        <button
          className="ghost accent"
          id="playnewqueue"
          onClick={() => openSetModal(null, "movies")}
          type="button"
        >
          ＋ New queue
        </button>
        <Link id="gopending" to="/pending">
          What is new and unqueued ›
        </Link>
        <Link id="gochannels" to="/channels">
          Configure pools ›
        </Link>
        <Link id="goqueues" to="/queues">
          Configure ordered queues ›
        </Link>
      </p>

      {/*
        Nothing to show is a real state now that there are no headings to stand in for the
        cards. Unfiltered it means a fresh install (the links above are the way out of it);
        under a filter it means this group holds nothing on this provider, which is worth
        saying rather than leaving as a blank page that reads like a failed load.
      */}
      {!isHidden && reg && !entries.length ? (
        <EmptyState
          description={
            active || only
              ? "Nothing in this group on this provider. Try All, or another group."
              : "Configure a pool or an ordered queue to put something here."
          }
          heading="Nothing to play"
          headingLevel={2}
        />
      ) : null}

      <ul className="playgrid" id="playgrid" ref={gridRef}>
        {isHidden
          ? null
          : entries.map((e) =>
              e.kind === "filtered" ? (
                <ChannelCard
                  channel={e.set}
                  groupLabel={groupLabel}
                  key={e.id}
                />
              ) : (
                <PlayCard
                  key={e.id}
                  kind={e.kind}
                  label={labelInGroup(
                    data!.sets[e.id]!.label,
                    groupLabel,
                  )}
                  // The registry entry, so a Plex QUEUE and a Plex POOL two cards apart
                  // render in the same amber rather than one of them in the neutral accent.
                  set={reg?.sets.find((x) => x.id === e.id)}
                  meta={
                    e.kind === "curated"
                      ? `${data!.sets[e.id]!.items.length} shows · rotation`
                      : `${data!.sets[e.id]!.items.length} titles · top plays next`
                  }
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
