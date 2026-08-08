// Leaves cache is keyed PER ACCOUNT (browserless, self-contained: spawns its OWN fake Plex whose
// watched state varies by the request's X-Plex-Token, points plex.js at it, uses a private /tmp
// cache DB). Regression for the bug where a per-profile channel's editor read the ADMIN account's
// watched marks: allLeaves cached the episode list by show only, so viewCount (per-account) leaked
// across profiles. Now nextEpisode({token, account}) reads + caches that account's own row.
// (decision 2026-08-07-editor-episode-marks-per-account)
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';

const PORT = 18797;
const DB = '/tmp/leaves-per-account.sqlite';
for (const f of [DB, DB + '-wal', DB + '-shm']) await fs.rm(f, { force: true });

const ok = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) process.exitCode = 1; };

// --- fake Plex: one show, but watched state depends on WHICH account (token) asks -------------
const RK = '9001';
// Admin (Bob) watched E1+E2 → next is E3. The Kid profile watched nothing → next is E1.
const WATCHED = { 'admin-token': new Set([1, 2]), 'kid-token': new Set() };
const ep = (index, watched) => ({
  type: 'episode', ratingKey: `${RK}${index}`, parentIndex: 1, index,
  title: `Ep ${index}`, duration: 1_400_000, ...(watched ? { viewCount: 1 } : {}),
});
const leavesFor = (tok) => [1, 2, 3].map((i) => ep(i, WATCHED[tok]?.has(i)));
const hits = { 'admin-token': 0, 'kid-token': 0 };

const srv = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  const url = req.url.split('?')[0];
  const tok = req.headers['x-plex-token'] || 'admin-token';
  if (url === `/library/metadata/${RK}/allLeaves`) {
    hits[tok] = (hits[tok] || 0) + 1;
    const leaves = leavesFor(tok);
    res.end(JSON.stringify({ MediaContainer: { size: leaves.length, Metadata: leaves } }));
    return;
  }
  if (url === `/library/metadata/${RK}`) {
    // Show NODE aggregate — viewedLeafCount is this account's own (the validator input).
    res.end(JSON.stringify({ MediaContainer: { Metadata: [{
      type: 'show', ratingKey: RK, leafCount: 3, viewedLeafCount: (WATCHED[tok]?.size || 0), updatedAt: 1000,
    }] } }));
    return;
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => srv.listen(PORT, r));

process.env.PLEX_API_SERVER_URL = `http://127.0.0.1:${PORT}`;
process.env.PLEX_TOKEN = 'admin-token'; // the default (no-account) token
process.env.CACHE_PATH = DB;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const cache = await import('../server/src/cache.js');
const plex = await import('../server/src/plex.js');
await cache.init();

try {
  // 1) Admin read (no opts) → Bob's view: E1/E2 watched, next is E3. One allLeaves fetch.
  let n = await plex.nextEpisode(RK);
  ok(`admin sees next = E3 (got E${n?.episode})`, n?.episode === 3);
  ok(`admin fetched allLeaves once (hits=${hits['admin-token']})`, hits['admin-token'] === 1);

  // 2) Kid read (its own token + account) → nothing watched, next is E1. It must NOT reuse the
  //    admin row — a separate cache key, so its own allLeaves fetch.
  n = await plex.nextEpisode(RK, null, { token: 'kid-token', account: 'kid-uuid' });
  ok(`kid sees next = E1 (got E${n?.episode})`, n?.episode === 1);
  ok(`kid fetched its OWN allLeaves (hits=${hits['kid-token']})`, hits['kid-token'] === 1);

  // 3) Kid warm read → still E1, served from the kid-keyed row (no refetch).
  n = await plex.nextEpisode(RK, null, { token: 'kid-token', account: 'kid-uuid' });
  ok(`kid warm still E1 (got E${n?.episode})`, n?.episode === 1);
  ok(`kid warm did NOT refetch (hits=${hits['kid-token']})`, hits['kid-token'] === 1);

  // 4) Admin warm read → still E3, its row was NOT clobbered by the kid read (no refetch).
  n = await plex.nextEpisode(RK);
  ok(`admin warm still E3 (got E${n?.episode})`, n?.episode === 3);
  ok(`admin row intact, no refetch (hits=${hits['admin-token']})`, hits['admin-token'] === 1);
} finally {
  srv.close();
}
console.log('done');
