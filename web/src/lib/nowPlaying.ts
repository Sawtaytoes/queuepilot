import type { NowState, QueuesResponse, TileEntry } from "./types"

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
  Boolean(now.now && (now.now.state === "playing" || now.now.state === "paused"))

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

  if (item.ratingKey && String(item.ratingKey) === String(n.ratingKey)) return true

  if (item.type === "show" && ctx.showRatingKey) {
    return String(item.ratingKey) === String(ctx.showRatingKey)
  }

  if (item.type === "collection" && Array.isArray(ctx.collections)) {
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

  if (!q || !q.items) return null

  return q.items.some((it) => isPlayingItem(now, it)) ? now.set : null
}
