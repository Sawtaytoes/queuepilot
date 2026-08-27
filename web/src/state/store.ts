import { useSyncExternalStore } from "react"

import { api, writeCount } from "../lib/api"
import type {
  GroupsResponse,
  NowState,
  QueuesResponse,
  SetsResponse,
  ShelvesResponse,
  StatusKind,
} from "../lib/types"
import { uiBusy } from "./busy"
import { loadPeople } from "./people"

/**
 * One module-level store, read through `useSyncExternalStore`.
 *
 * This is deliberately not React context + a reducer. The vanilla app kept `DATA`,
 * `REG`, `NOW` and `selected` as module globals that *any* handler could read, and
 * a dozen of its correctness rules are stated in those terms — `uiBusy()` reads six
 * of them at once from an SSE callback that has no component to hang off. Modelling
 * them as module state and subscribing components to the whole snapshot keeps those
 * rules literally true, and matches the original's "repaint the whole view" model,
 * which is what `gridPaintedSet` / `membersPaintedCh` / the FLIP guards assume.
 *
 * Search input state deliberately stays local to its component, so typing does not
 * re-render the grid.
 */

export type Snapshot = {
  data: QueuesResponse | null
  reg: SetsResponse | null
  /** Who is watching, with membership resolved server-side. Null until first load —
   * the group bar renders nothing rather than a wrong bar. */
  groups: GroupsResponse | null
  now: NowState
  status: { msg: string; kind: StatusKind }
  history: {
    undo: number | boolean
    redo: number | boolean
  }
  /** Bumped whenever `data`/`reg` are replaced in place by a mutation helper, so
   * subscribers re-render even though the object identity game is played by hand. */
  revision: number
  /**
   * True while PHASE 3 is running — the pass that re-reads Plex and Kavita behind the page
   * that has already painted. The header renders a thin progress line for exactly this
   * (decision `2026-08-26-a-provider-read-is-cached-and-the-page-revalidates-after-it-paints`).
   *
   * It is a separate flag and not a `status` toast on purpose: a toast auto-dismisses after
   * four seconds and this pass takes six, so the message would leave before the work did.
   */
  isRevalidating: boolean
}

let snapshot: Snapshot = {
  data: null,
  history: { redo: 0, undo: 0 },
  groups: null,
  isRevalidating: false,
  reg: null,
  now: { now: null, set: null },
  revision: 0,
  status: { kind: "", msg: "" },
}

const listeners = new Set<() => void>()

const emit = () => {
  for (const l of listeners) l()
}

