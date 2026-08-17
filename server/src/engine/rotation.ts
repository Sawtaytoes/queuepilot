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
import type { EntryDescriptor } from './resolve.js';
import { weightedInterleave } from './weight.js';
import type { Rng } from './weight.js';
import { WATCH_COUNT_ACCOUNTS, ROTATION_LENGTH, ROTATION_LENGTH_MAX } from '../env.js';
import type { Bucket, EngineBinding, MemberValue, PlexClient, PoolItem } from '../types.js';

/**
 * The cfg slice the rotation wiring reads. `unwatchedBuckets` and `resolveMember` each declare
 * their own (wider) slice; this one only adds `members:`, so a `RoutingRotationCfg` fits all three.
 */
type RotationCfg = Parameters<typeof unwatchedBuckets>[1]
  & Parameters<typeof resolveMember>[2]
  & { members?: readonly MemberValue[] | null };

// Watched ratingKeys across the binding's WHOLE history (no section filter) — members resolve by
// ratingKey GLOBALLY (one may live outside the channel's sections), so member watched-state must
// scan all history too, unlike the rule pool's section-scoped watchedForSet. Port of _watched_all.
export async function watchedAll(
  client: PlexClient,
  binding: EngineBinding | null | undefined,
): Promise<Set<string>> {
  const accts = (binding && binding.watch_count_accounts) || WATCH_COUNT_ACCOUNTS;
  const watched = new Set<string>();
  for (const acct of accts) {
    for await (const row of iterHistory(client, acct)) {
      if (row.ratingKey != null) watched.add(String(row.ratingKey));
    }
  }
  return watched;
}

// A rotation channel's `members:` list as resolution descriptors. Port of member_descs.
export function memberDescs(cfg: { members?: readonly MemberValue[] | null }): EntryDescriptor[] {
  const out: EntryDescriptor[] = [];
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
export async function memberBuckets(
  client: PlexClient,
  cfg: RotationCfg,
  binding: EngineBinding,
): Promise<Bucket[]> {
  const tok = await client.accountToken(binding.user_uuid);
  const watched = await watchedAll(client, binding);
  const buckets: Bucket[] = [];
  for (const desc of memberDescs(cfg)) {
    const res = await resolveMember(client, desc, cfg, watched, tok);
    if (!res || !res.items.length) continue;
    buckets.push({
      show: res.title,
      ratingKey: res.ratingKey || res.title,
      // The curated resolver's items are `PoolItem`s plus a `member_key` tag (and a `show` that
      // may be null on a movie member); the bucket carries them through untouched.
      episodes: res.items as PoolItem[],
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
export async function channelBuckets(
  client: PlexClient,
  cfg: RotationCfg,
  binding: EngineBinding,
  rng: Rng | null = null,
): Promise<Bucket[]> {
  const rule = await unwatchedBuckets(client, cfg, binding, rng);
  if (!cfg.members || !cfg.members.length) return rule;
  const members = await memberBuckets(client, cfg, binding);
  const seen = new Set(members.map((b) => String(b.ratingKey)));
  return members.concat(rule.filter((b) => !seen.has(String(b.ratingKey))));
}

/**
 * How many items this channel's lineup holds: the set's `length:`, else env ROTATION_LENGTH.
 *
 * Deliberately TOLERANT, like `max_items` in the routing loader: a blank, zero, negative or
 * non-numeric `length:` falls back to the env default instead of throwing. A channel that
 * refuses to build is a dead card on the wall, and the failure mode this guards is a typo in
 * a hand-edited YAML — the same reason `QUEUE_SERIES_LENGTH` clamps `episodes:`.
 *
 * There is no "infinite" sentinel here YET. `docs/todos/batch-all-or-infinite.md` (parked
 * 2026-08-16) already settled how one must look when it lands — a NAMED value (`all`), never
 * `0` and never `999`, because a falsy batch already reads as *uncapped* in resolve.ts's
 * applyBatch and a typo would become a binge. Infinite also needs the top-up loop to mean
 * anything, since a fixed playQueue cannot be infinite. Until both exist, a number is the
 * only accepted form and anything else quietly means "the default".
 */
export function rotationLength(cfg: { length?: string } | null | undefined): number {
  const n = parseInt(String(cfg?.length ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return ROTATION_LENGTH;
  // Clamped HERE as well as in sets.ts's writer, not only there: these files are hand-edited
  // over SMB as often as they are saved through the UI, so the engine cannot assume the
  // writer's ceiling was ever applied.
  return Math.min(n, ROTATION_LENGTH_MAX);
}

// Interleave next-unwatched episodes ACROSS shows (round-robin), TV-style: show A ep1, show B ep1,
// …, show A ep2, … — so no two consecutive items are the same show (unless one show is all that's
// left). `rng` shuffles which show leads each session; omit it for a stable order. Port of
// build_rotation. (The shuffle is rng, so this is covered by a seeded per-language test, not the
// cross-language parity gate — which compares channelBuckets, the pre-shuffle pool.)
export async function buildRotation(
  client: PlexClient,
  cfg: RotationCfg,
  binding: EngineBinding,
  length: number = ROTATION_LENGTH,
  // `Rng | null`, not the inferred `null`: an untyped `rng = null` would REJECT a real rng at
  // every call site. The seam has already cost one production bug (2026-08-14: nextQueue was
  // never handed one, so curated channels played in file order) — this only fixes the type.
  rng: Rng | null = null,
): Promise<PoolItem[]> {
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
