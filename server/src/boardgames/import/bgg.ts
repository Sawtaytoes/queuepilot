/**
 * Reading a collection straight from BoardGameGeek's XML API v2.
 *
 * **Optional, and off unless a token is configured.** BGG has required a registered
 * application token since 2025-07-02; without one every call answers `401`. So this is a
 * second way in beside the CSV export, never a replacement — a collection seeded from a CSV
 * must keep working forever, and someone with no BGG account at all is still a first-class
 * user of this app.
 *
 * Three things this API does that will surprise you:
 *
 *  1. **The collection endpoint queues.** The first call answers `202` with "your request has
 *     been accepted"; you retry until `200`. Ten seconds was enough in practice.
 *  2. **It does NOT carry the player-count poll.** The CSV export's `bggbestplayers` /
 *     `bggrecplayers` columns are computed by BGG *for the export*, and they are the entire
 *     basis of this app's player-count fitness. They have to be rebuilt from each game's
 *     `suggested_numplayers` poll on the `thing` endpoint — which is why a sync is two passes
 *     and not one. Skipping the second pass would silently flatten the thing the picker
 *     filters on.
 *  3. **`thing` takes up to 20 ids at once.** A whole collection is therefore a few dozen
 *     requests rather than one per game — the difference between a sync you press a button
 *     for and one you schedule overnight.
 */

const API = 'https://boardgamegeek.com/xmlapi2';

/** BGG asks for 2 requests/second. We take half that. */
const REQUEST_INTERVAL_MS = 1000;

/** How many ids `thing` will accept in one call. */
export const THING_BATCH_SIZE = 20;

/**
 * The row shape both collection importers produce.
 *
 * In the source app this type lived in `collection.ts`, beside the CSV importer. That file is
 * NOT part of this port — it reaches into the source repo's own `db/` layer, which this app
 * does not have — so the interface is declared here instead, field for field. When the CSV
 * importer follows, it should import this from here rather than redeclare it.
 */
export interface SourceRow {
  name: string;
  kind: 'standalone' | 'expansion';
  bggId: number | null;
  minPlayers: number;
  maxPlayers: number;
  bestWith: number[];
  recommendedWith: number[];
  weight: number | null;
  minPlaytime: number | null;
  maxPlaytime: number | null;
  minAge: number | null;
  yearPublished: number | null;
  rating: number | null;
  publishers: string[];
  versionNickname: string | null;
  versionYear: number | null;
  versionLanguages: string[];
}

export interface BggConfig {
  token: string;
  /** Whose collection to read. Not a secret, but it does identify a person. */
  username: string;
}

export interface BggCollectionItem {
  bggId: number;
  name: string;
  /** BGG's own word: `boardgame` or `boardgameexpansion`. */
  subtype: string;
  isOwned: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `null` when no token is configured — not a throw. An app with no BGG credentials is the
 * normal case, and the caller says so and carries on.
 */
export const bggConfigFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
  username?: string,
): BggConfig | null => {
  const token = env.BOARD_GAME_GEEK_API_TOKEN;
  const who = username?.trim() || env.BGG_USERNAME;
  if (!token || !who) return null;

  return { token, username: who };
};

const get = async (url: string, token: string): Promise<Response> =>
  await fetch(url, {
    headers: {
      accept: 'text/xml',
      authorization: `Bearer ${token}`,
      'user-agent': 'board-game-picker/0.1 (self-hosted collection picker)',
    },
  });

/**
 * Fetch the raw collection XML, waiting out BGG's queue.
 *
 * `attempts` is a ceiling on politeness, not a timeout: each `202` means BGG is still
 * building the export and asked us to come back.
 */