function subscribe(listener: () => void) {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = () => snapshot

export function setState(patch: Partial<Snapshot>) {
  snapshot = {
    ...snapshot,
    ...patch,
    revision: snapshot.revision + 1,
  }
  emit()
}

/** Re-publish the snapshot after an in-place mutation of `data`/`reg`. */
export const bumpRevision = () => setState({})

export const getState = () => snapshot

export const useStore = () =>
  useSyncExternalStore(subscribe, getSnapshot)

// --- status toasts ----------------------------------------------------------- //
// Toasts auto-dismiss so "Order saved" / "Filters saved" don't linger forever
// (Bob's ask). A newer message cancels the previous timer; success/info clears in
// ~4s, errors linger ~10s. An empty message clears immediately with no timer.
let statusTimer: ReturnType<typeof setTimeout> | null = null

export function setStatus(
  msg: string,
  kind: StatusKind = "",
) {
  setState({ status: { kind, msg } })

  if (statusTimer) {
    clearTimeout(statusTimer)
    statusTimer = null
  }

  if (!msg) return

  const ms = kind === "err" ? 10000 : 4000

  statusTimer = setTimeout(() => {
    if (getState().status.msg === msg)
      setState({ status: { kind: "", msg: "" } })

    statusTimer = null
  }, ms)
}

// --- derived selectors ------------------------------------------------------- //
/**
 * EVERY Picks queue — every hand-picked (`source: queue`) set, whatever its lane default.
 *
 * There used to be two more selectors beside this one, `queueIds` and `channelSetIds`, which
 * split this list on `add_as` and handed each half to a different SCREEN: the priority half
 * to Picks (`/queues`), the random half to Rules (`/channels`). That was the last of the
 * three-way Ordered Queue / Curated Pool / Filtered Pool taxonomy, and it put ten of the
 * household's Picks queues in the Rules picker — `Kevin — Anime` and `Manga & Webtoons` sat
 * in a dropdown headed by two rules queues, on a page whose heading says Rules.
 *
 * `add_as` is a LANE DEFAULT, not a product kind. It decides which lane a new entry lands in
 * inside one Picks queue; it never decides which page the queue lives on
 * (decision `2026-08-26-a-picks-queue-lives-on-the-picks-screen-whichever-lane-it-defaults-to`).
 */
export const curatedIds = (data: QueuesResponse | null) =>
  data
    ? data.order.filter(
        (id) => data.sets[id]?.source === "queue",
      )
    : []

/**
 * PR 4 cutover: a migrated function channel carries `profiles[]` bindings and a
 * behavior; a legacy tier set (one synthesized binding, no behavior) still works
 * everywhere. The superseded legacy tiers stay in the registry (soak) but out of
 * every picker.
 */
export const rotationChannels = (
  reg: SetsResponse | null,
) =>
  reg
    ? reg.sets.filter(
        (s) => s.source === "rotation" && !s.superseded_by,
      )
    : []

// --- loading ----------------------------------------------------------------- //
export async function refreshHistoryButtons() {
  try {
    const h = await api<{ undo: number; redo: number }>(
      "GET",
      "/api/history",
    )

    setState({ history: h })
  } catch {
    /* cosmetic */
  }
}

/**
 * Re-read the GROUPS only.
 *
 * Separate from `load()` on purpose: `load()` re-resolves every queue against Plex and
 * Kavita and takes 7-9 s, while this is a YAML read plus a join and answers in ~10 ms. The
 * groups editor saves through this, because a save that takes eight seconds to reflect is a
 * save the user assumes failed — and worse, the editor re-seeds its form when the refreshed
 * store arrives, so a slow one lands ON TOP of whatever was typed next.
 */
export async function refreshGroups(): Promise<void> {
  try {
    setState({
      groups: await api<GroupsResponse>(
        "GET",
        "/api/groups",
      ),
    })
  } catch {
    /* the SSE `data` event retries — groups.yaml is watched */
  }
}

/** Re-fetch both files. Used by `load()` and by every mutation that needs a resync. */
export async function fetchAll(): Promise<
  [QueuesResponse, SetsResponse]
> {
  return Promise.all([
    api<QueuesResponse>("GET", "/api/queues"),
    api<SetsResponse>("GET", "/api/sets"),
  ])
}

/**
 * Widen the `/api/shelves` skeleton into the `QueuesResponse` shape the whole app
 * renders against, with every item marked `pending`. Nothing branches on which
 * endpoint the data came from — the tile checks `pending` and draws a skeleton
 * poster, and `/api/queues` later replaces the object wholesale.
 */
function shelvesAsQueues(
  shelves: ShelvesResponse,
): QueuesResponse {
  const sets: QueuesResponse["sets"] = {}

  for (const id of shelves.order) {
    const s = shelves.sets[id]

    if (!s) continue

    sets[id] = {
      items: s.items.map((it) => ({
        childCount: null,
        done: it.done,
        episodes: null,
        weight: 1,
        key: it.key,
        nextEp: null,
        pending: true,
        // The LANE the entry is stored in. Carried through the skeleton so the Picks
        // shelf draws its Priority run, its divider and its pool run at FINAL geometry —
        // dropping it here put every entry in the set's default lane for the first paint
        // and moved the whole strip when /api/queues landed.
        placement: it.placement ?? null,
        ratingKey: null,
        raw: it.raw,
        resolved: false,
        start: null,
        title: it.title,
        type: null,
        year: null,
      })),
      kind: s.kind,
      // Lane default — without it every picks set looks random until /api/queues lands.
      ...(s.add_as ? { add_as: s.add_as } : {}),
      label: s.label,
      sections: s.sections,
      source: s.source,
    }
  }

  return { order: shelves.order, sets }
}

/**
 * PHASE 3 — re-read the providers behind the page that has already painted.
 *
 * Phases 1 and 2 are served from the item-resolution caches and make no provider call at all,
 * which is what took a warm `/api/queues` from 5.1 s to about 0.55 s. The cost of that is that
 * both are answers nobody re-checked, so this pass asks for the same thing with `?fresh=1`,
 * which re-reads Plex and Kavita and rewrites the rows
 * (decision `2026-08-26-a-provider-read-is-cached-and-the-page-revalidates-after-it-paints`).
 *
 * Three things it deliberately does NOT do:
 *
 *   * it does not block anything. The page is interactive throughout, and a failure is
 *     silent — the cached copy is already on screen and is still the best answer available;
 *   * it does not run on a route change. `load()` is the real page load, and a pass costs
 *     566 provider calls against somebody's self-hosted Plex and Kavita;
 *   * it does not toast. `isRevalidating` drives a progress line in the header instead,
 *     because the owner asked to be told BEFORE the tiles change rather than after — "so it
 *     doesn't just pop in with new content randomly".
 */
export async function revalidate(): Promise<void> {
  if (getState().isRevalidating) return

  setState({ isRevalidating: true })

  // What the page had written when this question was ASKED. The answer describes the files as
  // they were at that moment, and this pass is slow enough — about seven seconds — that a
  // promote, a demote, a remove or a rename can happen inside it.
  const askedAt = writeCount()

  try {
    const data = await api<QueuesResponse>(
      "GET",
      "/api/queues?fresh=1",
    )

    // A WRITE LANDED WHILE THIS WAS IN FLIGHT, so the payload predates it and committing it
    // would put the entry back in the lane the user just moved it out of — with the file
    // saying the opposite, until the next page load agreed with the file again. Drop it: the
    // copy on screen is already complete, and the only thing this pass adds is fresher
    // provider fields. It is the same rule the live path states as "the optimistic-edit
    // clobbering race", which the conditional GET handles there and cannot handle here
    // (`?fresh=1` re-reads the providers, so it never 304s).
    // (decision `2026-08-27-a-revalidate-never-overwrites-a-write-it-did-not-see`)
    if (writeCount() !== askedAt) return

    // And never mid-gesture, for the reason `state/live.ts` gives: committing a whole payload
    // replaces the DOM under a drag.
    if (uiBusy()) return

    setState({ data })
  } catch {
    /* the cached copy is on screen and stays there */
  } finally {
    setState({ isRevalidating: false })
  }
}

export async function load() {
  setStatus("Loading…")

  /**
   * TWO phases, deliberately.
   *
   * `/api/queues` has to talk to Plex — roughly sixty calls to resolve titles, next
   * episodes and collection children — and takes 2.6-2.8 s. Waiting for it left the
   * page blank and then inserted ten shelves at once, which is where the 0.398 CLS
   * came from and most of what "the app feels slow" meant.
   *
   * Phase 1 paints the COMPLETE page structure: `/api/shelves` (~15 ms, no Plex at
   * all) for the shelves and their tile count, and `/api/sets` for the registry.
   * Phase 2 swaps in resolved posters and next-episode lines. The second response
   * changes pixels, not layout.
   *
   * **The registry belongs in phase 1, not phase 2.** It is what the Play landing's
   * Dynamic group renders from, and `/api/sets` costs exactly one Plex call
   * (`/library/sections`) that already degrades to an empty library list when Plex is
   * down. Leaving it in phase 2 painted a landing page with an empty Dynamic group
   * for as long as `/api/queues` took, and those rows then popped in — reintroducing
   * the shift this phase exists to remove. `e2e/ui-test.mjs` catches it.
   *
   * Phase 1 is best-effort as a whole: if it throws, phase 2 still renders the page
   * exactly as it did before any of this existed.
   */
  let havePhase1 = false

  try {
    // Groups ride in PHASE 1 with the registry, for the same reason the registry does:
    // the group bar is above the fold and its absence moves everything under it. It is
    // a YAML read plus a join, so it costs about what /api/sets costs.
    const [shelves, reg, groups] = await Promise.all([
      api<ShelvesResponse>("GET", "/api/shelves"),
      api<SetsResponse>("GET", "/api/sets"),
      api<GroupsResponse>("GET", "/api/groups").catch(
        () => null,
      ),
    ])

    setState({
      data: shelvesAsQueues(shelves),
      groups,
      reg,
    })
    havePhase1 = true

    // WP-5: who each queue is FOR. Phase 1, beside the registry and for the same reason — the
    // shelf headings paint faces, and fetching them in phase 2 would pop a row of avatars in
    // after the shelves had already laid out. Its own slice, so a tray drag re-renders the
    // editor and not every poster. Best effort inside itself; nothing here awaits a failure.
    void loadPeople()
  } catch {
    /* skeleton is an optimization — fall through to the full fetch */
  }

  try {
    // Phase 1 already has the registry, so don't ask for it twice.
    const [data, reg] = havePhase1
      ? [
          await api<QueuesResponse>("GET", "/api/queues"),
          getState().reg!,
        ]
      : await fetchAll()

    setState({ data, reg })

    // Retained MQTT means a reload mid-session lands with the highlight already
    // correct, rather than waiting for the next playback event.
    try {
      const n = await api<NowState>("GET", "/api/now")

      setState({
        now: { now: n.now || null, set: n.set || null },
      })
    } catch {
      /* cosmetic — the `now` SSE event fills it in */
    }

    setStatus("Ready", "ok")
    void refreshHistoryButtons()
    void revalidate()
  } catch (e) {
    setStatus(`Failed: ${(e as Error).message}`, "err")
  }
}
