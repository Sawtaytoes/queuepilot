// In-process rotation preview for ENGINE=node (D3 follow-on #4). Mirrors
// queue_builder/service.do_preview's response shape so the Channels view can consume Node
// without a payload rewrite. Python still runs in dual-run soak for divergence logging.

import { defined } from "../defined.js"
import { errMessage } from "../errors.js"
import type {
  Bucket,
  PlexClient,
  PoolItem,
} from "../types.js"
import { liveClient } from "./plex-live.js"
import * as rotation from "./rotation.js"
import * as routing from "./routing.js"
import * as select from "./select.js"
import { toWeight } from "./weight.js"

/** One formatted bucket — the MQTT/API preview shape `service.do_preview` publishes. */
export interface PreviewBucket {
  show: string
  ratingKey: string
  unwatched: number
  weight: number
  next: {
    ratingKey: string
    title: string | undefined
    season: number | null | undefined
    episode: number | null | undefined
    // eslint-disable-next-line @typescript-eslint/naming-convention -- a field of the app's HTTP JSON
    multiSeason: boolean
  } | null
  /** Only an item/library bucket (Shorts) lists its items; a show bucket sends null. */
  items:
    | { ratingKey: string; title: string | undefined }[]
    | null
}

/** One rewatch-pool row. */
export interface MoviePoolRow {
  ratingKey: string
  title: string | null
  count: number
}

/**
 * `previewRotation()`'s payload — `service.do_preview`'s response shape.
 *
 * A type ALIAS, not an interface, so `routes/playbackRoutes.ts` can keep receiving it into a
 * `Record<string, unknown>` before bolting its `routing` block on.
 */
export type RotationPreview = {
  set: string
  engine: "node"
  buckets: PreviewBucket[]
  movie: { ratingKey: string; title: string | null } | null
  movie_pool: MoviePoolRow[]
  /** Sent only when a profile was named, exactly as the JS added it conditionally. */
  profile?: string
}

// The first episode of a bucket, or null when it has none.
function nextOf(
  eps: readonly PoolItem[],
  bucket: Bucket,
): PreviewBucket["next"] {
  if (!eps.length) return null
  const first = defined(eps[0])
  return {
    ratingKey: first.ratingKey,
    title: first.title,
    season: first.season,
    episode: first.episode,
    multiSeason: Boolean(bucket.multi_season),
  }
}

// Format channel_buckets into the MQTT/API preview bucket shape (service.do_preview).
export function formatBuckets(
  buckets: readonly Bucket[] | null | undefined,
): PreviewBucket[] {
  return (buckets || []).map((bucket) => {
    const eps: readonly PoolItem[] = bucket.episodes || []
    const isLib = String(bucket.ratingKey).startsWith(
      "section-",
    )
    return {
      show: bucket.show,
      ratingKey: bucket.ratingKey,
      unwatched: eps.length,
      // Slots per round when the channel is randomized. Always sent (1 = normal) so the pool
      // tile can render its control without a second lookup into the set registry.
      weight: toWeight(bucket.weight),
      next: nextOf(eps, bucket),
      items: isLib
        ? [...eps]
            .map((episode) => ({
              ratingKey: episode.ratingKey,
              title: episode.title,
            }))
            .sort((left, right) =>
              String(left.title || "")
                .toLowerCase()
                .localeCompare(
                  String(right.title || "").toLowerCase(),
                ),
            )
        : null,
    }
  })
}

// Stable signature for divergence logging.
// Show buckets: compare next (the meaningful "what plays first").
// Library/section buckets (Shorts): compare the ITEM SET only — `next` is the first
// episode of whatever listing order each engine happened to see, while play-time
// shuffles the pile; matching item keys is the real parity signal (live soak saw a
// false DIVERGENCE on shows_shorts where only Shorts.next differed).
/**
 * What the signature functions read. Looser than `PreviewBucket` on purpose: this is fed BOTH
 * engines' formatted buckets (the Python payload arrives off MQTT as plain JSON) so the two can
 * be diffed, and it must not assume the other side's fill.
 */
type SignatureBucket = {
  show?: unknown
  ratingKey?: unknown
  unwatched?: unknown
  items?: readonly { ratingKey?: unknown }[] | null
  next?: {
    ratingKey?: unknown
    season?: unknown
    episode?: unknown
  } | null
}

