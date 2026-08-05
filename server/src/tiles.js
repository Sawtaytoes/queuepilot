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
export async function resolveTile(sections, value, start = null) {
  let resolved = null;
  try {
    resolved = await plex.resolveValue(sections, value);
  } catch {
    /* leave unresolved */
  }

  let nextEp = null;
  if (resolved && resolved.type === 'show') {
    try {
      nextEp = await plex.nextEpisode(resolved.ratingKey, start);
    } catch {
      /* ignore */
    }
  } else if (resolved && resolved.type === 'collection') {
    try {
      nextEp = await plex.collectionNext(resolved.ratingKey, start);
    } catch {
      /* ignore — the tile falls back to the childCount "N in order" label */
    }
  }

  return {
    resolved: Boolean(resolved),
    ratingKey: resolved ? resolved.ratingKey : null,
    type: resolved ? resolved.type : null,
    title: resolved ? resolved.title : displayFor(value),
    year: resolved ? resolved.year : null,
    childCount: resolved && resolved.type === 'collection' ? resolved.childCount : null,
    nextEp,
  };
}

export { displayFor };
