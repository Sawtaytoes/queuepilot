// Engine test for RESUME-IN-QUEUE (docs ROADMAP §B.2).
//
// A curated queue (`source: queue`) whose lead item was STARTED but not finished must resume
// THAT item at its Plex viewOffset on the next scan — not advance, not restart at 0. A finished
// item still advances; a fresh (0-offset) item still starts at 0. And the resume offset must be
// threaded all the way to the Companion `playMedia` call.
//
// Node port of the retired e2e/resume-in-queue-test.py (deleted with queue_builder/ on
// 2026-08-12), against server/src/engine/resolve.js + server/src/playback.js. Runs fully
// offline: the Plex reads are a hand-built container client and undici is stubbed for the
// device call, so nothing here touches the live server.
//
// Run:  node e2e/resume-in-queue-test.mjs   (from the repo root; non-zero on failure)
process.env.PLEX_API_SERVER_URL = 'http://plex.invalid:32400';
process.env.PLEX_TOKEN = 'test-token';
process.env.SHIELD_CLIENT_URI = 'http://shield.invalid:32500';
process.env.SHIELD_CLIENT_NAME = 'Shield';
process.env.SHIELD_CLIENT_MACHINE_ID = 'mid';
process.env.PLAYBACK_MODE = 'client';
// Point every on-disk path at a scratch dir BEFORE any server module is imported — env.js,
// config.js and sets.js all snapshot these at module-eval, and sets.js SEEDS a default
// sets.yaml at its path, so a late assignment writes into the real /config.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

const SCRATCH = mkdtempSync(nodePath.join(tmpdir(), 'resume-'));
process.env.SETS_PATH = nodePath.join(SCRATCH, 'sets.yaml');
process.env.QUEUES_PATH = nodePath.join(SCRATCH, 'queues.yaml');
process.env.CACHE_PATH = nodePath.join(SCRATCH, 'cache.sqlite');
writeFileSync(
  process.env.SETS_PATH,
  'sets:\n  - id: bob\n    label: Bob Queue\n    source: queue\n    sections: [1]\n',
);
writeFileSync(process.env.QUEUES_PATH, 'bob: []\n');

