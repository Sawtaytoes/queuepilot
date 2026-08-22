// Offline gate: "Completed" goes away by itself when the next episode airs.
//
// The bug, reported from the live app 2026-08-22, on the SAME collection the 2026-08-15
// revival decision was written about. Its S2E7 aired; the tile read:
//
//     Trapped in a Dating Sim … 2 (2026)
//     E7 · Episode 7            <- resolved live, so it already knew
//     [Completed]  [2x as often]
//
// The engine was right — `nextQueue` revives a `done` entry that resolves to anything
// playable, so the entry would have played on the next scan. Nothing was going to say so
// first: `done` is only written by a scan, an airing episode triggers none, and the grid read
// the flag. So the tile greyed itself out and wore a Completed badge directly above the line
// naming the episode it was about to play.
//
// `/api/queues` now answers `isRevived` — the mirror of `isFinished`, the same live rule
// pointing the other way — and the badge keys off both. Pinned here:
//
//   1. A done entry with a fresh episode reports `isRevived` and is not Completed.
//   2. A HAND-marked `done: true` (no `done_at`) is a deliberate skip and keeps its badge,
//      exactly as the resolver keeps skipping it.
//   3. A genuinely finished entry is untouched.
//   4. The FILE is not written. This is a prediction, not a scan.
//
// Run:  server/node_modules/.bin/tsx e2e/returning-show-badge-test.ts   (from the repo root)
process.env.MQTT_HOST = ''; // no import-time broker connect (mqttc.js guards on HOST)

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { killServer, spawnServer } from './stubs/server-process.mjs';
import {
  FINISHED_RK, QUEUES_YAML, RETURNING_RK, SETS_YAML, SKIPPED_RK, startStubPlex,
} from './stubs/plex-returning-show.mjs';

const FAILS: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

const PORT = Number(process.env.WEB_PORT || 18797);
const PLEX_PORT = Number(process.env.PLEX_STUB_PORT || 18798);
const Q_PATH = '/tmp/queues-returning-show.yaml';
const S_PATH = '/tmp/sets-returning-show.yaml';

writeFileSync(Q_PATH, QUEUES_YAML);
writeFileSync(S_PATH, SETS_YAML);
for (const p of [`${Q_PATH}.lock`, `${S_PATH}.lock`, '/tmp/cache-returning-show.sqlite']) {
  rmSync(p, { force: true });
}

const plex = startStubPlex(PLEX_PORT);
await plex.ready;

const child = spawnServer({
  env: {
    ...process.env,
    WEB_PORT: String(PORT),
    QUEUES_PATH: Q_PATH,
    SETS_PATH: S_PATH,
    HISTORY_PATH: '/tmp/history-returning-show.json',
    CACHE_PATH: '/tmp/cache-returning-show.sqlite',
    PLEX_API_SERVER_URL: `http://127.0.0.1:${PLEX_PORT}`,
    PLEX_TOKEN: 'offline-test-token',
    MQTT_HOST: '',
  },
  stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore',
});

/** One tile as this test reads it. */
interface Tile {
  ratingKey?: string | null;
  done?: boolean;
  isFinished?: boolean;
  isRevived?: boolean;
  nextEp?: { episode?: number } | null;
}

try {
  let items: Tile[] = [];
  for (let i = 0; i < 60; i++) {
    try {
      const body = await fetch(`http://localhost:${PORT}/api/queues`).then((r) => r.json()) as {
        sets: Record<string, { items: Tile[] }>;
      };
      items = body.sets.anime?.items ?? [];
      if (items.length) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const byKey = (rk: string): Tile => items.find((i) => String(i.ratingKey) === rk) || {};
  ok(`the queue resolves its three entries (${items.length})`, items.length === 3);

  const returning = byKey(RETURNING_RK);
  ok('the returning show has a fresh episode to play', returning.nextEp?.episode === 3,
    JSON.stringify(returning));
  ok('…so the next scan will revive it, and the grid says so now',
    returning.isRevived === true, JSON.stringify(returning));
  ok('…while the file still says done — this is the PREDICTION, not the flag',
    returning.done === true);

  const skipped = byKey(SKIPPED_RK);
  ok('a hand-marked done entry has the same fresh episode', skipped.nextEp?.episode === 3,
    JSON.stringify(skipped));
  ok('…and is NOT revived: no done_at means the owner skipped it on purpose',
    skipped.isRevived === false, JSON.stringify(skipped));

  const finished = byKey(FINISHED_RK);
  ok('a genuinely finished show has nothing left', finished.nextEp == null);
  ok('…and keeps its Completed badge', finished.isRevived === false, JSON.stringify(finished));

  ok('nothing wrote the file — every entry is still done',
    (readFileSync(Q_PATH, 'utf8').match(/done: true/g) || []).length === 3);
} finally {
  killServer(child);
  await plex.close();
}

console.log(FAILS.length ? `FAILURES: ${FAILS.length}` : 'done');
process.exit(FAILS.length ? 1 : 0);
