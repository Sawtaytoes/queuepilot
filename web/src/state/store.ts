import { useSyncExternalStore } from "react"

import { api } from "../lib/api"
import type {
  NowState,
  QueuesResponse,
  SetsResponse,
  StatusKind,
} from "../lib/types"

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
  now: NowState
  status: { msg: string; kind: StatusKind }
  history: { undo: number | boolean; redo: number | boolean }
  /** Bumped whenever `data`/`reg` are replaced in place by a mutation helper, so
   * subscribers re-render even though the object identity game is played by hand. */
  revision: number
}

let snapshot: Snapshot = {
  data: null,
  history: { redo: 0, undo: 0 },
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
  snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 }
  emit()
}

/** Re-publish the snapshot after an in-place mutation of `data`/`reg`. */
export const bumpRevision = () => setState({})

export const getState = () => snapshot

export const useStore = () => useSyncExternalStore(subscribe, getSnapshot)

// --- status toasts ----------------------------------------------------------- //
// Toasts auto-dismiss so "Order saved" / "Filters saved" don't linger forever
// (Bob's ask). A newer message cancels the previous timer; success/info clears in
// ~4s, errors linger ~10s. An empty message clears immediately with no timer.
let statusTimer: ReturnType<typeof setTimeout> | null = null

export function setStatus(msg: string, kind: StatusKind = "") {
  setState({ status: { kind, msg } })

  if (statusTimer) {
    clearTimeout(statusTimer)
    statusTimer = null
  }

  if (!msg) return

  const ms = kind === "err" ? 10000 : 4000

  statusTimer = setTimeout(() => {
    if (getState().status.msg === msg) setState({ status: { kind: "", msg: "" } })

    statusTimer = null
  }, ms)
}

// --- derived selectors ------------------------------------------------------- //
// Curated sets split by semantics: kind 'movies' = ordered QUEUE, 'anime' =
// random-order CHANNEL with explicit members (the taxonomy decision).
export const curatedIds = (data: QueuesResponse | null) =>
  data ? data.order.filter((id) => data.sets[id]?.source === "queue") : []

export const queueIds = (data: QueuesResponse | null) =>
  curatedIds(data).filter((id) => data!.sets[id]!.kind !== "anime")

export const channelSetIds = (data: QueuesResponse | null) =>
  curatedIds(data).filter((id) => data!.sets[id]!.kind === "anime")

/**
 * PR 4 cutover: a migrated function channel carries `profiles[]` bindings and a
 * behavior; a legacy tier set (one synthesized binding, no behavior) still works
 * everywhere. The superseded legacy tiers stay in the registry (soak) but out of
 * every picker.
 */
export const rotationChannels = (reg: SetsResponse | null) =>
  reg ? reg.sets.filter((s) => s.source === "rotation" && !s.superseded_by) : []

// --- loading ----------------------------------------------------------------- //
export async function refreshHistoryButtons() {
  try {
    const h = await api<{ undo: number; redo: number }>("GET", "/api/history")

    setState({ history: h })
  }
  catch {
    /* cosmetic */
  }
}

/** Re-fetch both files. Used by `load()` and by every mutation that needs a resync. */
export async function fetchAll(): Promise<[QueuesResponse, SetsResponse]> {
  return Promise.all([
    api<QueuesResponse>("GET", "/api/queues"),
    api<SetsResponse>("GET", "/api/sets"),
  ])
}

export async function load() {
  setStatus("Loading…")

  try {
    const [data, reg] = await fetchAll()

    setState({ data, reg })

    // Retained MQTT means a reload mid-session lands with the highlight already
    // correct, rather than waiting for the next playback event.
    try {
      const n = await api<NowState>("GET", "/api/now")

      setState({ now: { now: n.now || null, set: n.set || null } })
    }
    catch {
      /* cosmetic — the `now` SSE event fills it in */
    }

    setStatus("Ready", "ok")
    void refreshHistoryButtons()
  }
  catch (e) {
    setStatus("Failed: " + (e as Error).message, "err")
  }
}
