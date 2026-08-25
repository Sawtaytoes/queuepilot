import type { InteractionType } from '../types.js';

/**
 * Enrichment from `api.geekdo.com/api/geekitems`.
 *
 * This is **not** the XML API. That one has required a bearer token since 2025-07-02 and
 * answers `401`, and the HTML pages are behind a Cloudflare challenge that a browser passes
 * once and then fails. The site's own JSON API, on the other hand, answers a plain
 * unauthenticated `GET` — and it carries the two things the collection CSV export does not
 * have: **box art** and **mechanics/categories**.
 *
 * It is still someone else's server. One request per second, and every response is cached to
 * disk so a re-run costs nothing.
 */

const ENDPOINT = 'https://api.geekdo.com/api/geekitems';

export interface GeekdoVersionLink {
  id: number;
  name: string;
}

export interface GeekdoItem {
  name: string;
  /** Full-size, uncropped box art. */
  imageUrl: string | null;
  mechanics: string[];
  categories: string[];
  publishers: string[];
  minPlayers: number | null;
  maxPlayers: number | null;
  minAge: number | null;
  minPlaytime: number | null;
  maxPlaytime: number | null;
  yearPublished: number | null;
  /** Editions of this title. Names match the CSV `version_nickname`. */
  versions: GeekdoVersionLink[];
}

interface RawLink {
  name?: unknown;
}

const names = (links: unknown, key: string): string[] => {
  if (typeof links !== 'object' || links === null) return [];
  const list = (links as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];

  return list
    .map((link: RawLink) => (typeof link.name === 'string' ? link.name : null))
    .filter((name): name is string => name !== null);
};

const numberOrNull = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const parseGeekdoItem = (payload: unknown): GeekdoItem | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const item = (payload as Record<string, unknown>).item;
  if (typeof item !== 'object' || item === null) return null;

  const record = item as Record<string, unknown>;
  const images = record.images;

  const imageUrl =
    typeof images === 'object' && images !== null
      ? // `original` is the uncropped scan. Every other variant in this payload is a thumbor
        // crop — `opengraph` in particular slices a horizontal band out of the middle and
        // loses the title off the top of the box.
        (((images as Record<string, unknown>).original as string | undefined) ?? null)
      : null;

  return {
    name: typeof record.name === 'string' ? record.name : '',
    imageUrl: imageUrl ?? null,
    mechanics: names(record.links, 'boardgamemechanic'),
    categories: names(record.links, 'boardgamecategory'),
    publishers: names(record.links, 'boardgamepublisher'),
    minPlayers: numberOrNull(record.minplayers),
    maxPlayers: numberOrNull(record.maxplayers),
    minAge: numberOrNull(record.minage),
    minPlaytime: numberOrNull(record.minplaytime),
    maxPlaytime: numberOrNull(record.maxplaytime),
    yearPublished: numberOrNull(record.yearpublished),
    versions: parseVersionLinks(record.links),
  };
};

const parseVersionLinks = (links: unknown): GeekdoVersionLink[] => {
  if (typeof links !== 'object' || links === null) return [];
  const list = (links as Record<string, unknown>).boardgameversion;
  if (!Array.isArray(list)) return [];

  return list.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const id = Number(record.objectid);
    const name = typeof record.name === 'string' ? record.name : '';
    if (!Number.isInteger(id) || id <= 0 || name === '') return [];
    return [{ id, name }];
  });
};

export const fetchGeekdoItem = async (
  bggId: number,
  objecttype: 'thing' | 'version' = 'thing',
): Promise<unknown> => {
  const subtype = objecttype === 'version' ? 'boardgameversion' : 'boardgame';
  const url = `${ENDPOINT}?objectid=${bggId}&objecttype=${objecttype}&subtype=${subtype}`;

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      // Identifying ourselves rather than pretending to be a browser: this is a polite reader
      // of a public endpoint, not something trying to look like something else.
      'user-agent': 'board-game-picker/0.1 (self-hosted collection picker)',
    },
  });

  if (!response.ok) {
    throw new Error(`geekdo ${bggId} → HTTP ${response.status}`);
  }

  return await response.json();
};

/**
 * "Versus, teams, co-op" — the facet the picker is built around, and the one the CSV export
 * could not answer at all.
 *
 * Order matters: a traitor game is cooperative-shaped but plays nothing like one, and a
 * solo-only game is not "competitive with one player".
 */
export const deriveInteractionTypes = (
  item: Pick<GeekdoItem, 'mechanics' | 'categories' | 'minPlayers' | 'maxPlayers'>,
): InteractionType[] => {
  const has = (needle: string) =>
    item.mechanics.some((name) => name.toLowerCase().includes(needle)) ||
    item.categories.some((name) => name.toLowerCase().includes(needle));

  const types: InteractionType[] = [];

  if (has('traitor') || has('hidden roles')) types.push('traitor');
  if (has('semi-cooperative')) types.push('semiCooperative');
  if (has('team-based') || has('team play')) types.push('team');
  if (has('cooperative')) types.push('cooperative');

  // A box with a solo mode IS a solo game as far as "what can I play alone tonight" is
  // concerned — a one-player-and-up co-op such as Harbour Lantern, and every escape-room box
  // in the Orchard series, belong in that list.
  if (item.minPlayers === 1) types.push('solo');

  // Versus unless the game is purely cooperative. A traitor game is emphatically both; a team
  // game is too.
  const isPurelyCooperative =
    types.includes('cooperative') && !types.includes('traitor') && !types.includes('team');

  if (!isPurelyCooperative) types.push('competitive');

  return types.length > 0 ? types : ['competitive'];
};
