import {
  api,
  apiConditional,
  NOT_MODIFIED,
} from "../lib/api"
import type {
  NowState,
  QueuesResponse,
  SetsResponse,
} from "../lib/types"
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

  // A click / explicit refresh has to re-read Kavita. The ETag only covers YAML
  // + cache generation, so a conditional GET would 304 and leave "Ch 35" sitting
  // after you marked it read in Kavita.
  if (!uiBusy()) void liveRefresh({ force: true })
}

/**
 * Fetch one endpoint and commit it on its own.
 *
 * **The two endpoints are refreshed INDEPENDENTLY, and that is the point.** `/api/sets` is a
 * YAML read that answers in ~10 ms; `/api/queues` resolves every entry of every queue against
 * Plex and Kavita and takes 7–9 s even with a warm cache. They used to be joined in one
 * `Promise.all` whose result was committed together, which made both of these true:
 *
 *   * a settings change made in another tab (a renamed queue, a deleted profile binding) sat
 *     invisible here for the length of the SLOW half, so "syncing across tabs" looked broken
 *     when it was only late; and
 *   * if the slow half threw — Plex asleep, Kavita restarting, a dropped socket — the fast
 *     half was discarded with it and nothing was committed at all.
 *
 * Returns whether it committed, so the caller only re-reads the undo counters when something
 * actually moved.
 */
async function refreshOne<TResponse>(
  read: () => Promise<TResponse | typeof NOT_MODIFIED>,
  commit: (value: TResponse) => void,
): Promise<boolean> {
  try {
    const value = await read()

    // A `304`: this endpoint genuinely has not moved. That is B8 layer 1 (conditional GET),
    // which is what makes an SSE storm nearly free — the common event is a `now-playing`
    // tick, which leaves both files untouched — and what fixes the optimistic-edit
    // clobbering race, where such a tick used to force a refetch that overwrote a rename
    // made a moment earlier.
    if (value === NOT_MODIFIED) return false

    // The fetch may have taken seconds — a gesture may have STARTED meanwhile, and
    // committing now would replace the DOM under the drag. Defer to the retry timer.
    if (uiBusy()) {
      livePending = true

      return false
    }

    commit(value as TResponse)

    return true
  } catch {
    // A failed refresh is NOT self-healing on its own. `livePending` is cleared at the top
    // of `liveRefresh`, and the 2 s timer only retries while it is set — so without this
    // line one failed fetch left the tab stale until the next SSE event or a tab focus, and
    // a config edit produces exactly ONE `data` event. Hence: mark it pending and let the
    // timer come back for it.
    livePending = true

    return false
  }
}

export async function liveRefresh({
  force = false,
}: {
  force?: boolean
} = {}) {
  if (uiBusy()) {
    livePending = true

    return
  }

  livePending = false

  // `force` is the other half of the conditional-GET story: Kavita has no webhook, so
  // marking a chapter read there never bumps the ETag. Tab-focus and an explicit refresh
  // must hit series-detail again, or the tile stays on the chapter you just finished.
  const committed = await Promise.all([
    // The registry FIRST in reading order because it is the one that returns immediately;
    // both are in flight at once, so this is documentation, not scheduling.
    refreshOne<SetsResponse>(
      () =>
        force
          ? api<SetsResponse>("GET", "/api/sets")
          : apiConditional<SetsResponse>("/api/sets"),
      (reg) => setState({ reg }),
    ),
    refreshOne<QueuesResponse>(
      () =>
        force
          ? api<QueuesResponse>("GET", "/api/queues")
          : apiConditional<QueuesResponse>("/api/queues"),
      (data) => setState({ data }),
    ),
  ])

  if (committed.some(Boolean)) void refreshHistoryButtons()
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

    setState({
      now: { now: n.now || null, set: n.set || null },
    })
  } catch {
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
    // Reconnect after a sleep has to re-read Kavita; a 304 would keep the
    // chapter you marked read in the other tab.
    void liveRefresh({ force: true })
  })

  source.addEventListener("data", () => void liveRefresh())

  // Live playback: repaint the active-queue pill + the playing-tile highlight.
  // Presentation only, so unlike liveRefresh it needs no refetch — but it still
  // re-renders, so a mid-drag repaint would fight the gesture. Defer on busy.
  source.addEventListener("now", (ev) => {
    let payload: { now?: unknown; set?: string } | null =
      null

    try {
      payload = JSON.parse((ev as MessageEvent).data)
    } catch {
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
    } catch {
      return
    }

    if (
      !st ||
      typeof st !== "object" ||
      !Object.keys(st).length
    )
      return

    const s = st as {
      error?: string
      awaiting?: string
      playback?: {
        client?: string
        played?: boolean
        error?: string
      }
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
      } else {
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
    void liveRefresh({ force: true })
  }
  document.addEventListener("visibilitychange", onVisible)

  const timer = setInterval(() => {
    if (livePending && !uiBusy()) void liveRefresh()
  }, 2000)

  return () => {
    clearInterval(timer)
    document.removeEventListener(
      "visibilitychange",
      onVisible,
    )
    source?.close()
    source = null
  }
}
