// A stub Plex for the MEMBER LIST before/after shot.
//
// EVERY byte is FIXTURE data. The repo is public, and the live case that prompted this change
// is a shelf of the owner's own films — exactly the thing no grep will ever find again once it
// is inside a committed PNG (decision
// `2026-08-19-pr-screenshots-are-fixture-data-and-pinned-to-the-merge`).
//
// The fixture is built so the problem is VISIBLE rather than described. One collection holds
// FIVE members, and three of them are the same public-domain film in three different Plex
// EDITIONS — same title, same year, three runtimes. That is the shape that has no answer
// before this change:
//
//   * the tile can only name "The Great Train Robbery", so it cannot say which cut is next;
//   * the tile menu skips whichever one is next, one at a time, each behind a re-resolve;
//   * and the two skipped rows in the Skipped panel then read identically.
//
// A two-season SHOW is here as well, for the second frame: the same list, drawn from episodes
// rather than members, which is the other half of what shipped.
import { createServer } from 'node:http';

const MOVIES_SECTION = 1;
const SHOWS_SECTION = 5;

const SECTIONS = [
  { key: String(MOVIES_SECTION), title: 'Movies', type: 'movie', agent: 'tv.plex.agents.movie' },
  { key: String(SHOWS_SECTION), title: 'Series', type: 'show', agent: 'tv.plex.agents.series' },
];

const MIN = 60_000;

/**
 * The collection's members, in collection order. Three cuts of one film first, so the
 * duplicate rows are the first thing the eye lands on — which is how the owner met them.
 *
 * Plex OMITS `viewCount` at 0, so an unwatched member simply has none.
 */
export const MEMBERS = [
  { ratingKey: '9601', type: 'movie', title: 'The Great Train Robbery', year: 1903, editionTitle: 'Theatrical Cut', duration: 12 * MIN, librarySectionID: MOVIES_SECTION },
  { ratingKey: '9602', type: 'movie', title: 'The Great Train Robbery', year: 1903, editionTitle: 'Extended Cut', duration: 21 * MIN, librarySectionID: MOVIES_SECTION },
  { ratingKey: '9603', type: 'movie', title: 'The Great Train Robbery', year: 1903, editionTitle: 'Restored Cut', duration: 24 * MIN, librarySectionID: MOVIES_SECTION },
  { ratingKey: '9604', type: 'movie', title: 'The Gold Rush', year: 1925, duration: 95 * MIN, librarySectionID: MOVIES_SECTION },
  { ratingKey: '9605', type: 'movie', title: 'The General', year: 1926, duration: 79 * MIN, librarySectionID: MOVIES_SECTION },
];

export const COLLECTION = {
  ratingKey: '9600',
  type: 'collection',
  title: 'The Frontier Trilogy',
  childCount: MEMBERS.length,
  librarySectionID: MOVIES_SECTION,
};

/** The show for the second frame — two seasons, one selectable special and one OP/ED extra. */
export const SHOW = {
  ratingKey: '9700',
  type: 'show',
  title: 'The Phantom Carriage',
  year: 1921,
  librarySectionID: SHOWS_SECTION,
  leafCount: 8,
  viewedLeafCount: 2,
  updatedAt: 1_755_000_000,
};

export const EPISODES = [
  { ratingKey: '9701', type: 'episode', title: 'Intermission', parentIndex: 0, index: 1, duration: 12 * MIN, originallyAvailableAt: '1921-02-01', grandparentTitle: SHOW.title },
  { ratingKey: '9702', type: 'episode', title: 'Closing Theme', parentIndex: 0, index: 301, duration: 2 * MIN, originallyAvailableAt: '1921-03-01', grandparentTitle: SHOW.title },
  { ratingKey: '9711', type: 'episode', title: 'The Bell Tolls', parentIndex: 1, index: 1, duration: 24 * MIN, viewCount: 1, grandparentTitle: SHOW.title },
  { ratingKey: '9712', type: 'episode', title: 'A Debt Owed', parentIndex: 1, index: 2, duration: 24 * MIN, viewCount: 1, grandparentTitle: SHOW.title },
  { ratingKey: '9713', type: 'episode', title: 'The Long Road', parentIndex: 1, index: 3, duration: 24 * MIN, grandparentTitle: SHOW.title },
  { ratingKey: '9721', type: 'episode', title: 'Snowfall', parentIndex: 2, index: 1, duration: 24 * MIN, grandparentTitle: SHOW.title },
  { ratingKey: '9722', type: 'episode', title: 'The Second Driver', parentIndex: 2, index: 2, duration: 24 * MIN, grandparentTitle: SHOW.title },
  { ratingKey: '9723', type: 'episode', title: 'Midnight', parentIndex: 2, index: 3, duration: 24 * MIN, grandparentTitle: SHOW.title },
];

