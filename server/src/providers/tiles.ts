// Poster tiles for a PULL set — the provider-side counterpart of ../tiles.ts.
//
// ../tiles.ts is "the ONE tile resolver", and it resolves every entry through PLEX. A reading
// queue's entries store the provider's own item ids (a Kavita seriesId), so that resolver
// answers `resolved: false, ratingKey: null` for all of them: a grid of bare titles with no
// artwork and no next-up. It is not a Plex outage and it does not look like one — it looks
// like the queue is fine and the art is missing, which is how it survived a live review.
//
// Same OUTPUT contract as tiles.resolveTile (the common tile fields; the caller adds
// key/index/episodes/done), plus two fields only a non-Plex provider sets:
//
//   cover — the /api/providers/:id/cover/:itemId URL, because /api/thumb is Plex's proxy and
//           answers 502 for an id Plex has never heard of.
//   unit  — 'chapter', so the tile's next-up line reads "Ch 113" rather than "E113" and a
//           finished series reads "All read" rather than "All watched".
import { errMessage } from '../errors.js';
import type { MediaUnit, NextEp } from '../types.js';
import * as blocks from './blocks.js';
import { coverUrl, providerFor } from './index.js';

/**
 * What this module needs off a set: an id for the log line, plus whatever `blocks.js` reads
 * to derive the provider. A type ALIAS and not an interface, deliberately — `BlockSourceCfg`
 * has an index signature, and only an anonymous/aliased object type gets the implicit one
 * that makes it assignable (the same rule the `{ ...s }` spreads elsewhere work around).
 */
export type TileSetSource = {
  id: string;
  providers?: unknown;
  requires_profile?: string | null;
  sections?: unknown;
};

/**
 * One tile as a PULL provider answers it.
 *
 * Deliberately NOT `Tile` from types.ts: that shape is what `tiles.resolveTile()` returns and
 * it carries `isNextEpFailed`, which has no meaning here (a provider round-trip that fails
 * degrades the WHOLE set to unresolved tiles rather than one entry's next-up). `cover` and
 * `unit` are the two fields the Plex shape has no equivalent of; both are optional on the
 * frontend's `QueueItem`, which is what lets one component render either.
 */
export interface ProviderTile {
  resolved: boolean;
  ratingKey: string | null;
  cover: string | null;
  type: string | null;
  title: string;
  year: number | null;
  childCount: number | null;
  nextEp: NextEp | null;
  partiallyWatched: boolean;
  viewOffset: number;
  duration: number;
  unit?: MediaUnit;
}

/** The provider item id an entry names, or null for a value that carries none. */
function idOf(value: unknown): string | null {
  if (value && typeof value === 'object') {
    const o = value as { ratingKey?: string | number };
    if (o.ratingKey != null) return String(o.ratingKey);
  }
  return null;
}

function displayFor(value: unknown): string {
  if (value && typeof value === 'object') {
    // Same assertion (and same latent lie) as `tiles.ts displayFor()`: a YAML `title: 2012`
    // is a NUMBER at runtime and has always been returned unchanged.
    const o = value as { title?: string; ratingKey?: string | number };
    return o.title || `item ${o.ratingKey}`;
  }
  return String(value);
}

/** The tile a value gets when nothing could resolve it — its stored title, and no art. */
function unresolvedTile(value: unknown): ProviderTile {
  return {
    resolved: false,
    ratingKey: null,
    cover: null,
    type: null,
    title: displayFor(value),
    year: null,
    childCount: null,
    nextEp: null,
    partiallyWatched: false,
    viewOffset: 0,
    duration: 0,
  };
}

/**
 * Resolve one pull set's stored values to tiles, index-aligned with `values`.
 *
 * Never throws: a set whose provider is unconfigured, unknown or MIXED degrades to unresolved
 * tiles for that set alone. /api/queues answers for every queue at once, so throwing here
 * would blank the whole page over one bad set — and `resolveSingle` throwing on a mixed set is
 * deliberate (decision 2026-08-13-a-queue-draws-from-exactly-one-provider), so it is a case
 * this must handle rather than a case that cannot happen.
 */
export async function resolveTiles(
  set: TileSetSource,
  values: readonly unknown[],
): Promise<ProviderTile[]> {
  if (!values.length) return [];

  let block;
  let provider;
  try {
    block = blocks.resolveSingle(set);
    provider = providerFor(block.provider);
  } catch (e) {
    console.log(`[providers] tiles for set '${set.id}': ${errMessage(e)}`);
    return values.map(unresolvedTile);
  }
  if (typeof provider.tiles !== 'function') return values.map(unresolvedTile);

  const ids = values.map(idOf);
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  let rows = [];
  try {
    rows = await provider.tiles(wanted);
  } catch (e) {
    console.log(`[providers] tiles for set '${set.id}': ${errMessage(e)}`);
    return values.map(unresolvedTile);
  }
  const byId = new Map<string, NonNullable<(typeof rows)[number]>>();
  wanted.forEach((id, i) => { const r = rows[i]; if (r) byId.set(id, r); });

  return values.map((value, i) => {
    // Hoisted out of upstream's `ids[i] == null ? null : byId.get(ids[i])` only because
    // `noUncheckedIndexedAccess` cannot see that the second read is the same element.
    const id = ids[i];
    const row = id == null ? null : byId.get(id);
    if (!row) return unresolvedTile(value);
    const next = row.next || null;
    return {
      resolved: true,
      ratingKey: String(row.id),
      cover: coverUrl(block.provider, row.id),
      // 'show' is the tile shape a series wants — a title line plus a "what's next" line —
      // and the frontend already renders it. A reading-only entry type would need a second
      // render path for no behavioural difference; `unit` carries the wording instead.
      type: 'show',
      unit: provider.unit || 'episode',
      title: row.title || displayFor(value),
      year: null,
      childCount: null,
      nextEp: next
        ? {
          title: next.title ?? null,
          // Chapters have no season, and `multiSeason: false` is what drops the "S1" that a
          // chapter must never wear.
          episode: Number(next.number) || null,
          season: null,
          multiSeason: false,
        }
        : null,
      // A part-read chapter is the reading analogue of a Plex viewOffset, and the badge it
      // drives says so. `viewOffset`/`duration` stay 0: they are MILLISECONDS, and pages are
      // not a runtime — the badge's tooltip correctly says nothing rather than "0:00 of 0:00".
      partiallyWatched: Boolean(next && (next.pagesRead ?? 0) > 0),
      viewOffset: 0,
      duration: 0,
    };
  });
}
