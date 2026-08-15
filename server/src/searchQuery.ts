// What the search box does with a year the user typed.
//
// `Tekkaman Blade (1992)` returned ZERO results, while `Tekkaman Blade` returned two. That is
// not an obscure input: `Title (Year)` is the app's OWN entry format — `parseTitleString()`
// (plex.ts) parses exactly this shape off `queues.yaml`, and the tile under the search box
// renders `Tekkaman Blade (1992)`. So the user was typing back the string the app had just
// shown him, into a box that fed it verbatim to Plex's `?title=` substring match, where no
// title contains a parenthesised year.
//
// The year is therefore not noise to be discarded — it is the DISAMBIGUATOR, and it is
// wanted precisely when a bare title is ambiguous. `Tekkaman Blade` ranks
// `Tekkaman Blade II` FIRST (Plex's own order), so throwing the year away would have left
// the right answer in second place on the very query that named it.
//
// Hence: strip for MATCHING, keep for RANKING, and never drop a hit. A year that matches
// nothing (a typo, or a provider that carries no year at all — Kavita's series search
// returns none) must degrade to the bare-title result, not to an empty list. An empty list
// reads as "you don't own this", which is the failure being fixed.
import { parseTitleString } from './plex.js';

/** A search box's text, split into what to match on and what to rank by. */
export interface ParsedSearchQuery {
  /** The text to send to the provider. Never empty when the input was non-empty. */
  text: string;
  /** The year the user typed, or null. Ranking only — never a filter. */
  year: number | null;
}

/**
 * Split a raw search string into `{ text, year }`.
 *
 * Deliberately `parseTitleString()` rather than a second regex: the search box and
 * `queues.yaml` must agree on what `Title (Year) [guid]` means, or pasting an entry back
 * into the box finds nothing. Reusing it also means a pasted `[anidb-16172]` suffix is
 * dropped for free.
 */
export function parseSearchQuery(raw: unknown): ParsedSearchQuery {
  const q = String(raw ?? '').trim();
  if (!q) return { text: '', year: null };
  const { title, year } = parseTitleString(q);
  // A query that is NOTHING but a year (`(1992)`) leaves no title to match on. Searching the
  // empty string would return the whole library, so the original text stands and the year is
  // dropped — a useless search beats a 500-row one.
  if (!title) return { text: q, year: null };
  return { text: title, year };
}

/**
 * Move the hits whose year matches to the front. STABLE, and never removes anything.
 *
 * Filtering would be the wrong shape twice over: a provider that carries no year would
 * return nothing at all, and a year that is one off in Plex's metadata would hide the item
 * the user is looking straight at.
 */
export function rankByYear<T extends { year?: number | null }>(
  hits: readonly T[],
  year: number | null,
): T[] {
  if (year == null) return [...hits];
  const matched: T[] = [];
  const rest: T[] = [];
  for (const h of hits) (h.year === year ? matched : rest).push(h);
  return [...matched, ...rest];
}
