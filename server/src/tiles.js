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

function displayFor(value) {
  if (value && typeof value === 'object') return value.title || `ratingKey ${value.ratingKey}`;
  return String(value);
}

// Resolve one raw value to the fields a poster tile needs. `sections` scopes a title lookup;
// `start` is the manual start floor ({season,episode} for a show, {series,season,episode} for
// a collection). Returns the COMMON tile fields; the caller adds key/index/episodes/done.
export async function resolveTile(sections, value, start = null, opts = {}) {
  let resolved = null;
  try {
    resolved = await plex.resolveValue(sections, value);
  } catch {
    /* leave unresolved */
  }

  // `opts` ({token, account}) scopes the next-up "watched" state to a Plex Home profile for a
  // per-profile channel's member tiles; empty for queues/admin (Bob's view), unchanged.
  let nextEp = null;
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
    childCount: resolved && resolved.type === 'collection' ? resolved.childCount : null,
    nextEp,
    isNextEpFailed,
    partiallyWatched,
    viewOffset,
    duration,
  };
}

export { displayFor };
