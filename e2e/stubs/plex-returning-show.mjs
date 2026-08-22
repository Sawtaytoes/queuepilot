// A stub Plex holding ONE returning show: watched out, then a new episode airs.
//
// This is the shape of the 2026-08-15 bug seen from the GRID rather than from the engine.
// The engine already revives a `done` entry that resolves to something playable again; what
// nothing did was TELL anyone before the next scan. So the fixture is a queue whose entries
// are all marked done, against a library that has moved on:
//
//   * RETURNING_RK — E1/E2 watched, E3 fresh. `done` + `done_at`, so `markDone` wrote it and
//     the resolver will revive it. This is the tile that must stop saying "Completed".
//   * SKIPPED_RK   — the same library state, but `done: true` with NO `done_at`: the owner
//     tagged it by hand. A deliberate skip is revived only by an in-progress head, so this
//     tile must KEEP its badge. Without it, "the badge went away" and "the rule is right"
//     are the same observation.
//   * FINISHED_RK  — every episode watched. Genuinely done, and the control for the whole
//     test: if this one loses its badge, the fix un-badged everything.
//
// Offline: no token, no network. Shows only, so no watched-history read happens at all
// (`tagFinishedMovies` returns early with no movies) — the tiles here are decided entirely by
// each show's own `allLeaves`.
import { createServer } from 'node:http';

/** Watched out, then S1E3 aired. The Dating Sim case, with placeholder names. */
export const RETURNING_RK = '800';
/** Same library state, hand-marked done — a deliberate skip that must survive. */
export const SKIPPED_RK = '801';
/** Every episode watched. Nothing to revive. */
export const FINISHED_RK = '802';

const SHOWS = {
  [RETURNING_RK]: { title: 'The Returning Show', year: 2026, watched: 2, total: 3 },
  [SKIPPED_RK]: { title: 'The Show Set Aside', year: 2025, watched: 2, total: 3 },
  [FINISHED_RK]: { title: 'The Finished Show', year: 2024, watched: 3, total: 3 },
};

/** The show node — `showAggregate` reads leafCount/viewedLeafCount/updatedAt off this. */
const showNode = (rk) => ({
  ratingKey: rk,
  type: 'show',
  title: SHOWS[rk].title,
  year: SHOWS[rk].year,
  updatedAt: 1_700_000_000,
  leafCount: SHOWS[rk].total,
  viewedLeafCount: SHOWS[rk].watched,
  librarySectionID: 5,
});

/** Its episodes. Plex OMITS viewCount at 0, so an unwatched leaf simply has no count. */
const leaves = (rk) => Array.from({ length: SHOWS[rk].total }, (_, i) => ({
  ratingKey: `${rk}${i + 1}`,
  type: 'episode',
  title: `Episode ${i + 1}`,
  grandparentTitle: SHOWS[rk].title,
  parentIndex: 1,
  index: i + 1,
  duration: 1_420_011,
  ...(i < SHOWS[rk].watched ? { viewCount: 1 } : {}),
}));

/**
 * The queue that renders those three. Every entry is `done`; only the timestamps differ, and
 * that difference is the whole rule.
 */
export const QUEUES_YAML = `anime:
- ratingKey: "${RETURNING_RK}"
  title: The Returning Show (2026)
  done: true
  done_at: 1786668576
- ratingKey: "${SKIPPED_RK}"
  title: The Show Set Aside (2025)
  done: true
- ratingKey: "${FINISHED_RK}"
  title: The Finished Show (2024)
  done: true
  done_at: 1786668576
`;

export const SETS_YAML = `sets:
  - id: anime
    label: Placeholder — Anime
    kind: anime
    source: queue
    sections: [5]
`;

/**
 * Start the stub on `port`. `hits` records every path so a caller can assert what was read;
 * `close()` stops it.
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
    const leaf = /^\/library\/metadata\/(\d+)\/allLeaves$/.exec(url.pathname);
    if (leaf && SHOWS[leaf[1]]) return send({ MediaContainer: { size: 0, Metadata: leaves(leaf[1]) } });
    // The entries carry ratingKeys, so `resolveValue` reads the show node directly and the
    // section listing is never consulted.
    const meta = /^\/library\/metadata\/(\d+)$/.exec(url.pathname);
    if (meta && SHOWS[meta[1]]) return send({ MediaContainer: { size: 1, Metadata: [showNode(meta[1])] } });
    if (url.pathname === '/status/sessions/history/all') {
      return send({ MediaContainer: { size: 0, totalSize: 0, Metadata: [] } });
    }
    if (url.pathname === '/library/sections') {
      return send({ MediaContainer: { Directory: [{ key: '5', type: 'show' }] } });
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