const FAILS = [];
function ok(name, cond, detail = '') {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

// --------------------------------------------------------------------------- //
// The in-progress predicate (viewOffset > 0 AND not finished)
// --------------------------------------------------------------------------- //
const resolve = await import('../server/src/engine/resolve.js');

ok('inProgress: started, not finished -> true', resolve.inProgress(45000, 0) === true);
ok('inProgress: never started -> false', resolve.inProgress(0, 0) === false);
ok('inProgress: finished once, then rewound -> false', resolve.inProgress(30000, 1) === false);
// Plex OMITS viewCount at 0, so a missing count must read as unwatched, never as watched.
ok('inProgress: absent viewCount counts as 0 (still resumable)',
  resolve.inProgress(45000, undefined) === true);

// --------------------------------------------------------------------------- //
// nextQueue: selects the in-progress lead and reports its offset
// --------------------------------------------------------------------------- //
// ratingKey -> [viewOffset, viewCount], served both as per-leaf state and via metadata.
const VIEW_STATE = {
  inprog: [45000, 0],  // started, not finished -> resume at 45000
  fresh: [0, 0],       // never started -> 0
  rewound: [30000, 1], // finished once then rewound -> a completed view, so NOT resumed
};

// The scenarios drive the REAL resolveMember through a leaf/metadata client: RESOLVE maps a
// queue entry's ratingKey to its episode list (a show), and anything absent from it resolves as
// a movie. VIEW_STATE supplies each item's live view state, per-leaf and via metadata alike.
let RESOLVE = {};
const leafClient = {
  async container(path) {
    const leaves = path.match(/\/library\/metadata\/([^/?]+)\/allLeaves/);
    if (leaves) {
      const rks = RESOLVE[leaves[1]] || [];
      return {
        Metadata: rks.map((rk, i) => ({
          ratingKey: rk,
          title: rk,
          grandparentTitle: leaves[1],
          parentIndex: 1,
          index: i + 1,
          duration: 1000,
          type: 'episode',
          viewCount: VIEW_STATE[rk] ? VIEW_STATE[rk][1] : 0,
          viewOffset: VIEW_STATE[rk] ? VIEW_STATE[rk][0] : 0,
        })),
      };
    }
    const meta = path.match(/\/library\/metadata\/([^/?]+)$/);
    if (meta) {
      const rk = meta[1];
      const [viewOffset, viewCount] = VIEW_STATE[rk] || [0, 0];
      // `type: show` for a key with leaves, else a movie.
      return {
        Metadata: [{
          ratingKey: rk, title: rk, type: RESOLVE[rk] ? 'show' : 'movie', viewOffset, viewCount,
        }],
      };
    }
    return { Metadata: [] };
  },
  async accountToken() { return null; },
};

const CFG = { kind: 'movie', source: 'queue', queue_sections: [1] }; // != anime -> ordered queue
const entriesFor = (keys, episodes = null) => keys.map((k) => ({
  key: k, done: false, title: null, ratingKey: k, collection: null, start: null, episodes,
}));

// 1. In-progress MOVIE lead: chosen, and its offset reported.
RESOLVE = {};
let res = await resolve.nextQueue(leafClient, 'bob', CFG, entriesFor(['inprog']), new Set(), null);
ok('in-progress movie is the play head',
  JSON.stringify(res.play.map((i) => i.ratingKey)) === JSON.stringify(['inprog']), JSON.stringify(res.play));
ok('in-progress movie reports its viewOffset', res.offset === 45000, String(res.offset));

// 2. In-progress SERIES: the started episode leads and its offset is reported (later episodes
//    stay in the batch and play from 0 after it). `episodes: 2` widens the per-entry batch past
//    the QUEUE_SERIES_DEFAULT of 1, so the tail is visible.
RESOLVE = { showX: ['inprog', 'fresh'] };
res = await resolve.nextQueue(leafClient, 'bob', CFG, entriesFor(['showX'], 2), new Set(), null);
ok('in-progress episode leads the series batch',
  JSON.stringify(res.play.map((i) => i.ratingKey)) === JSON.stringify(['inprog', 'fresh']),
  JSON.stringify(res.play.map((i) => i.ratingKey)));
ok('series resume reports the episode\'s viewOffset', res.offset === 45000, String(res.offset));

// The default batch is ONE episode, so an unwidened series entry queues just the resumable head.
RESOLVE = { showX: ['inprog', 'fresh'] };
res = await resolve.nextQueue(leafClient, 'bob', CFG, entriesFor(['showX']), new Set(), null);
ok('default series batch is the in-progress episode alone',
  JSON.stringify(res.play.map((i) => i.ratingKey)) === JSON.stringify(['inprog'])
  && res.offset === 45000, JSON.stringify(res.play.map((i) => i.ratingKey)));

// 3. Finished lead still ADVANCES: entry 1 is fully watched (no unwatched items -> done), so
//    the next entry leads and, being fresh, starts at 0.
RESOLVE = { showDone: ['rewound'] };
res = await resolve.nextQueue(
  leafClient, 'bob', CFG, entriesFor(['showDone', 'fresh']), new Set(['rewound']), null,
);
ok('finished entry advances to the next entry',
  JSON.stringify(res.play.map((i) => i.ratingKey)) === JSON.stringify(['fresh']),
  JSON.stringify(res.play.map((i) => i.ratingKey)));
ok('finished entry is reported newly done', JSON.stringify(res.newlyDone) === JSON.stringify(['showDone']),
  JSON.stringify(res.newlyDone));
ok('advanced-to fresh item starts at 0', res.offset === 0, String(res.offset));

// 4. Fresh lead: a queued item never started plays from 0.
RESOLVE = {};
res = await resolve.nextQueue(leafClient, 'bob', CFG, entriesFor(['fresh']), new Set(), null);
ok('fresh lead starts at 0', res.offset === 0, String(res.offset));

// A rewound (finished) item is NOT resumed even though it has an offset.
res = await resolve.nextQueue(leafClient, 'bob', CFG, entriesFor(['rewound']), new Set(), null);
ok('finished-then-rewound lead starts at 0, not its offset', res.offset === 0, String(res.offset));

// --------------------------------------------------------------------------- //
// playRatingKeys: the offset reaches the Companion playMedia call (client path)
// --------------------------------------------------------------------------- //
// undici is stubbed for playback.js/plex.js, so the playQueue POST and the playMedia GET are
// recorded instead of sent. Everything else in playback.js runs for real.
const CALLS = [];
const UNDICI_STUB = `
  export const Agent = class { constructor() {} };
  export async function request(url) {
    ${'globalThis'}.__PLEX_CALLS.push(String(url));
    const body = String(url).includes('/playQueues')
      // size is not decoration: createPlayQueue rejects an EMPTY queue (Plex answers 200 with
      // size 0 for items the token cannot see), so a stub without it is not a playable queue.
      ? JSON.stringify({ MediaContainer: { playQueueID: 77, size: 2 } })
      : JSON.stringify({ MediaContainer: { machineIdentifier: 'server-mid' } });
    return { statusCode: 200, body: { text: async () => body } };
  }
`;
globalThis.__PLEX_CALLS = CALLS;
const { registerHooks } = await import('node:module');
const undiciUrl = `data:text/javascript,${encodeURIComponent(UNDICI_STUB)}`;
registerHooks({
  resolve(spec, ctx, next) {
    const parent = ctx && ctx.parentURL ? ctx.parentURL : '';
    if (spec === 'undici' && /\/server\/src\/(playback|plex)\.js$/.test(parent)) {
      return { url: undiciUrl, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const playback = await import('../server/src/playback.js');

const playMediaQuery = () => {
  const call = CALLS.find((c) => c.includes('playMedia')) || '';
  const q = call.includes('?') ? call.slice(call.indexOf('?') + 1) : '';
  return Object.fromEntries(new URLSearchParams(q));
};

// Resume: a non-zero offset is passed straight through as Companion's `offset` (ms).
CALLS.length = 0;
await playback.playRatingKeys(['inprog', 'fresh'], {
  setName: 'bob', device: { mode: 'client', uri: 'http://shield.invalid:32500' }, offset: 45000,
});
ok('offset is threaded to the playMedia call', playMediaQuery().offset === '45000',
  JSON.stringify(playMediaQuery()));

// Fresh: no offset -> plays from 0, exactly as before.
CALLS.length = 0;
await playback.playRatingKeys(['fresh'], {
  setName: 'bob', device: { mode: 'client', uri: 'http://shield.invalid:32500' }, offset: 0,
});
ok('a 0 offset still starts playback at 0', playMediaQuery().offset === '0',
  JSON.stringify(playMediaQuery()));

console.log(FAILS.length ? `FAILURES: ${FAILS.length}` : 'done');
process.exit(FAILS.length ? 1 : 0);
