// D3 of the Python → Node port (follow-on #3): the ROTATION wiring, ported from
// queue_builder/plex.py. It combines the dynamic rule pool (select.js unwatchedBuckets) with a
// channel's explicit `members:` list (resolved through resolve.js resolveMember) into ONE pool,
// then interleaves it TV-style.
//
// Ported here: _watched_all, member_descs, member_buckets, channel_buckets, build_rotation.
// Live undici adapter + ENGINE=node preview seam consume this (follow-on #4). The
// deterministic part — the combined bucket pool (channel_buckets) — is parity-gated; build_rotation
// shuffles+round-robins via an injected rng (like next_queue's anime branch), so its interleave
// stays a per-language seeded test, not a cross-language byte-compare.
import { iterHistory, unwatchedBuckets } from './select.js';
import { describe, resolveMember } from './resolve.js';
import { weightedInterleave } from './weight.js';
import { WATCH_COUNT_ACCOUNTS, ROTATION_LENGTH } from '../env.js';

// Watched ratingKeys across the binding's WHOLE history (no section filter) — members resolve by
// ratingKey GLOBALLY (one may live outside the channel's sections), so member watched-state must
// scan all history too, unlike the rule pool's section-scoped watchedForSet. Port of _watched_all.
export async function watchedAll(client, binding) {
  const accts = (binding && binding.watch_count_accounts) || WATCH_COUNT_ACCOUNTS;
  const watched = new Set();
  for (const acct of accts) {
    for await (const row of iterHistory(client, acct)) {
      if (row.ratingKey != null) watched.add(String(row.ratingKey));
    }
  }
  return watched;
}

// A rotation channel's `members:` list as resolution descriptors. Port of member_descs.
export function memberDescs(cfg) {
  const out = [];
  for (const m of cfg.members || []) {
    const desc = describe(m);
    if (desc.key != null) out.push(desc);
  }
  return out;
}

// Buckets for a channel's explicit `members:` list, shaped like unwatchedBuckets. Each member
// becomes ONE bucket (show -> its next unwatched batch, collection -> unwatched children,
// movie/short -> itself once). An unresolved/finished member contributes no bucket — a CHANNEL
// never marks members done. Port of member_buckets.
export async function memberBuckets(client, cfg, binding) {
  const tok = await client.accountToken(binding.user_uuid);
  const watched = await watchedAll(client, binding);
  const buckets = [];
  for (const desc of memberDescs(cfg)) {
    const res = await resolveMember(client, desc, cfg, watched, tok);
    if (!res || !res.items.length) continue;
    buckets.push({
      show: res.title,
      ratingKey: res.ratingKey || res.title,
      episodes: res.items,
      multi_season: res.multi_season || false,
      // The member's own `weight:` — how many slots per round it takes in buildRotation. A
      // rule-pool show gets the same thing from the channel's `weights:` map (select.js).
      weight: res.weight,
    });
  }
  return buckets;
}

// A rotation channel's pool: the dynamic rule PLUS its explicit `members:` (additive includes —
// members play ON TOP of the rule pool). Deduped by ratingKey (members win) so a member that also
// matches the rule isn't queued twice. Port of channel_buckets.
export async function channelBuckets(client, cfg, binding, rng = null) {
  const rule = await unwatchedBuckets(client, cfg, binding, rng);
  if (!cfg.members || !cfg.members.length) return rule;
  const members = await memberBuckets(client, cfg, binding);
  const seen = new Set(members.map((b) => String(b.ratingKey)));
  return members.concat(rule.filter((b) => !seen.has(String(b.ratingKey))));
}

// Interleave next-unwatched episodes ACROSS shows (round-robin), TV-style: show A ep1, show B ep1,
// …, show A ep2, … — so no two consecutive items are the same show (unless one show is all that's
// left). `rng` shuffles which show leads each session; omit it for a stable order. Port of
// build_rotation. (The shuffle is rng, so this is covered by a seeded per-language test, not the
// cross-language parity gate — which compares channelBuckets, the pre-shuffle pool.)
export async function buildRotation(client, cfg, binding, length = ROTATION_LENGTH, rng = null) {
  const shows = await channelBuckets(client, cfg, binding, rng);
  if (!shows.length) return [];
  const order = shows.slice();
  if (rng) rng.shuffle(order);
  // WEIGHTS ride on top of the shuffle, not instead of it: the shuffle still decides who leads
  // tonight, then the interleave decides how many slots each one takes. weightedInterleave is
  // the plain round-robin above when every weight is 1 — same walk of `order`, same output —
  // so an unweighted channel is bit-for-bit unchanged. See engine/weight.js.
  return weightedInterleave(order, (s) => s.episodes, length);
}