/**
 * One queue, two entries — the collection and the show, which are the two shapes the member
 * list serves.
 *
 * The collection carries NO `ratingKey`, and that is the shape rather than an omission:
 * `plex.resolveValue`'s ratingKey branch answers only for a movie or a show, so a collection
 * is always resolved by NAME through `Collection: <name>` (or the `{collection:}` mapping).
 * Giving it a key here left the tile permanently unresolved.
 */
export const QUEUES_YAML = `bob:
- {title: "Collection: The Frontier Trilogy"}
- {ratingKey: "9700", title: "The Phantom Carriage (1921)"}
`;

export const SETS_YAML = `sets:
  - id: bob
    label: Bob — Movies
    kind: picks
    source: queue
    add_as: priority
    sections: [${MOVIES_SECTION}, ${SHOWS_SECTION}]
`;

/**
 * The BEFORE stage's skips: the two duplicate cuts, already skipped one at a time through the
 * tile menu. That is what makes the before/after honest — the old way COULD reach this state,
 * and the frame shows what it left behind (two rows with the same name).
 */
export const SKIPPED_BEFORE = ['9602', '9603'];

export function setsYamlWithSkips(skipped) {
  return `${SETS_YAML}    skipped: [${skipped.map((k) => `"${k}"`).join(', ')}]\n`;
}

/**
 * The order `/children` currently answers in — Plex's `collectionSort`, which the owner can
 * change from the Plex UI at any moment.
 *
 * Mutable, and that is the whole point: a RE-ORDER is the one library change the derived
 * cache cannot see (no timestamp moves, no count moves, no member joins or leaves), so a
 * suite that wants to reproduce one has to move the members under a warm cache. Call
 * `setMemberOrder` between two reads
 * (decision `2026-08-26-a-collection-re-order-is-invisible-so-the-panel-re-reads`).
 */
let memberOrder = MEMBERS.map((m) => m.ratingKey);

/** Re-order the collection, by ratingKey. Unknown keys are ignored; omitted ones drop out. */
export function setMemberOrder(keys) {
  memberOrder = keys.filter((k) => MEMBERS.some((m) => m.ratingKey === k));
}

/** Put the members back in their declared order — call it between suites sharing a stub. */
export function resetMemberOrder() {
  memberOrder = MEMBERS.map((m) => m.ratingKey);
}

/** The members as `/children` would list them right now. */
export function orderedMembers() {
  return memberOrder.map((k) => MEMBERS.find((m) => m.ratingKey === k)).filter(Boolean);
}

/** Start the stub on `port`; `close()` stops it. */
export function startStubPlex(port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const send = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const wrap = (rows, extra = {}) => send({
      MediaContainer: { size: rows.length, Metadata: rows, ...extra },
    });
    const all = [...MEMBERS, SHOW, COLLECTION, ...EPISODES];

    if (url.pathname === '/library/sections') {
      return send({ MediaContainer: { size: SECTIONS.length, Directory: SECTIONS } });
    }
    // The collection lookup behind a `Collection: <name>` entry.
    if (/^\/library\/sections\/\d+\/collections$/.test(url.pathname)) {
      const rows = url.pathname.startsWith(`/library/sections/${MOVIES_SECTION}/`) ? [COLLECTION] : [];
      return wrap(rows);
    }
    // A title search, scored by the real resolver — substring, as Plex itself matches.
    const section = /^\/library\/sections\/(\d+)\/all$/.exec(url.pathname);
    if (section) {
      const pool = section[1] === String(SHOWS_SECTION) ? [SHOW] : MEMBERS;
      const wanted = String(url.searchParams.get('title') || '').toLowerCase();
      return wrap(wanted ? pool.filter((m) => m.title.toLowerCase().includes(wanted)) : pool);
    }
    if (url.pathname === `/library/collections/${COLLECTION.ratingKey}/children`) {
      // The container carries `childCount`/`updatedAt` that REAL Plex does not send here (it
      // answers `size` and nothing else). Harmless — the reader treats both as optional — and
      // it keeps the fixture honest about what a validator would have to work with: neither
      // field moves when only the ORDER does.
      return wrap(orderedMembers(), { childCount: MEMBERS.length, updatedAt: 1_755_000_000 });
    }
    if (url.pathname === `/library/metadata/${SHOW.ratingKey}/allLeaves`) {
      return wrap(EPISODES);
    }
    const meta = /^\/library\/metadata\/([\d,]+)$/.exec(url.pathname);
    if (meta) {
      const want = new Set(String(meta[1]).split(','));
      return wrap(all.filter((m) => want.has(m.ratingKey)));
    }
    return send({ MediaContainer: { size: 0 } });
  });
  const listening = new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    ready: listening,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