export const fetchCollectionXml = async (config: BggConfig, attempts = 12): Promise<string> => {
  const url = `${API}/collection?username=${encodeURIComponent(config.username)}&stats=1`;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await get(url, config.token);

    if (response.status === 200) return await response.text();

    if (response.status === 202) {
      await sleep(5000);
      continue;
    }

    if (response.status === 401)
      throw new Error('BGG rejected the token (401). Check BOARD_GAME_GEEK_API_TOKEN.');

    throw new Error(`BGG collection → HTTP ${response.status}`);
  }

  throw new Error(
    `BGG is still building the collection after ${attempts} attempts. Try again shortly.`,
  );
};

export const fetchThingsXml = async (bggIds: number[], config: BggConfig): Promise<string> => {
  const response = await get(`${API}/thing?id=${bggIds.join(',')}&stats=1`, config.token);

  if (!response.ok) throw new Error(`BGG thing → HTTP ${response.status}`);

  return await response.text();
};

/**
 * One title's editions, with images. Nested versions would truncate the sibling `parseThings`
 * regex, so this payload is parsed by `parseThingVersions`, not `parseThings`.
 */
export const fetchThingVersionsXml = async (
  bggId: number,
  config: BggConfig,
): Promise<string> => {
  const response = await get(`${API}/thing?id=${bggId}&versions=1`, config.token);

  if (!response.ok) throw new Error(`BGG thing versions → HTTP ${response.status}`);

  return await response.text();
};

/**
 * Titles matching a query.
 *
 * This exists because a merged family's listing is not always a box on the shelf. A series
 * can have one title listing on BGG while every physical box in it is a separately-numbered
 * entry that does NOT carry that listing's id — so the listing has to be nameable by search,
 * not only by picking an owned box.
 */
export const fetchSearchXml = async (query: string, config: BggConfig): Promise<string> => {
  const response = await get(
    `${API}/search?type=boardgame&query=${encodeURIComponent(query)}`,
    config.token,
  );

  if (!response.ok) throw new Error(`BGG search → HTTP ${response.status}`);

  return await response.text();
};

/**
 * Everything below is pure: XML text in, data out. The network lives above, so the parsing —
 * which is where the poll logic and every off-by-one lives — is testable without one.
 */

/**
 * A BGG object id, or `null`.
 *
 * The `> 0` is load-bearing. `Number(null)` is **0**, and 0 is finite — so a missing
 * attribute used to sail through as a perfectly valid id, and every game in a `thing` batch
 * parsed as id 0. The detail lookup then matched none of them and the whole collection
 * imported with no weights, no polls and no expansion flags. Silently.
 */
