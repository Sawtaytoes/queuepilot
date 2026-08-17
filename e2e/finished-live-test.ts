// Offline gate: "Completed" does not wait for the next card tap.
//
// The bug, reported from the live app 2026-08-16. "2001: A Space Odyssey" was finished on the
// Bob & Alice queue at 22:34 — Plex had `viewCount: 1` and a history row a minute later —
// and the tile still showed nothing. `queues.markDone` had exactly ONE caller,
// `session.startSession`, so the finished-entry rule ran on a session START and nowhere else:
// `/api/queues` answered `done: false` for all 21 entries and would have kept answering it
// until the card was tapped again.
//
// Two evaluations were added and both are pinned here:
//
//   1. `finished.reconcileQueue()` — the write side runs when PLAYBACK ENDS, marking the
//      finished entry WITHOUT playing anything. The `keep_completed` / `reel` exemptions must
//      survive the move out of session.ts (a reel that starts writing `done` would grey out a
//      demo lineup that is supposed to replay forever).
//   2. `/api/queues` reports `isFinished` — the same rule judged live, so the badge is right
//      the moment you look. Deliberately proven against a STALE section listing: the stub
//      answers the title lookup (which is what the 7-day `resolved` cache holds) with the
//      PRE-playback view state, and the batched metadata read with the truth. A tile that
//      reads its watch state off the cache fails here.
//
// Both halves are offline: part 1 replays the synthetic engine corpus, part 2 spawns the real
// server against a stub Plex on 127.0.0.1. No token, no network.
//
// Run:  server/node_modules/.bin/tsx e2e/finished-live-test.ts   (from the repo root; non-zero on failure)
process.env.PLAYBACK_FSM = 'true';
process.env.RESUME_ON_ADVANCE = 'false';
process.env.ADB_ENABLED = 'false';
process.env.MQTT_HOST = ''; // no import-time broker connect (mqttc.js guards on HOST)

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { SESSION_CTL, stubSessionDeps, useFixtures, resetSession } from './stubs/session-harness.mjs';
import { killServer, spawnServer } from './stubs/server-process.mjs';
import {
  FRESH_RK, QUEUES_YAML, RESUMING_RK, SETS_YAML, WATCHED_RK, startStubPlex,
} from './stubs/plex-watch-state.mjs';

stubSessionDeps();

const FAILS: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

// --------------------------------------------------------------------------- //
// 1. reconcileQueue: the credits roll, the file agrees, nothing plays
// --------------------------------------------------------------------------- //
// Same corpus facts keep-completed-test.ts leans on: "Movie C (2003)" is finished for the
// admin account (so it is the entry the rule must mark), "Movie A (2001)" is unwatched (so
// the queue still has something to play and the set is not trivially empty).
const SETS = `sets:
  - id: consuming
    label: Consuming Queue
    source: queue
    sections: [1, 5]
  - id: keeper
    label: Playlist Queue
    source: queue
    sections: [1, 5]
    keep_completed: true
  - id: reelset
    label: Theater Demo
    source: queue
    sections: [1, 5]
    reel: true
`;
const ENTRIES = ['  - "Movie A (2001)"', '  - "Movie C (2003)"'].join('\n');
const QUEUES = ['consuming:', ENTRIES, 'keeper:', ENTRIES, 'reelset:', ENTRIES, ''].join('\n');
const FX = useFixtures({ sets: SETS, queues: QUEUES });

const finished = await import('../server/src/finished.js');

async function reconcile(setName: string) {
  writeFileSync(FX.queuesPath, QUEUES);
  resetSession();
  const res = await finished.reconcileQueue(setName);
  return { res, yaml: readFileSync(FX.queuesPath, 'utf8') };
}

const consuming = await reconcile('consuming');
ok('a finished entry is marked done with no session at all',
  consuming.yaml.includes('done: true'), consuming.yaml);
ok('reconciling plays NOTHING',
  SESSION_CTL.drives.length === 0 && SESSION_CTL.plays.length === 0,
  JSON.stringify({ drives: SESSION_CTL.drives, plays: SESSION_CTL.plays }));

const keeper = await reconcile('keeper');
ok('a keep_completed set is still never marked', !keeper.yaml.includes('done: true'), keeper.yaml);

const reelset = await reconcile('reelset');
ok('a reel is still never marked', !reelset.yaml.includes('done: true'), reelset.yaml);

const unknown = await finished.reconcileQueue('no-such-set');
ok('an unknown set reconciles to nothing rather than throwing', unknown.reconciled === false);

// --------------------------------------------------------------------------- //
// 2. /api/queues reports isFinished, from LIVE state rather than the tile cache
// --------------------------------------------------------------------------- //
const PORT = 18793;
const PLEX_PORT = 18794;
const Q_PATH = '/tmp/queues-finished-live.yaml';
const S_PATH = '/tmp/sets-finished-live.yaml';

const plex = startStubPlex(PLEX_PORT);
await plex.ready;

writeFileSync(S_PATH, SETS_YAML);
writeFileSync(Q_PATH, QUEUES_YAML);
rmSync('/tmp/cache-finished-live.sqlite', { force: true });

const child = spawnServer({
  env: {
    ...process.env,
    WEB_PORT: String(PORT),
    QUEUES_PATH: Q_PATH,
    SETS_PATH: S_PATH,
    HISTORY_PATH: '/tmp/history-finished-live.json',
    CACHE_PATH: '/tmp/cache-finished-live.sqlite',
    PLEX_API_SERVER_URL: `http://127.0.0.1:${PLEX_PORT}`,
    PLEX_TOKEN: 'offline-test-token',
    MQTT_HOST: '',
  },
  stdio: 'ignore',
});

try {
  let items: Record<string, any>[] = [];
  for (let i = 0; i < 50; i++) {
    try {
      const body = await fetch(`http://localhost:${PORT}/api/queues`).then((r) => r.json()) as any;
      items = body.sets.movies.items;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const byKey = (rk: string) => items.find((i) => String(i.ratingKey) === rk) || {};
  ok(`the queue resolves its three entries (${items.length})`, items.length === 3);

  const watched = byKey(WATCHED_RK);
  ok('a film finished since the last scan reads Completed', watched.isFinished === true,
    JSON.stringify(watched));
  ok('…and the file still says nothing — this is the LIVE answer, not the flag',
    watched.done === false && !readFileSync(Q_PATH, 'utf8').includes('done: true'));

  ok('an unwatched film is not Completed', byKey(FRESH_RK).isFinished === false);

  // The Prison School rule, at the movie level: in history, but sitting at a resume point.
  // "In Progress" wins, and a rewatch must never be reported as finished.
  const resuming = byKey(RESUMING_RK);
  ok('a film being watched again is In Progress, not Completed',
    resuming.isFinished === false && resuming.partiallyWatched === true, JSON.stringify(resuming));
  ok('…and it carries the live resume offset',
    resuming.viewOffset === 1060898, JSON.stringify(resuming));

  ok('the live view state came from the batched metadata read',
    plex.hits.some((p: string) => /^\/library\/metadata\/[\d,]+$/.test(p)), plex.hits.join(' '));
} finally {
  killServer(child);
  await plex.close();
}

console.log(FAILS.length ? `FAILURES: ${FAILS.length}` : 'done');
process.exit(FAILS.length ? 1 : 0);
