// In-process rotation preview for ENGINE=node (D3 follow-on #4). Mirrors
// queue_builder/service.do_preview's response shape so the Channels view can consume Node
// without a payload rewrite. Python still runs in dual-run soak for divergence logging.
import { liveClient } from './plex-live.js';
import * as routing from './routing.js';
import * as rotation from './rotation.js';
import * as select from './select.js';
import { toWeight } from './weight.js';
import { errMessage } from '../errors.js';
import type { Bucket, PlexClient, PoolItem } from '../types.js';

/** One formatted bucket — the MQTT/API preview shape `service.do_preview` publishes. */
export interface PreviewBucket {
  show: string;
  ratingKey: string;
  unwatched: number;
  weight: number;
  next: {
    ratingKey: string;
    title: string | undefined;
    season: number | null | undefined;
    episode: number | null | undefined;
    multiSeason: boolean;
  } | null;
  /** Only an item/library bucket (Shorts) lists its items; a show bucket sends null. */
  items: { ratingKey: string; title: string | undefined }[] | null;
}

/** One rewatch-pool row. */
export interface MoviePoolRow {
  ratingKey: string;
  title: string | null;
  count: number;
}

/**
 * `previewRotation()`'s payload — `service.do_preview`'s response shape.
 *
 * A type ALIAS, not an interface, so `routes/playbackRoutes.ts` can keep receiving it into a
 * `Record<string, unknown>` before bolting its `routing` block on.
 */
export type RotationPreview = {
  set: string;
  engine: 'node';
  buckets: PreviewBucket[];
  movie: { ratingKey: string; title: string | null } | null;
  movie_pool: MoviePoolRow[];
  /** Sent only when a profile was named, exactly as the JS added it conditionally. */
  profile?: string;
};

// Format channel_buckets into the MQTT/API preview bucket shape (service.do_preview).
export function formatBuckets(buckets: readonly Bucket[] | null | undefined): PreviewBucket[] {
  return (buckets || []).map((b) => {
    const eps: readonly PoolItem[] = b.episodes || [];
    const isLib = String(b.ratingKey).startsWith('section-');
    return {
      show: b.show,
      ratingKey: b.ratingKey,
      unwatched: eps.length,
      // Slots per round when the channel is randomized. Always sent (1 = normal) so the pool
      // tile can render its control without a second lookup into the set registry.
      weight: toWeight(b.weight),
      next: eps.length
        ? {
            // Guarded by `eps.length` on the line above.
            ratingKey: eps[0]!.ratingKey,
            title: eps[0]!.title,
            season: eps[0]!.season,
            episode: eps[0]!.episode,
            multiSeason: Boolean(b.multi_season),
          }
        : null,
      items: isLib
        ? [...eps]
            .map((e) => ({ ratingKey: e.ratingKey, title: e.title }))
            .sort((a, b) => String(a.title || '').toLowerCase().localeCompare(String(b.title || '').toLowerCase()))
        : null,
    };
  });
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
  show?: unknown;
  ratingKey?: unknown;
  unwatched?: unknown;
  items?: readonly { ratingKey?: unknown }[] | null;
  next?: { ratingKey?: unknown; season?: unknown; episode?: unknown } | null;
};

export function bucketsSignature(buckets: readonly SignatureBucket[] | null | undefined): string {
  return JSON.stringify(
    (buckets || []).map((b) => {
      const rk = String(b.ratingKey);
      const isLib = rk.startsWith('section-') || Array.isArray(b.items);
      const base = {
        show: b.show,
        ratingKey: rk,
        unwatched: b.unwatched,
        items: b.items ? b.items.map((i) => String(i.ratingKey)).sort() : null,
      };
      if (isLib) return base;
      return {
        ...base,
        next: b.next
          ? { ratingKey: String(b.next.ratingKey), season: b.next.season, episode: b.next.episode }
          : null,
      };
    }),
  );
}