export function bucketsSignature(
  buckets: readonly SignatureBucket[] | null | undefined,
): string {
  return JSON.stringify(
    (buckets || []).map((bucket) => {
      const rk = String(bucket.ratingKey)
      const isLib =
        rk.startsWith("section-") ||
        Array.isArray(bucket.items)
      const base = {
        show: bucket.show,
        ratingKey: rk,
        unwatched: bucket.unwatched,
        items: bucket.items
          ? bucket.items
              .map((item) => String(item.ratingKey))
              .sort()
          : null,
      }
      if (isLib) return base
      return {
        ...base,
        next: bucket.next
          ? {
              ratingKey: String(bucket.next.ratingKey),
              season: bucket.next.season,
              episode: bucket.next.episode,
            }
          : null,
      }
    }),
  )
}

export function moviePoolSignature(
  pool:
    | readonly { ratingKey?: unknown; count?: unknown }[]
    | null
    | undefined,
): string {
  return JSON.stringify(
    (pool || []).map((member) => ({
      ratingKey: String(member.ratingKey),
      count: member.count,
    })),
  )
}

// Weighted 1/n² pick (Python pick_rewatch_movie). Uses Math.random — rng, not parity-gated.
function pickRewatch(
  counts: ReadonlyMap<string, number>,
  titles: ReadonlyMap<string, string | undefined>,
  excludes: ReadonlySet<string> = new Set<string>(),
): { ratingKey: string; title: string | null } | null {
  const candidates: [string, number][] = []
  for (const [rk, count] of counts) {
    if (excludes.has(String(rk))) continue
    if (count < 1) continue
    candidates.push([rk, count])
  }
  if (!candidates.length) return null
  const weights = candidates.map(
    ([, candidate]) => 1 / (candidate * candidate),
  )
  let total = 0
  for (const weight of weights) total += weight
  let roll = Math.random() * total
  // The last-element fallback runs only after the empty check above.
  for (const [index, [rk]] of candidates.entries()) {
    roll -= defined(weights[index])
    if (roll <= 0) {
      return {
        ratingKey: rk,
        title: titles.get(rk) || null,
      }
    }
  }
  const [rk] = defined(candidates[candidates.length - 1])
  return { ratingKey: rk, title: titles.get(rk) || null }
}

/** Compute a rotation channel's preview with the live undici client. */
export async function previewRotation(
  setId: string,
  profileTitle = "",
  client: PlexClient | null = null,
): Promise<RotationPreview> {
  const reg = routing.loadSets()
  // NOTE: `loadSets()` returns null for "keep current sets" (file absent/unreadable/empty) and
  // this line has always thrown on it — the preview endpoint reports that as an error.
  // Thrown rather than branched: adding a null path here would be a behaviour change.
  const cfg = defined(reg, "the sets registry").sets[setId]
  if (!cfg || cfg.source === "queue") {
    // `code` is read by the route handler; typed inline because this is a WRITE of a non-errno
    // marker, which `isNodeError` (a read-side narrowing guard) does not cover.
    const err: Error & { code?: string } = new Error(
      `'${setId}' is not a rotation channel`,
    )
    err.code = "not_rotation"
    throw err
  }
  const plexClient = client || liveClient()
  const binding = routing.bindingFor(
    cfg,
    profileTitle || "",
  )
  const behavior = cfg.behavior
  const out: RotationPreview = {
    set: setId,
    engine: "node",
    buckets: [],
    movie: null,
    movie_pool: [],
  }
  if (profileTitle) out.profile = profileTitle

  if (behavior !== "rewatch") {
    const raw = await rotation.channelBuckets(
      plexClient,
      cfg,
      binding,
    )
    out.buckets = formatBuckets(raw)
  }
  if (behavior !== "progress") {
    try {
      const tok = await plexClient.accountToken(
        binding.user_uuid,
      )
      const { counts, titles } = await select.rewatchCounts(
        plexClient,
        routing.rewatchSections(cfg),
        binding.movie_ratings,
        binding.watch_count_accounts,
        tok,
      )
      const excludes = new Set(
        (binding.movie_excludes || []).map(String),
      )
      await rotation.mergeManualMoviesIntoRewatch(
        plexClient,
        cfg,
        binding,
        counts,
        titles,
        excludes,
        cfg.weights || {},
      )
      const pool = [...counts.entries()]
        .filter(([rk]) => !excludes.has(String(rk)))
        .sort((left, right) => left[1] - right[1])
        .slice(0, 500)
        .map(([rk, value]) => ({
          ratingKey: rk,
          title: titles.get(rk) ?? null,
          count: value,
        }))
      out.movie_pool = pool
      out.movie = pickRewatch(counts, titles, excludes)
    } catch (error) {
      // Movie sample is best-effort, matching Python do_preview.
      console.log(
        `[engine] rewatch sample failed for ${setId}: ${errMessage(error)}`,
      )
    }
  }
  return out
}
