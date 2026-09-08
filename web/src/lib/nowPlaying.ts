import type {
  NowState,
  QueuesResponse,
  TileEntry,
} from "./types"

/**
 * Which queue is genuinely running, and which tile holds what is on screen.
 *
 * `NOW.set` alone is NOT enough: the MQTT session topic is retained, so it still
 * names the last-started queue days later, and anyone watching something unrelated
 * on that Shield would light it up as "Playing". A curated queue plays its own
 * entries, so we additionally require that what is on screen actually matches one —
 * which also means the shelf pill and the tile highlight can never disagree.
 */

/** Paused still counts as active — the queue is mid-session, just held. */
export const isNowLive = (now: NowState) =>
  Boolean(
    now.now &&
      (now.now.state === "playing" ||
        now.now.state === "paused"),
  )

/**
 * WHERE playback has actually reached, in MILLISECONDS — the one client-side converter.
 *
 * ⚠️ **The now-playing payload speaks SECONDS and everything else in this app speaks
 * milliseconds.** `finished.ts nowPlayingMs()` is the server's single converter and this is
 * the browser's, deliberately one each rather than one per consumer: the Now-playing bar's
 * scrubber and the section editor's capture buttons ask the same question, and two
 * extrapolators that drift would put a mark somewhere the bar never showed.
 *
 * The position is INTERPOLATED, not polled. Plex reports a position only when something
 * changes, so `position` is a reading that is quietly getting older; `positionAt` (epoch
 * seconds) is what makes it usable, because the elapsed time since is added locally. The
 * clock stops while paused — `positionAt` does not advance when nothing is playing, and
 * adding wall-clock to it would run the value off the end of a paused episode.
 *
 * Null when nothing is on screen. Never `0` for that: `0` is the first frame, which is a real
 * position somebody may want to mark.
 */
export function nowPlayingPositionMs(
  now: NowState,
): number | null {
  const payload = now.now

  if (!isNowLive(now) || !payload) return null

  const reported = Number(payload.position) || 0
  const reportedAt = Number(payload.positionAt) || 0
  const durationSeconds = Number(payload.duration) || 0
  const elapsed =
    payload.state === "paused" || !reportedAt
      ? 0
      : Math.max(0, Date.now() / 1_000 - reportedAt)
  const seconds = Math.min(
    durationSeconds || Number.POSITIVE_INFINITY,
    reported + elapsed,
  )

  return Math.round(seconds * 1_000)
}

/**
 * Does this tile hold what's on screen? A movie matches its own key; a SERIES tile
 * matches the playing episode's show; a COLLECTION tile matches by name (see
 * `plex.playingContext`).
 */
export function isPlayingItem(
  now: NowState,
  item: TileEntry | null | undefined,
): boolean {
  if (!isNowLive(now) || !item) return false

  const n = now.now!
  const ctx = n.context || {}

  if (
    item.ratingKey &&
    String(item.ratingKey) === String(n.ratingKey)
  )
    return true

  if (item.type === "show" && ctx.showRatingKey) {
    return (
      String(item.ratingKey) === String(ctx.showRatingKey)
    )
  }

  if (
    item.type === "collection" &&
    Array.isArray(ctx.collections)
  ) {
    return ctx.collections.some((c) => c === item.title)
  }

  return false
}

export function activeSet(
  now: NowState,
  data: QueuesResponse | null,
): string | null {
  if (!isNowLive(now) || !now.set || !data) return null

  const q = data.sets[now.set]

  if (!q?.items) return null

  return q.items.some((it) => isPlayingItem(now, it))
    ? now.set
    : null
}