const objectId = (value: string | null): number | null => {
  const parsed = Number(value);
  return value !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const attr = (xml: string, tag: string, name: string): string | null => {
  const match = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`).exec(xml);
  return match?.[1] ?? null;
};

const numberOrNull = (value: string | null): number | null => {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  // BGG writes 0 for "unknown" in weight and playtime, exactly like the CSV export does, and
  // a 0 weight would make an unrated game the simplest game in the collection.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const decodeEntities = (text: string): string =>
  text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&apos;', "'")
    // Numeric entities: BGG sends dash characters and accented letters this way, and a
    // title such as "Harbour Lantern &#8211; 15th Anniversary" must match the same title
    // from the CSV export.
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));

const blocks = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'g'))].map(
    (match) => match[0],
  );

export const parseCollection = (xml: string): BggCollectionItem[] => {
  const items: BggCollectionItem[] = [];

  for (const item of blocks(xml, 'item')) {
    // `/collection` names it `objectid`; `/thing` names it `id`.
    const bggId = objectId(attr(item, 'item', 'objectid'));
    const nameMatch = /<name[^>]*>([\s\S]*?)<\/name>/.exec(item);
    if (bggId === null || !nameMatch) continue;

    items.push({
      bggId,
      isOwned: attr(item, 'status', 'own') === '1',
      name: decodeEntities(nameMatch[1] ?? '').trim(),
      subtype: attr(item, 'item', 'subtype') ?? 'boardgame',
    });
  }

  return items;
};

export interface BggSearchResult {
  bggId: number;
  name: string;
  yearPublished: number | null;
}

/**
 * `/search` items carry the id on `item`, the title on a nested `<name value="…"/>`. An
 * exact-match query still returns the franchise's expansions, so the caller shows the year —
 * "Harbour Lantern (2013)" is the title listing; the numbered boxes under it are not.
 */
export const parseSearch = (xml: string): BggSearchResult[] => {
  const results: BggSearchResult[] = [];

  for (const item of blocks(xml, 'item')) {
    const bggId = objectId(attr(item, 'item', 'id'));
    const name = attr(item, 'name', 'value');
    if (bggId === null || name === null) continue;

    results.push({
      bggId,
      name: decodeEntities(name).trim(),
      yearPublished: numberOrNull(attr(item, 'yearpublished', 'value')),
    });
  }

  return results;
};

export interface ThingDetail {
  bggId: number;
  /**
   * `boardgame` or `boardgameexpansion`, from the `thing` payload — which is the ONLY place
   * BGG tells the truth about it. The collection endpoint stamps every row with whatever
   * subtype you asked for, so a collection fetched there looks like it contains no expansions
   * at all. Believing that inflated a live import by more than half again, because every
   * expansion box became its own game instead of collapsing into its parent.
   */
  subtype: string;
  minPlayers: number | null;
  maxPlayers: number | null;
  minPlaytime: number | null;
  maxPlaytime: number | null;
  minAge: number | null;
  yearPublished: number | null;
  weight: number | null;
  rating: number | null;
  publishers: string[];
  /** Counts the community voted BEST at. */
  bestWith: number[];
  /** Best plus merely-recommended. */
  recommendedWith: number[];
}

/**
 * Rebuild the CSV export's `bggbestplayers` / `bggrecplayers` from the raw poll.
 *
 * The rule BGG uses for the export, and therefore the rule this app's existing data was built
 * with: for each player count, the option with the most votes wins. A count whose top answer
 * is `Best` is both best AND recommended; `Recommended` is recommended only; `Not
 * Recommended` is neither. A count nobody voted on is absent — NOT a negative, which is the
 * distinction the whole `unknown` verdict rests on.
 */
export const parsePlayerCountPoll = (
  itemXml: string,
): { bestWith: number[]; recommendedWith: number[] } => {
  const best: number[] = [];
  const recommended: number[] = [];

  const poll = /<poll\b[^>]*name="suggested_numplayers"[\s\S]*?<\/poll>/.exec(itemXml)?.[0];

  for (const result of blocks(poll ?? '', 'results')) {
    // "4+" is a real value in this poll. It cannot be a player count the picker filters on,
    // so it is dropped rather than parsed into a misleading 4.
    const countText = attr(result, 'results', 'numplayers');
    if (countText === null || !/^\d+$/.test(countText)) continue;
    const count = Number(countText);

    let winner: string | null = null;
    let mostVotes = 0;
    for (const vote of result.matchAll(
      /<result\b[^>]*value="([^"]*)"[^>]*numvotes="(\d+)"/g,
    )) {
      const votes = Number(vote[2]);
      if (votes > mostVotes) {
        mostVotes = votes;
        winner = vote[1] ?? null;
      }
    }

    // Nobody voted: unknown, and unknown stays pickable.
    if (mostVotes === 0) continue;

    if (winner === 'Best') {
      best.push(count);
      recommended.push(count);
    } else if (winner === 'Recommended') {
      recommended.push(count);
    }
  }

  const ascending = (a: number, b: number) => a - b;
  return {
    bestWith: best.sort(ascending),
    recommendedWith: recommended.sort(ascending),
  };
};

export const parseThings = (xml: string): ThingDetail[] => {
  const details: ThingDetail[] = [];

  for (const item of blocks(xml, 'item')) {
    // **`id`, not `objectid`.** A `thing` response has no `objectid` attribute at all — that
    // one belongs to `/collection`. See `objectId`.
    const bggId = objectId(attr(item, 'item', 'id'));
    if (bggId === null) continue;

    const publishers = [
      ...item.matchAll(/<link\b[^>]*type="boardgamepublisher"[^>]*value="([^"]*)"/g),
    ]
      .map((match) => decodeEntities(match[1] ?? ''))
      // The full list runs to dozens of regional reprints; the first few are the ones a
      // person would recognise, and publisher is a SEARCH field here, not a display one.
      .slice(0, 3);

    details.push({
      bggId,
      ...parsePlayerCountPoll(item),
      subtype: attr(item, 'item', 'type') ?? 'boardgame',
      maxPlayers: numberOrNull(attr(item, 'maxplayers', 'value')),
      maxPlaytime: numberOrNull(attr(item, 'maxplaytime', 'value')),
      minAge: numberOrNull(attr(item, 'minage', 'value')),
      minPlayers: numberOrNull(attr(item, 'minplayers', 'value')),
      minPlaytime: numberOrNull(attr(item, 'minplaytime', 'value')),
      publishers,
      rating: numberOrNull(attr(item, 'average', 'value')),
      weight: numberOrNull(attr(item, 'averageweight', 'value')),
      yearPublished: numberOrNull(attr(item, 'yearpublished', 'value')),
    });
  }

  return details;
};

/**
 * Collection entry + `thing` detail → the same `SourceRow` the CSV importer produces, so both
 * paths land in `importRows` and group identically.
 */
export const toSourceRow = (
  item: BggCollectionItem,
  detail: ThingDetail | undefined,
): SourceRow => ({
  bestWith: detail?.bestWith ?? [],
  bggId: item.bggId,
  // BGG's `boardgameexpansion` is this app's `expansion`, which is what decides whether a box
  // can stand alone as a game.
  //
  // The DETAIL's subtype, not the collection item's: see `ThingDetail.subtype`. The
  // collection entry's is a copy of the query and always says `boardgame`.
  kind: (detail?.subtype ?? item.subtype) === 'boardgameexpansion' ? 'expansion' : 'standalone',
  maxPlayers: detail?.maxPlayers ?? 1,
  maxPlaytime: detail?.maxPlaytime ?? null,
  minAge: detail?.minAge ?? null,
  minPlayers: detail?.minPlayers ?? 1,
  minPlaytime: detail?.minPlaytime ?? null,
  name: item.name,
  publishers: detail?.publishers ?? [],
  rating: detail?.rating ?? null,
  recommendedWith: detail?.recommendedWith ?? [],
  versionLanguages: [],
  versionNickname: null,
  versionYear: null,
  weight: detail?.weight ?? null,
  yearPublished: detail?.yearPublished ?? null,
});

export const chunk = <T>(values: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

/**
 * Both passes: the collection, then the details for everything owned in it. `onProgress`
 * exists because this is behind a button — a sync that looks frozen for twenty seconds gets
 * pressed again.
 */
export const fetchOwnedRows = async (
  config: BggConfig,
  onProgress?: (message: string) => void,
): Promise<SourceRow[]> => {
  onProgress?.('asking BGG for the collection…');
  const items = parseCollection(await fetchCollectionXml(config));
  const owned = items.filter((item) => item.isOwned);

  const batches = chunk(
    owned.map((item) => item.bggId),
    THING_BATCH_SIZE,
  );
  const details = new Map<number, ThingDetail>();

  for (const [index, batch] of batches.entries()) {
    onProgress?.(`player-count polls, batch ${index + 1} of ${batches.length}`);
    for (const detail of parseThings(await fetchThingsXml(batch, config))) {
      details.set(detail.bggId, detail);
    }
    if (index < batches.length - 1) await sleep(REQUEST_INTERVAL_MS);
  }

  return owned.map((item) => toSourceRow(item, details.get(item.bggId)));
};
