// A stub Plex for the PENDING COVERAGE before/after shot.
//
// EVERY byte is FIXTURE data. The repo is public, so the shot must never be a live capture:
// the owner's anime queue names and library titles are exactly the thing no grep will ever
// find again once they are inside a committed PNG. Public-domain films and invented series
// stand in, and `e2e/fixtures/` is the only other thing on screen.
//
// The fixture is built so that the change is VISIBLE rather than described. Six items arrive;
// two of them must disappear, and each for a different one of the two reasons:
//
//   * "The Cabinet of Dr. Caligari" is named by a queue entry that is a BARE TITLE with no
//     ratingKey — the shape 84 of the owner's live entries use, and the shape the coverage
//     check could not read.
//   * "Metropolis" has been watched (`viewCount: 1`), and "Sunrise" is a series with every
//     episode played (`viewedLeafCount == leafCount`). Watch state was never subtracted.
//
// The other three have nothing covering them and are watched by nobody, so they stay on the
// list in both shots — which is what makes the two that leave read as a subtraction rather
// than as an empty page.
import { createServer } from 'node:http';

const MOVIES_SECTION = 1;
const SHOWS_SECTION = 5;

/** The libraries `plex.sections()` reports. */
const SECTIONS = [
  { key: String(MOVIES_SECTION), title: 'Movies', type: 'movie', agent: 'tv.plex.agents.movie' },
  { key: String(SHOWS_SECTION), title: 'Series', type: 'show', agent: 'tv.plex.agents.series' },
];

const ADDED = 1_755_000_000;

/** Public-domain films. Plex OMITS viewCount at 0, so an unwatched item simply has none. */
export const MOVIES = [
  { ratingKey: '9001', type: 'movie', title: 'The Cabinet of Dr. Caligari', year: 1920, addedAt: ADDED + 600, contentRating: 'NR', librarySectionID: MOVIES_SECTION },
  { ratingKey: '9002', type: 'movie', title: 'Metropolis', year: 1927, addedAt: ADDED + 500, contentRating: 'NR', librarySectionID: MOVIES_SECTION, viewCount: 1 },
  { ratingKey: '9003', type: 'movie', title: 'Nosferatu', year: 1922, addedAt: ADDED + 400, contentRating: 'NR', librarySectionID: MOVIES_SECTION },
  { ratingKey: '9004', type: 'movie', title: 'The General', year: 1926, addedAt: ADDED + 300, contentRating: 'NR', librarySectionID: MOVIES_SECTION },
];

export const SHOWS = [
  { ratingKey: '9101', type: 'show', title: 'Sunrise', year: 1927, addedAt: ADDED + 200, contentRating: 'TV-PG', librarySectionID: SHOWS_SECTION, leafCount: 8, viewedLeafCount: 8 },
  { ratingKey: '9102', type: 'show', title: 'The Phantom Carriage', year: 1921, addedAt: ADDED + 100, contentRating: 'TV-PG', librarySectionID: SHOWS_SECTION, leafCount: 8, viewedLeafCount: 3 },
];

/**
 * The queues. `bob` names one film by BARE TITLE and nothing else — the reported shape. The
 * watermark in `pending.fixture.yaml` sits before every `addedAt` above, so all six items are
 * new and only coverage and watch state can remove any of them.
 */
export const QUEUES_YAML = 'bob:\n- "The Cabinet of Dr. Caligari"\nseries:\n- []\n';

export const SETS_YAML = `sets:
  - id: bob
    label: Bob — Movies
    kind: movies
    source: queue
    sections: [${MOVIES_SECTION}]
  - id: series
    label: Bob — Series
    kind: shows
    source: queue
    sections: [${SHOWS_SECTION}]
`;

export const PENDING_YAML = `seen_through: ${ADDED}\ndismissed: []\n`;

/** Start the stub on `port`; `close()` stops it. */
export function startStubPlex(port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const send = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const wrap = (rows) => send({ MediaContainer: { size: rows.length, Metadata: rows } });

    if (url.pathname === '/library/sections') {
      return send({ MediaContainer: { size: SECTIONS.length, Directory: SECTIONS } });
    }
    const all = /^\/library\/sections\/(\d+)\/all$/.exec(url.pathname);
    if (all) {
      const pool = all[1] === String(SHOWS_SECTION) ? SHOWS : MOVIES;
      // The TITLE search `resolve.resolveTitle` makes. Plex matches loosely and the resolver
      // scores what comes back, so this answers with a substring match and lets the real
      // scoring decide.
      const wanted = String(url.searchParams.get('title') || '').toLowerCase();
      if (wanted) return wrap(pool.filter((m) => m.title.toLowerCase().includes(wanted)));
      return wrap(pool);
    }
    const batch = /^\/library\/metadata\/([\d,]+)$/.exec(url.pathname);
    if (batch) {
      const want = new Set(String(batch[1]).split(','));
      return wrap([...MOVIES, ...SHOWS].filter((m) => want.has(m.ratingKey)));
    }
    // Collections, children, episodes, history: nothing in this fixture uses them.
    return send({ MediaContainer: { size: 0 } });
  });
  const listening = new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    ready: listening,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
