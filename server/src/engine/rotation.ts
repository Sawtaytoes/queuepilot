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
import {
  collectionChildren, findCollection, iterHistory, unwatchedBuckets,
} from './select.js';
import { setSections } from './routing.js';
import { describe, resolveMember } from './resolve.js';
import type { EntryDescriptor } from './resolve.js';
import { weightedInterleave } from './weight.js';
import type { Rng } from './weight.js';
import { WATCH_COUNT_ACCOUNTS, ROTATION_LENGTH, ROTATION_LENGTH_MAX } from '../env.js';
import type {
  Bucket, EngineBinding, MemberValue, PlexClient, PlexMetadata, PoolItem,
} from '../types.js';

/**
 * The cfg slice the rotation wiring reads. `unwatchedBuckets` and `resolveMember` each declare
 * their own (wider) slice; this one only adds `members:`, so a `RoutingRotationCfg` fits all three.
 */
type RotationCfg = Parameters<typeof unwatchedBuckets>[1]
  & Parameters<typeof resolveMember>[2]
  & {
    members?: readonly MemberValue[] | null;
    /** `'whole'` (default) | `'split'` — see `isSplittingCollections`. */
    collection_members?: unknown;
  };

/**
 * Does this pool want a collection member SPLIT back into its individual shows?
 *
 * `whole` (the default, and absent reads as it): the collection is one member and plays
 * through in its own order. `split`: each of its children becomes its own member, rotating
 * independently — which is what the rule pool would have given you anyway.
 *
 * Anything unrecognised reads as `whole`, matching how `batchStop`/`toOnComplete` treat a
 * typo: fall back to the intended default rather than to the other behaviour.
 */
function isSplittingCollections(cfg: RotationCfg): boolean {
  return String(cfg.collection_members ?? '').trim().toLowerCase() === 'split';
}

/**
 * Every ratingKey COVERED by a `Collection:` member — the collection's own children.
 *
 * This is what stops a collection from being listed twice. `channelBuckets` deduped members
 * against the rule pool by BUCKET ratingKey, and a collection's bucket key is the
 * collection's, which never equals a child show's — so adding "Batman: The Animated Series"
 * as a member left Batman: The Animated Series ALSO sitting in the eligible pool as a
 * standalone show, free to be picked mid-run and out of order (owner, 2026-08-17).
 *
 * Deliberately the same shape as `select.expandedBlocklist`, which has always expanded a
 * `Collection: <name>` entry to its children's ratingKeys for exactly the same reason: at the
 * pool level a collection IS its members.
 */
async function collectionCover(
  client: PlexClient,
  cfg: RotationCfg,
  token: string | null | undefined,
): Promise<Set<string>> {
  const covered = new Set<string>();
  for (const desc of memberDescs(cfg)) {
    if (!desc.collection) continue;
    for (const ch of await collectionChildrenOf(client, cfg, desc.collection, token)) {
      covered.add(String(ch.ratingKey));
    }
  }
  return covered;
}

/**
 * The ordered children of the `Collection: <name>` member `name`, searched across the pool's
 * own sections ([] when it resolves nowhere). The collection's own `collectionSort` order is
 * preserved — `collectionChildren` does no client-side re-sort — which is what makes the
 * whole-collection mode play "in order" in the first place.
 */
async function collectionChildrenOf(
  client: PlexClient,
  cfg: RotationCfg,
  name: string,
  token: string | null | undefined,
): Promise<PlexMetadata[]> {
  for (const sec of setSections(cfg) || []) {
    const crk = await findCollection(client, sec, name, token);
    // A collection lives in ONE section, so the first hit is the answer.
    if (crk) return collectionChildren(client, crk, token);
  }
  return [];
}

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
  const isSplitting = isSplittingCollections(cfg);
  const buckets: Bucket[] = [];
  for (const desc of memberDescs(cfg)) {
    // SPLIT: the collection stops being a member and its children become members instead —
    // one bucket each, resolved exactly as a hand-added show member would be, so each one
    // rotates on its own. `weight` rides down to every child: it was the collection's share
    // of a round, and after the split each child asks for that share.
    if (desc.collection && isSplitting) {
      for (const child of await collectionChildrenOf(client, cfg, desc.collection, tok)) {
        const childDesc = describe({
          ratingKey: String(child.ratingKey),
          title: child.title,
          weight: desc.weight,
        });
        const res = await resolveMember(client, childDesc, cfg, watched, tok);
        if (!res || !res.items.length) continue;
        buckets.push({
          show: res.title,
          ratingKey: res.ratingKey || res.title,
          episodes: res.items as PoolItem[],
          multi_season: res.multi_season || false,
          weight: res.weight,
        });
      }
      continue;
    }
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
  // A COLLECTION MEMBER COVERS ITS CHILDREN, in both modes.
  //
  // The dedupe above compares BUCKET ratingKeys, and a collection's bucket key is the
  // collection's own — it can never equal a child show's. So a collection member used to
  // leave every one of its shows sitting in the rule pool as well, and the pool played them
  // both ways at once: the collection in order, and the same shows again at random.
  //
  // `whole` is the mode that NEEDS this: the collection speaks for its children, so they
  // leave the rule pool and the collection's own order is the only order they play in.
  //
  // In `split` it is a belt-and-braces no-op for any child that resolved — that child is
  // already a member bucket keyed by its own ratingKey, so `seen` caught it. Applying the
  // cover in both modes anyway keeps ONE rule to state and to test ("a collection member
  // covers its children") instead of a rule with a mode-shaped exception.
  const tok = await client.accountToken(binding.user_uuid);
  for (const rk of await collectionCover(client, cfg, tok)) seen.add(rk);
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
