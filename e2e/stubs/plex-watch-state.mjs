// A stub Plex that answers exactly the three questions a movie tile's WATCH STATE comes from,
// and answers two of them differently on purpose.
//
// The point of the split: `resolveTitle` (the section listing) is what the 7-day `resolved`
// cache holds, and nothing busts it for a movie — so the listing here reports the PRE-playback
// view state, the way a week-old cache row would. `/library/metadata/<ids>` reports the truth.
// Anything that renders from the listing is therefore visibly wrong, which is what the gate
// (e2e/finished-live-test.ts) and the before/after shot (e2e/shot-completed-badge.ts) both
// need in order to mean something.
//
// The fixture is the live case, 2026-08-16: a film finished minutes ago, one never started,
// and one in the watch history that is being watched AGAIN (in-progress must win over
// Completed — the Prison School rule at the movie level).
import { createServer } from 'node:http';

/** Finished tonight — Plex knows, the last scan does not. The "2001" case. */
export const WATCHED_RK = '900';
/** Never played. */
export const FRESH_RK = '901';
/** In the history, and sitting at a resume point right now. */
export const RESUMING_RK = '902';

/** What the section listing (and so the resolved cache) reports — no view state at all. */
export const LISTING = [
  { ratingKey: WATCHED_RK, type: 'movie', title: '2001: A Space Odyssey', year: 1968, librarySectionID: 1, duration: 8929280 },
  { ratingKey: FRESH_RK, type: 'movie', title: "Logan's Run", year: 1976, librarySectionID: 1, duration: 6120000 },
  { ratingKey: RESUMING_RK, type: 'movie', title: 'Predator', year: 1987, librarySectionID: 1, duration: 6600000 },
];

/** Live truth, as `/library/metadata/<ids>` reports it. Plex OMITS viewCount at 0. */
export const LIVE = {
  [WATCHED_RK]: { viewCount: 1, duration: 8929280 },
  [FRESH_RK]: { duration: 6120000 },
  [RESUMING_RK]: { viewOffset: 1060898, duration: 6600000 },
};

/** The queue that renders those three, in the live queue's own entry format. */
export const QUEUES_YAML = `movies:
- "2001: A Space Odyssey (1968)"
- "Logan's Run (1976)"
- "Predator (1987)"
`;

export const SETS_YAML = `sets:
  - id: movies
    label: Bob & Alice — Movies
    kind: movies
    source: queue
    sections: [1]
`;

/**
 * Start the stub on `port`. `hits` records every path so a caller can assert the batched
 * metadata read actually happened; `close()` stops it.
 */
export function startStubPlex(port) {
  const hits = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    hits.push(url.pathname);
    const send = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (/^\/library\/sections\/\d+\/all$/.test(url.pathname)) {
      const want = String(url.searchParams.get('title') || '').toLowerCase();
      const rows = LISTING.filter((m) => String(m.title).toLowerCase() === want);
      return send({ MediaContainer: { size: rows.length, Metadata: rows } });
    }
    // Watched state per account — the set's own history, which is what a scan judges by.
    // Only the admin account (1) has watched anything here.
    if (url.pathname === '/status/sessions/history/all') {
      const rows = url.searchParams.get('accountID') === '1'
        ? [{ ratingKey: WATCHED_RK, type: 'movie' }, { ratingKey: RESUMING_RK, type: 'movie' }]
        : [];
      return send({ MediaContainer: { size: rows.length, totalSize: rows.length, Metadata: rows } });
    }
    const batch = /^\/library\/metadata\/([\d,]+)$/.exec(url.pathname);
    if (batch) {
      const rows = String(batch[1]).split(',').map((rk) => ({
        ratingKey: rk,
        type: 'movie',
        title: LISTING.find((m) => m.ratingKey === rk)?.title,
        ...(LIVE[rk] || {}),
      }));
      return send({ MediaContainer: { size: rows.length, Metadata: rows } });
    }
    return send({ MediaContainer: { size: 0 } });
  });
  const listening = new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    hits,
    ready: listening,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
