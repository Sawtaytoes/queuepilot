import { uiBusy } from "./busy"
import {
  fetchAll,
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
    const [data, reg] = await fetchAll()

    // The fetch takes seconds — a gesture may have STARTED meanwhile. Committing
    // now would replace the DOM under the drag. Defer.
    if (uiBusy()) {
      livePending = true

      return
    }

    setState({ data, reg })
    void refreshHistoryButtons()
  }
  catch {
    /* the next event retries */
  }
}

let source: EventSource | null = null

export function startLiveUpdates() {
  if (source) return () => {}

  source = new EventSource("/api/events")

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

  const timer = setInterval(() => {
    if (livePending && !uiBusy()) void liveRefresh()
  }, 2000)

  return () => {
    clearInterval(timer)
    source?.close()
    source = null
  }
}
