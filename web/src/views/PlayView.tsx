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
import type { Group, RegistrySet } from "../lib/types"
import { PLEX_WORDS } from "../lib/vocab"
import {
  findGroup,
  groupPath,
  parseOnly,
} from "../state/group"
import { openPlayMenu } from "../state/overlays"
import {
  bumpRevision,
  channelSetIds,
  getState,
  load,
  queueIds,
  rotationChannels,
  setStatus,
  useStore,
} from "../state/store"

/**
 * PLAY — the landing. Every channel and queue as a plain, posterless row: pick one
 * and play it. The configurators (posters, drag, filters) live behind the three
 * "Configure ›" links.
 * (decision `2026-07-21-queues-vs-channels-taxonomy-play-first-ia`)
 *
 * The dynamic group is DATA-DRIVEN, one row per rotation channel — Shows & Shorts,
 * Shows, Shorts, Movies, and any future rotation. It used to hardcode two function
 * buckets and fold every `progress` channel into the first, which listed
 * "Younger Kids / Older Kids" three times each once the kid channels were split.
 * Each row's tier picker lists only THAT channel's own bindings, so a tier can
 * never appear twice. (decision `2026-07-29-dynamic-channels-first-class-and-deletable`)
 */

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

function PlayRow({
  label,
  meta,
  onPlay,
  set,
  tier,
  to,
}: {
  /**
   * Where this row GOES — a real link target, not an `onClick` that calls `navigate()`.
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
    // Each row wears its own queue's colour, so the landing page says at a glance which
    // service each button will talk to — the Kavita row's Open button is Kavita-green beside
    // the Plex rows' amber. (decision `2026-08-15-a-queue-wears-its-providers-colour`)
    <li
      className="playrow"
      // The id the reorder hook reads off the DOM after a drag — the rows it moves are
      // nodes, not React state, so the new order has to be legible from the elements.
      data-set={set?.id}
      data-provider={set?.provider_kind || undefined}
    >
      {/* Only the HANDLE starts a drag: the row is a link and its button plays something,
          so a whole-row drag would fight both. Hidden from assistive tech — it is a mouse
          affordance, and reordering is not the only way to get anywhere. */}
      <span
        aria-hidden="true"
        className="rowdrag"
        title="Drag to reorder"
      >
        ≡
      </span>
      <div className="rowmain">
        <Link className="rowname" to={to}>
          {label}
        </Link>
        <span className="rowmeta">{meta}</span>
      </div>
      {tier}
      {isPullSet(set) ? (
        // Nothing to cast to — the launcher URL is the whole affordance.
        <OpenQueueButton set={set!} />
      ) : (
        <button
          className="playbtn"
          onClick={(e) =>
            onPlay(e.currentTarget.getBoundingClientRect())
          }
          type="button"
        >
          ▶ Play on ▾
        </button>
      )}
    </li>
  )
}

/**
 * One filtered pool's row.
 *
 * **A pool is locked to ONE account, so there is normally no picker here.** The tier dropdown
 * existed because these pools predate being able to switch the Shield's Plex profile from the
 * app: one pool had to carry every tier's binding and you chose at play time. Every pool is
 * single-account now, and a control with one option is not a choice — it is a label wearing a
 * chevron. So the account moves into the row's meta line as TEXT, and the row gets the same
 * shape as a Curated Pool / Ordered Queue row: name, meta, one start button.
 * (decision `2026-08-17-a-filtered-pool-is-locked-to-one-account`)
 *
 * The picker is not deleted, only conditional: a pool that still carries two or more bindings
 * (a hand-edit, an older `sets.yaml`) keeps choosing at play time rather than silently playing
 * as whichever binding happens to be first.
 */
