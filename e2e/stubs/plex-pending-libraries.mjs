// A stub Plex for the PENDING LIBRARIES before/after shot.
//
// EVERY byte is FIXTURE data. The repo is public, so the shot must never be a live capture:
// the owner's library titles are exactly the thing no grep will ever find again once they
// are inside a committed PNG (decision
// `2026-08-19-pr-screenshots-are-fixture-data-and-pinned-to-the-merge`).
//
// The fixture is built so that BOTH halves of the change are visible in one frame:
//
//   * SIX libraries, three of them Plex "Other Videos" (`com.plexapp.agents.none`). Two
//     queues draw from the scratch ones, which under the old rule is what admitted them —
//     the exact shape that put 1,097 clips on the owner's live page.
//   * 720 arrivals, enough that rendering all of them is visibly a different page from
//     rendering the forty you can see.
//
// Public-domain films and invented shorts stand in. The scratch libraries hold encode-shaped
// names because that is what makes "these are never Pending" read as obvious rather than as
// a claim.
import { createServer } from 'node:http';

const FILMS = 1;
const SERIALS = 5;
const DOCS = 14;
const CLIPS = 7;
const DEMOS = 2;
const CALIBRATION = 9;

/**
 * The libraries `plex.sections()` reports.
 *
 * `agent` is the whole fixture: `plex.sections()` derives `other` from
 * `type === 'movie' && agent === 'com.plexapp.agents.none'`, and `other` is what the new
 * default keys on. Naming the agent rather than a flag keeps the stub honest about where
 * the property comes from.
 */
const SECTIONS = [
  { key: String(FILMS), title: 'Films', type: 'movie', agent: 'tv.plex.agents.movie' },
  { key: String(SERIALS), title: 'Serials', type: 'show', agent: 'tv.plex.agents.series' },
  { key: String(DOCS), title: 'Documentaries', type: 'movie', agent: 'tv.plex.agents.movie' },
  { key: String(CLIPS), title: 'Clips', type: 'movie', agent: 'com.plexapp.agents.none' },
  { key: String(DEMOS), title: 'Demos', type: 'movie', agent: 'com.plexapp.agents.none' },
  { key: String(CALIBRATION), title: 'Calibration', type: 'movie', agent: 'com.plexapp.agents.none' },
];

const ADDED = 1_755_000_000;

/** Public-domain features, cycled so the grid is dense without inventing 300 titles. */
const FILM_TITLES = [
  'The Cabinet of Dr. Caligari', 'Nosferatu', 'The General', 'Metropolis',
  'The Phantom Carriage', 'Sunrise', 'Battleship Potemkin', 'The Gold Rush',
  'Sherlock Jr.', 'The Kid', 'Safety Last!', 'Steamboat Bill, Jr.',
  'The Lodger', 'Body and Soul', 'Within Our Gates', 'The Last Laugh',
];

const SERIAL_TITLES = [
  'The Perils of the Airfield', 'Rocket Squadron', 'The Copper Mask',
  'Signal Fires', 'The Long Dispatch', 'Harbour Lights',
];

const DOC_TITLES = [
  'Rails Across the Plain', 'Harvest of the Delta', 'A Year in the Foundry',
  'The Lighthouse Keepers', 'Bridges of the North',
];

let nextKey = 9000;
const make = (title, section, type, extra = {}) => ({
  ratingKey: String(nextKey++),
  type,
  title,
  year: 1920 + (nextKey % 40),
  addedAt: ADDED + nextKey,
  contentRating: type === 'show' ? 'TV-PG' : 'NR',
  librarySectionID: section,
  ...extra,
});

/** `count` items cycled off `titles`, numbered past the first pass so none collide. */
const spread = (titles, count, section, type) =>
  Array.from({ length: count }, (_, i) => {
    const base = titles[i % titles.length];
    const pass = Math.floor(i / titles.length);
    return make(pass === 0 ? base : `${base} (Part ${pass + 1})`, section, type);
  });

export const BY_SECTION = {
  [FILMS]: spread(FILM_TITLES, 240, FILMS, 'movie'),
  [SERIALS]: spread(SERIAL_TITLES, 90, SERIALS, 'show'),
  [DOCS]: spread(DOC_TITLES, 30, DOCS, 'movie'),
  // The scratch libraries. Encode-shaped names, because "these are never Pending" has to be
  // obvious in the picture rather than asserted in the caption.
  [CLIPS]: Array.from({ length: 210 }, (_, i) =>
    make(`[QC] reel-${String(i + 1).padStart(3, '0')} x265-10bit {SDR}`, CLIPS, 'movie')),
  [DEMOS]: Array.from({ length: 110 }, (_, i) =>
    make(`[Demo] atmos-bed-${String(i + 1).padStart(3, '0')} {TrueHD}`, DEMOS, 'movie')),
  [CALIBRATION]: Array.from({ length: 40 }, (_, i) =>
    make(`[Cal] pluge-step-${String(i + 1).padStart(2, '0')}`, CALIBRATION, 'movie')),
};

const ALL = Object.values(BY_SECTION).flat();

/**
 * Two queues, and the second one is the point: `bench` draws from the two scratch libraries,
 * which is what the OLD rule read as "somebody cares about these" — the shape that put every
 * clip and test encode on the screen.
 */
export const QUEUES_YAML = 'features:\n- []\nbench:\n- []\n';

export const SETS_YAML = `sets:
  - id: features
    label: Feature Films
    kind: movies
    source: queue
    sections: [${FILMS}, ${DOCS}]
  - id: serials
    label: Serials
    kind: shows
    source: queue
    sections: [${SERIALS}]
  - id: bench
    label: Encode Bench
    kind: movies
    source: queue
    sections: [${CLIPS}, ${DEMOS}]
`;

/** Watermark before every arrival, so coverage and the library choice are the only filters. */
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
      const pool = BY_SECTION[Number(all[1])] || [];
      const wanted = String(url.searchParams.get('title') || '').toLowerCase();
      if (wanted) return wrap(pool.filter((m) => m.title.toLowerCase().includes(wanted)));
      return wrap(pool);
    }
    const batch = /^\/library\/metadata\/([\d,]+)$/.exec(url.pathname);
    if (batch) {
      const want = new Set(String(batch[1]).split(','));
      return wrap(ALL.filter((m) => want.has(m.ratingKey)));
    }
    // No artwork: `/api/thumb` proxies to this stub, which answers nothing, and `Poster`
    // already renders its fallback for a cover that fails. A shot of 700 identical
    // placeholder rectangles would say less than a shot of the titles.
    return send({ MediaContainer: { size: 0 } });
  });
  const listening = new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    ready: listening,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