export function moviePoolSignature(
  pool: readonly { ratingKey?: unknown; count?: unknown }[] | null | undefined,
): string {
  return JSON.stringify(
    (pool || []).map((m) => ({ ratingKey: String(m.ratingKey), count: m.count })),
  );
}

// Weighted 1/n² pick (Python pick_rewatch_movie). Uses Math.random — rng, not parity-gated.
function pickRewatch(
  counts: ReadonlyMap<string, number>,
  titles: ReadonlyMap<string, string | undefined>,
  excludes: ReadonlySet<string> = new Set<string>(),
): { ratingKey: string; title: string | null } | null {
  const candidates: [string, number][] = [];
  for (const [rk, n] of counts) {
    if (excludes.has(String(rk))) continue;
    if (n < 1) continue;
    candidates.push([rk, n]);
  }
  if (!candidates.length) return null;
  const weights = candidates.map(([, n]) => 1 / (n * n));
  let total = 0;
  for (const w of weights) total += w;
  let r = Math.random() * total;
  // The index reads below are all in-bounds by construction (`weights` is `candidates.map`, and
  // the last-element fallback runs only after the empty check above).
  for (let i = 0; i < candidates.length; i += 1) {
    r -= weights[i]!;
    if (r <= 0) {
      const rk = candidates[i]![0];
      return { ratingKey: rk, title: titles.get(rk) || null };
    }
  }
  const [rk] = candidates[candidates.length - 1]!;
  return { ratingKey: rk, title: titles.get(rk) || null };
}

/** Compute a rotation channel's preview with the live undici client. */
export async function previewRotation(
  setId: string,
  profileTitle = '',
  client: PlexClient | null = null,
): Promise<RotationPreview> {
  const reg = routing.loadSets();
  // NOTE: `loadSets()` returns null for "keep current sets" (file absent/unreadable/empty) and
  // this line has always thrown a TypeError on it — the preview endpoint reports that as a 500.
  // Asserted rather than branched: adding a null path here would be a behaviour change.
  const cfg = reg!.sets[setId];
  if (!cfg || cfg.source === 'queue') {
    // `code` is read by the route handler; typed inline because this is a WRITE of a non-errno
    // marker, which `isNodeError` (a read-side narrowing guard) does not cover.
    const err: Error & { code?: string } = new Error(`'${setId}' is not a rotation channel`);
    err.code = 'not_rotation';
    throw err;
  }
  const c = client || liveClient();
  const binding = routing.bindingFor(cfg, profileTitle || '');
  const behavior = cfg.behavior;
  const out: RotationPreview = {
    set: setId,
    engine: 'node',
    buckets: [],
    movie: null,
    movie_pool: [],
  };
  if (profileTitle) out.profile = profileTitle;

  if (behavior !== 'rewatch') {
    const raw = await rotation.channelBuckets(c, cfg, binding);
    out.buckets = formatBuckets(raw);
  }
  if (behavior !== 'progress') {
    try {
      const tok = await c.accountToken(binding.user_uuid);
      const { counts, titles } = await select.rewatchCounts(
        c,
        routing.rewatchSections(cfg),
        binding.movie_ratings,
        binding.watch_count_accounts,
        tok,
      );
      const excludes = new Set((binding.movie_excludes || []).map(String));
      const pool = [...counts.entries()]
        .filter(([rk]) => !excludes.has(String(rk)))
        .sort((a, b) => a[1] - b[1])
        .slice(0, 500)
        .map(([rk, n]) => ({ ratingKey: rk, title: titles.get(rk) ?? null, count: n }));
      out.movie_pool = pool;
      out.movie = pickRewatch(counts, titles, excludes);
    } catch (e) {
      // Movie sample is best-effort, matching Python do_preview.
      console.log(`[engine] rewatch sample failed for ${setId}: ${errMessage(e)}`);
    }
  }
  return out;
}