function ChannelRow({
  channel,
  groupLabel,
}: {
  channel: RegistrySet
  /** The group being viewed, so the row can drop that name from its own. */
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
  // hand-edit picked up over SSE) can delete the binding this row is still holding. Falling
  // back to the current default rather than trusting the stale value is what stops the row
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
    <PlayRow
      label={labelInGroup(channel.label, groupLabel)}
      set={channel}
      // Whose pool this is comes FIRST — "Shows" and "Shows & Shorts" are the same words
      // until you know one is Younger Kids and the other Older Kids, and that used to be
      // readable only off the dropdown this row no longer has.
      meta={
        onlyAccount
          ? `${onlyAccount} · ${behaviour}`
          : behaviour
      }
      to={`/channels/${encodeURIComponent(channel.id)}`}
      onPlay={(anchor) => {
        // With one binding the row does not ask — it plays as the account the pool is
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
   * The one predicate every shelf filters through. Group first (whose is it), provider
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

  const basePath = active ? groupPath(active) : "/"
  // Inside a group, a row drops that group's own name — the heading already says it, and
  // repeating it buries the one word that tells two rows apart. See `lib/setLabel.ts`.
  const groupLabel = active?.label ?? null

  const pools = rotationChannels(reg).filter((s) =>
    isShown(s.id),
  )
  const curated = channelSetIds(data).filter(isShown)
  const ordered = queueIds(data).filter(isShown)

  /**
   * A shelf with nothing in it is hidden ONLY while a filter is on.
   *
   * Unfiltered, an empty shelf still has to render: its "Configure ›" link is the only way
   * to create the first pool, and hiding it would make an empty install a dead end. Under a
   * filter the heading is just noise — you did not ask for a shelf, you asked for Bob's
   * things, and three headings over one row reads as if something failed to load.
   */
  const isFiltered = Boolean(active || only)
  const showShelf = (rows: unknown[]) =>
    !isFiltered || rows.length > 0

  // --- reorder ---------------------------------------------------------------- //
  // All three shelves are slices of ONE file order (sets.yaml), and `PATCH /api/sets-order`
  // takes the complete order and appends anything it was not told about. So a shelf's drop
  // permutes only the slots its own ids occupy and sends the whole list back — every other
  // shelf stays put, and so does every row a group filter is currently hiding.
  const poolsRef = useRef<HTMLUListElement>(null)
  const curatedRef = useRef<HTMLUListElement>(null)
  const orderedRef = useRef<HTMLUListElement>(null)

  const commitOrder = useCallback(
    (shelfOrder: string[]) => {
      // Read the LIVE store rather than this render's props: a drop lands after an arbitrary
      // amount of dragging, and the alternative is holding whatever `reg` was when the
      // listeners were bound.
      const state = getState()
      const full = (state.reg?.sets ?? []).map((x) => x.id)

      if (!full.length) return

      const next = spliceOrder(full, shelfOrder)

      if (next.join("\u0000") === full.join("\u0000"))
        return // dropped where it started

      // OPTIMISTIC, and not merely for polish: the drop restores the dragged node to where
      // React last rendered it (so React reconciles against a DOM it believes), which means
      // the row visibly snaps BACK until new data arrives. Waiting for `load()` would hold
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
        state.data.order = [...state.data.order].sort(
          byRank,
        )

      bumpRevision()
      setStatus("Saving order…")
      void api("PATCH", "/api/sets-order", { ids: next })
        .then(() => setStatus("Order saved", "ok"))
        .catch(async (e: Error) => {
          setStatus(`Reorder failed: ${e.message}`, "err")
          // The optimistic order is now a lie; re-read so the page shows what is on disk.
          await load()
        })
    },
    [],
  )

  useRowReorder(poolsRef, commitOrder, !isHidden)
  useRowReorder(curatedRef, commitOrder, !isHidden)
  useRowReorder(orderedRef, commitOrder, !isHidden)

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
          // The kinds of the group you are LOOKING AT, so the row offers Plex/Kavita only
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
      <section
        className="playgroup"
        hidden={!showShelf(pools)}
      >
        <h2>
          Filtered Pools
          <Link
            className="ghost"
            id="gochannels"
            to="/channels"
          >
            Configure ›
          </Link>
        </h2>
        <ul
          className="playlist"
          id="playdynamic"
          ref={poolsRef}
        >
          {isHidden
            ? null
            : pools.map((s) => (
                <ChannelRow
                  channel={s}
                  groupLabel={groupLabel}
                  key={s.id}
                />
              ))}
        </ul>
      </section>

      <section
        className="playgroup"
        hidden={!showShelf(curated)}
      >
        <h2>
          Curated Pools
          <Link
            className="ghost"
            id="gocurated"
            to="/channels"
          >
            Configure ›
          </Link>
        </h2>
        <ul
          className="playlist"
          id="playcurated"
          ref={curatedRef}
        >
          {isHidden
            ? null
            : curated.map((id) => {
                const s = data!.sets[id]!

                return (
                  <PlayRow
                    key={id}
                    label={labelInGroup(
                      s.label,
                      groupLabel,
                    )}
                    set={reg?.sets.find((x) => x.id === id)}
                    meta={`${s.items.length} shows · rotation`}
                    to={`/q/${id}`}
                    onPlay={(anchor) =>
                      openPlayMenu({ anchor, setId: id })
                    }
                  />
                )
              })}
        </ul>
      </section>

      <section
        className="playgroup"
        hidden={!showShelf(ordered)}
      >
        <h2>
          Ordered Queues
          <Link
            className="ghost"
            id="goqueues"
            to="/queues"
          >
            Configure ›
          </Link>
        </h2>
        <ul
          className="playlist"
          id="playqueues"
          ref={orderedRef}
        >
          {isHidden
            ? null
            : ordered.map((id) => {
                const s = data!.sets[id]!

                return (
                  <PlayRow
                    key={id}
                    label={labelInGroup(
                      s.label,
                      groupLabel,
                    )}
                    // The registry entry, same as the Curated rows above. Without it a
                    // Plex QUEUE renders in the neutral accent while a Plex CHANNEL two
                    // columns over renders amber — one page, two colours, same provider.
                    set={reg?.sets.find((x) => x.id === id)}
                    meta={`${s.items.length} titles · top plays next`}
                    to={`/q/${id}`}
                    onPlay={(anchor) =>
                      openPlayMenu({ anchor, setId: id })
                    }
                  />
                )
              })}
        </ul>
      </section>
    </main>
  )
}
