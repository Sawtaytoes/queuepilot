// Engine test for the non-consuming `keep_completed` queue flag (decision
// 2026-08-07-non-consuming-keep-completed-queue-flag).
//
// Node port of the retired e2e/keep-completed-test.py (deleted with queue_builder/ on
// 2026-08-12). Two guarantees, both offline (Plex is the synthetic corpus, no token/network):
//
//   1. sets parsing: `keep_completed: true` lands on the cfg, and `reel: true` IMPLIES it.
//   2. the write side: a finished entry is marked `done` in queues.yaml for a NORMAL queue,
//      but NEVER for a keep_completed set nor a reel set. The Python test asserted this by
//      spying on queues.mark_done; here the REAL queues.js runs against a temp queues.yaml,
//      so the assertion is on the file the service would actually have written.
//
// Run:  node e2e/keep-completed-test.mjs   (from the repo root; non-zero on failure)
process.env.PLAYBACK_FSM = 'true';
process.env.RESUME_ON_ADVANCE = 'false'; // no seek-watcher timer in a unit test
process.env.ADB_ENABLED = 'false';

import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stubSessionDeps, useFixtures, resetSession } from './stubs/session-harness.mjs';

stubSessionDeps();

// The fixture paths must exist BEFORE server/src/{env,config,sets}.js are first evaluated —
// they read process.env at module-eval — so the sets/queues files are written up front and the
// engine imports come after.
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
// "Movie C (2003)" is finished for the corpus's admin account, so it is the entry that
// triggers the mark-done branch; "Movie A (2001)" is unwatched and keeps the queue playable.
const ENTRIES = ['  - "Movie A (2001)"', '  - "Movie C (2003)"'].join('\n');
const QUEUES = ['consuming:', ENTRIES, 'keeper:', ENTRIES, 'reelset:', ENTRIES, ''].join('\n');
const FX = useFixtures({ sets: SETS, queues: QUEUES });

const routing = await import('../server/src/engine/routing.js');
const session = await import('../server/src/session.js');

const FAILS = [];
function ok(name, cond, detail = '') {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

// --- 1. sets parsing: the flag round-trips and `reel` implies it ---------------------- //
const PARSE_YAML = `sets:
  - id: normalq
    label: Normal Queue
    source: queue
    sections: [1]
  - id: playlistq
    label: Playlist Queue
    source: queue
    sections: [1]
    keep_completed: true
  - id: demo
    label: Demo Reel
    source: queue
    sections: [1]
    reel: true
`;
const parseDir = mkdtempSync(path.join(tmpdir(), 'keep-parse-'));
const parsePath = path.join(parseDir, 'sets.yaml');
writeFileSync(parsePath, PARSE_YAML);
const reg = routing.loadSets(parsePath);
ok('sets.yaml parses', Boolean(reg));
ok('normal queue is NOT keep_completed', !reg.sets.normalq.keep_completed);
ok('keep_completed: true lands on the cfg', reg.sets.playlistq.keep_completed === true);
ok('reel: true IMPLIES keep_completed', reg.sets.demo.keep_completed === true);

// --- 2. the write side: done is persisted only for a CONSUMING queue ------------------ //
async function run(setName) {
  // Same fixture PATHS every time (env.js/config.js snapshot them at module-eval); only the
  // file contents are reset, so each scenario starts from a queue with nothing marked done.
  writeFileSync(FX.queuesPath, QUEUES);
  resetSession();
  const res = await session.startSession({ set: setName, kind: 'movie' });
  return { res, yaml: readFileSync(FX.queuesPath, 'utf8') };
}

const consuming = await run('consuming');
ok('consuming queue plays', consuming.res.ok === true, JSON.stringify(consuming.res));
ok('consuming queue marks the finished entry done', consuming.yaml.includes('done: true'),
  consuming.yaml);

const keeper = await run('keeper');
ok('keep_completed set still plays', keeper.res.ok === true, JSON.stringify(keeper.res));
ok('keep_completed set never marks done', !keeper.yaml.includes('done: true'), keeper.yaml);

const reelset = await run('reelset');
ok('reel set still plays', reelset.res.ok === true, JSON.stringify(reelset.res));
ok('reel set never marks done', !reelset.yaml.includes('done: true'), reelset.yaml);

console.log(FAILS.length ? `FAILURES: ${FAILS.length}` : 'done');
process.exit(FAILS.length ? 1 : 0);
