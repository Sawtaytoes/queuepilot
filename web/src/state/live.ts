import { api, apiConditional, NOT_MODIFIED } from "../lib/api"
import type { NowState, QueuesResponse, SetsResponse } from "../lib/types"
import { uiBusy } from "./busy"
import {
  getState,
  refreshHistoryButtons,
  setState,
  setStatus,
} from "./store"

/**
 * Live updates: the server pushes a ping whenever queues.yaml / sets.yaml change
 * (another tab, the Python prune after a scan, an SMB hand-edit) and the app
 * re-fetches itself — there is no Refresh button, and `channels-test` asserts
 * `#refresh` does not exist.
 *
 * Everything here is deferred while `uiBusy()`; see `state/busy.ts` for why.
 */

let livePending = false

/** Background refresh — MUST go through the same guard as the SSE live updates. */
export function refreshData() {
  livePending = true

  if (!uiBusy()) void liveRefresh()
}

export async function liveRefresh() {
  if (uiBusy()) {
    livePending = true

    return
  }

  livePending = false

  try {
    // CONDITIONAL fetch (B8). An SSE event fires on any change, but the common one —
    // a `now-playing` tick — leaves the queues untouched, so `/api/queues` answers
    // `304` and this returns without touching the store at all: no re-render, no CLS,
    // no gesture disruption. Only a genuine change (a 200 with a new ETag) commits.
    const [data, reg] = await Promise.all([
      apiConditional<QueuesResponse>("/api/queues"),
      apiConditional<SetsResponse>("/api/sets"),
    ])

    // The fetch may take a moment — a gesture may have STARTED meanwhile. Committing
    // now would replace the DOM under the drag. Defer.
    if (uiBusy()) {
      livePending = true

      return
    }

    // Nothing changed on either endpoint — skip the whole commit.
    //
    // This is B8 layer 1 (conditional GET), which alone makes an SSE storm nearly free
    // and fixes the optimistic-edit-clobbering race (a `now-playing` tick used to force a
    // full refetch that overwrote a just-made rename). Layers 2 (echo the originating
    // client id so a client skips the refetch for its OWN mutation) and 3 (per-set deltas)
    // are deferred refinements — with the 304 path this cheap, their marginal value is low.
    if (data === NOT_MODIFIED && reg === NOT_MODIFIED) return

    const patch: Parameters<typeof setState>[0] = {}

    if (data !== NOT_MODIFIED) patch.data = data
    if (reg !== NOT_MODIFIED) patch.reg = reg

    setState(patch)
    void refreshHistoryButtons()
  }
  catch {
    /* the next event retries */
  }
}

/**
 * Reconcile the now-playing tile after a gap in the SSE stream. A backgrounded tab
 * (a phone sleeping the browser) drops the EventSource and misses the `now` events
 * published while it was gone, so on return the tile shows the stale page-load value.
 * Re-fetching `/api/now` — the same shape the store hydrates from on first load —
 * pulls the current snapshot in one shot. Cosmetic on failure: the next `now` event
 * fills it in.
 */
async function resyncNow() {
  try {
    const n = await api<NowState>("GET", "/api/now")

    setState({ now: { now: n.now || null, set: n.set || null } })
  }
  catch {
    /* the next `now` SSE event fills it in */
  }
}

let source: EventSource | null = null

export function startLiveUpdates() {
  if (source) return () => {}

  source = new EventSource("/api/events")

  // A resumed/reconnected stream re-syncs both halves: `/api/now` for the playing tile
  // and `liveRefresh` (conditional GET — a 304 no-ops) for the queues/sets. `open` fires
  // on the initial connect AND on every automatic reconnect, so a dropped-then-restored
  // connection reconciles without a manual refresh. (The server also replays the current
  // `now` snapshot to a freshly-connected client; this covers the client-driven wake.)
  source.addEventListener("open", () => {
    void resyncNow()
    void liveRefresh()
  })

  source.addEventListener("data", () => void liveRefresh())

  // Live playback: repaint the active-queue pill + the playing-tile highlight.
  // Presentation only, so unlike liveRefresh it needs no refetch — but it still
  // re-renders, so a mid-drag repaint would fight the gesture. Defer on busy.
  source.addEventListener("now", (ev) => {
    let payload: { now?: unknown; set?: string } | null = null

    try {
      payload = JSON.parse((ev as MessageEvent).data)
    }
    catch {
      return
    }

    if (!payload) return

    const next = {
      now: (payload.now as never) || null,
      set: payload.set || null,
    }

    if (!getState().data || uiBusy()) {
      // Still record it — the next quiet render picks it up — but don't force one.
      setState({ now: next })

      return
    }

    setState({ now: next })
  })

  // Play results (published to plex-channels/state after a session start) toast
  // inline.
  source.addEventListener("state", (ev) => {
    let st: Record<string, never> | null = null

    try {
      st = JSON.parse((ev as MessageEvent).data)
    }
    catch {
      return
    }

    if (!st || typeof st !== "object" || !Object.keys(st).length) return

    const s = st as {
      error?: string
      awaiting?: string
      playback?: { client?: string; played?: boolean; error?: string }
      now?: { title?: string; show?: string }
    }

    if (s.error) {
      setStatus(`Play: ${s.error}`, "err")

      return
    }

    if (s.awaiting === "profile") {
      setStatus("Waiting for a profile on the Shield…")

      return
    }

    if (s.playback) {
      const dev = s.playback.client || "device"

      if (s.playback.played) {
        setStatus(
          `Playing ${s.now?.title || s.now?.show || ""} on ${dev}`,
          "ok",
        )
      }
      else {
        setStatus(
          `Play failed on ${dev}: ${s.playback.error || "unknown"}`,
          "err",
        )
      }
    }
  })

  // A tab returning to the foreground reconciles immediately rather than waiting for the
  // browser to notice the SSE socket died and reconnect (which is what fires `open` above).
  // Mobile Safari in particular can hold a zombie EventSource open across a long sleep, so
  // `visibilitychange` is the reliable signal that the user is looking again.
  const onVisible = () => {
    if (document.visibilityState !== "visible") return

    void resyncNow()
    void liveRefresh()
  }
  document.addEventListener("visibilitychange", onVisible)

  const timer = setInterval(() => {
    if (livePending && !uiBusy()) void liveRefresh()
  }, 2000)

  return () => {
    clearInterval(timer)
    document.removeEventListener("visibilitychange", onVisible)
    source?.close()
    source = null
  }
}
