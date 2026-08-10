// In-process rotation preview for ENGINE=node (D3 follow-on #4). Mirrors
// queue_builder/service.do_preview's response shape so the Channels view can consume Node
// without a payload rewrite. Python still runs in dual-run soak for divergence logging.
import { liveClient } from './plex-live.js';
import * as routing from './routing.js';
import * as rotation from './rotation.js';
import * as select from './select.js';

// Format channel_buckets into the MQTT/API preview bucket shape (service.do_preview).
export function formatBuckets(buckets) {
  return (buckets || []).map((b) => {
    const eps = b.episodes || [];
    const isLib = String(b.ratingKey).startsWith('section-');
    return {
      show: b.show,
      ratingKey: b.ratingKey,
      unwatched: eps.length,
      next: eps.length
        ? {
            ratingKey: eps[0].ratingKey,
            title: eps[0].title,
            season: eps[0].season,
            episode: eps[0].episode,
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
export function bucketsSignature(buckets) {
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

export function moviePoolSignature(pool) {
  return JSON.stringify(
    (pool || []).map((m) => ({ ratingKey: String(m.ratingKey), count: m.count })),
  );
}

// Weighted 1/n² pick (Python pick_rewatch_movie). Uses Math.random — rng, not parity-gated.
function pickRewatch(counts, titles, excludes = new Set()) {
  const candidates = [];
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
  for (let i = 0; i < candidates.length; i += 1) {
    r -= weights[i];
    if (r <= 0) {
      const rk = candidates[i][0];
      return { ratingKey: rk, title: titles.get(rk) || null };
    }
  }
  const [rk] = candidates[candidates.length - 1];
  return { ratingKey: rk, title: titles.get(rk) || null };
}

/**
 * Compute a rotation channel's preview with the live undici client.
 * @returns {{ set, profile?, buckets, movie, movie_pool, engine: 'node' }}
 */
export async function previewRotation(setId, profileTitle = '', client = null) {
  const reg = routing.loadSets();
  const cfg = reg.sets[setId];
  if (!cfg || cfg.source === 'queue') {
    const err = new Error(`'${setId}' is not a rotation channel`);
    err.code = 'not_rotation';
    throw err;
  }
  const c = client || liveClient();
  const binding = routing.bindingFor(cfg, profileTitle || '');
  const behavior = cfg.behavior;
  const out = {
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
      console.log(`[engine] rewatch sample failed for ${setId}: ${e.message}`);
    }
  }
  return out;
}
