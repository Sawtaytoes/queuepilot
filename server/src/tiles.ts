// The ONE tile resolver, shared by /api/queues and /api/sets/:id/members (B4.4).
//
// Both endpoints took a raw queue/member value and resolved it to a poster tile — the same
// resolveValue → nextEpisode/collectionNext → tile-object dance, duplicated, each re-running
// the same Plex fan-out. The Channels view renders BOTH at once (its member grid alongside the
// preview), so the duplication was live, not theoretical. This is that logic, once. The
// per-endpoint differences (a queue item's `key`/`episodes`/`done`, a member's `index`) stay
// in the endpoints; the shared part — identity, type, poster, next-up — is here.
//
// The single-flight that makes N tiles asking for the same collection cost one HTTP call lives
// in plex.plexGet, so it covers every caller automatically; this module just has to not
// defeat it (it doesn't — it awaits the shared plex functions directly).
import * as plex from './plex.js';
import type { AccountScope, CollectionNextEp, ResolvedItem, SectionIds } from './plex.js';
import type { NextEp, Start, Tile } from './types.js';

/**
 * What `resolveTile()` actually returns: `types.ts`'s `Tile`, widened in exactly four spots
 * where the shared declaration is stricter than the runtime value. Every divergence is a
 * REPORT, not a fix — narrowing any of them would mean coercing a value the resolver has
 * never produced:
 *
 *   * `title` / `type` — a resolved item's `title`/`type` come straight off the Plex wire,
 *     where both are optional. In practice every producer filters on `type` first, so these
 *     are `undefined` only for a response Plex has never sent.
 *   * `year` — a COLLECTION has none, so the key is genuinely absent (not null) on a
 *     collection tile. `Tile` declares `number | null`.
 *   * `nextEp` — `collectionNext()` returns `CollectionNextEp`, which sets `startMember` to
 *     `null` where `NextEp` declares `startMember?: string`.
 */
export interface ResolvedTile extends Omit<Tile, 'title' | 'type' | 'year' | 'nextEp'> {
  title: string | undefined;
  type: string | null | undefined;
  year: number | null | undefined;
  nextEp: NextEp | CollectionNextEp | null;
}

function displayFor(value: unknown): string {
  if (value && typeof value === 'object') {
    // `title` is asserted to be a string rather than stringified: a YAML `title: 2012` is a
    // NUMBER at runtime and this function has always returned it unchanged. Wrapping it in
    // `String()` would be a (small) wire change, so the assertion carries the existing lie.
    const o = value as { title?: string; ratingKey?: string | number };
    return o.title || `ratingKey ${o.ratingKey}`;
  }
  return String(value);
}

// Resolve one raw value to the fields a poster tile needs. `sections` scopes a title lookup;
// `start` is the manual start floor ({season,episode} for a show, {series,season,episode} for
// a collection). Returns the COMMON tile fields; the caller adds key/index/episodes/done.
export async function resolveTile(
  sections: SectionIds,
  value: unknown,
  start: Start | null = null,
  opts: AccountScope = {},
): Promise<ResolvedTile> {
  let resolved: ResolvedItem | null = null;
  try {
    resolved = await plex.resolveValue(sections, value);
  } catch {
    /* leave unresolved */
  }

  // `opts` ({token, account}) scopes the next-up "watched" state to a Plex Home profile for a
  // per-profile channel's member tiles; empty for queues/admin (Bob's view), unchanged.
  let nextEp: NextEp | CollectionNextEp | null = null;
  // A null `nextEp` means two different things — "nothing left to play" and "the lookup
  // failed" — and the tile says something different for each ("All watched" vs the neutral
  // "N in order"), so the failure is recorded rather than collapsed into the same null.
  let isNextEpFailed = false;
  if (resolved && resolved.type === 'show') {
    try {
      nextEp = await plex.nextEpisode(resolved.ratingKey, start, opts);
    } catch {
      isNextEpFailed = true;
    }
  } else if (resolved && resolved.type === 'collection') {
    try {
      nextEp = await plex.collectionNext(resolved.ratingKey, start, opts);
    } catch {
      isNextEpFailed = true;
    }
  }

  // "In Progress" = the item is mid-playback at a resume point (a Plex viewOffset) and NOT
  // watched — the exact state the engine's resume_offset picks up. Per-EPISODE, not
  // "partway through a series": a MOVIE reads its own viewOffset; a SHOW/COLLECTION reads it
  // off the next-up leaf (nextEpisode/collectionNext). It must win over a stale "Completed".
  // The in-progress leaf/movie's own resume point + runtime (ms), so the tile's "In Progress"
  // badge can say how far in and how long. A MOVIE reads its own; a SHOW/COLLECTION reads it
  // off the next-up leaf (nextEpisode/collectionNext), matching partiallyWatched's source.
  let partiallyWatched = false;
  let viewOffset = 0;
  let duration = 0;
  if (resolved && resolved.type === 'movie') {
    viewOffset = Number(resolved.viewOffset) || 0;
    duration = Number(resolved.duration) || 0;
    partiallyWatched = viewOffset > 0 && !(Number(resolved.viewCount) > 0);
  } else if (nextEp && nextEp.partiallyWatched) {
    partiallyWatched = true;
    viewOffset = Number(nextEp.viewOffset) || 0;
    duration = Number(nextEp.duration) || 0;
  }

  return {
    resolved: Boolean(resolved),
    ratingKey: resolved ? resolved.ratingKey : null,
    type: resolved ? resolved.type : null,
    title: resolved ? resolved.title : displayFor(value),
    year: resolved ? resolved.year : null,
    // The edition, carried the last layer to the wire. `posterFields()` has always set it on
    // a resolved movie/show and this function dropped it, so the search rows named the
    // edition (#153) and the tile the pick WROTE went back to being one of two identical
    // captions. A COLLECTION has no edition, and the union is discriminated on `type`, so the
    // narrowing is the check rather than a cast.
    editionTitle: resolved && resolved.type !== 'collection' ? resolved.editionTitle : null,
    childCount: resolved && resolved.type === 'collection' ? resolved.childCount : null,
    nextEp,
    isNextEpFailed,
    partiallyWatched,
    viewOffset,
    duration,
  };
}

export { displayFor };
