// Engine test for the FOUR completion modes, and for the third axis the picker added
// (decision 2026-09-08-completion-behaviour-is-one-picker-not-two-checkboxes).
//
// `e2e/keep-completed-test.ts` is the sibling and pins the two NON-CONSUMING modes: a
// `keep_completed` set and a `reel` set never write `done: true`. This file pins the two
// CONSUMING ones, which are the pair the new mode sits between:
//
//   * Consume — a finished entry is marked done and stays marked. The queue runs dry.
//   * Start over when exhausted — a finished entry is marked done exactly the same way, so
//     nothing repeats while anything is unwatched, and the LAST one finishing clears the lot.
//
// Three guarantees, all offline (Plex is the synthetic corpus, no token, no network):
//
//   1. sets parsing: `restart_when_exhausted: true` lands on the cfg, and the precedence
//      resolves a hand-written contradiction rather than refusing it — a set that never marks
//      an entry done can never exhaust, so `keep_completed` and `reel` both win over it.
//   2. the write side, over the REAL queues.js against a temp queues.yaml: a queue with
//      something still to play keeps its done flags, and a queue with NOTHING left comes back
//      cleared.
//   3. the SEAM: the clear is injected, so `resetQueueWatchedState` can replace it in one
//      call. This is the contract the seasonal-reset branch rebases onto.
//
// Run:  server/node_modules/.bin/tsx e2e/completion-mode-test.ts   (from the repo root; non-zero on failure)
process.env.PLAYBACK_FSM = 'true';
process.env.RESUME_ON_ADVANCE = 'false'; // no seek-watcher timer in a unit test
process.env.ADB_ENABLED = 'false';

import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stubSessionDeps, useFixtures, resetSession } from './stubs/session-harness.mjs';
import type { RoutingQueueCfg } from '../server/src/types.js';

stubSessionDeps();

// The fixture paths must exist BEFORE server/src/{env,config,sets}.js are first evaluated —
// they read process.env at module-eval — so the sets/queues files are written up front and the
// engine imports come after.
const SETS = `sets:
  - id: consuming
    label: Consuming Queue
    source: queue
    sections: [1, 5]
  - id: restarter
    label: Restarting Queue
    source: queue
    sections: [1, 5]
    restart_when_exhausted: true
  - id: restarter_partial
    label: Restarting Queue With Something Left
    source: queue
    sections: [1, 5]
    restart_when_exhausted: true
`;
// "Movie C (2003)" is finished for the corpus's admin account, so it is the entry that
// triggers the mark-done branch; "Movie A (2001)" is unwatched and keeps the queue playable.
const WATCHED = '  - {title: "Movie C (2003)"}';
const UNWATCHED = '  - {title: "Movie A (2001)"}';
const QUEUES = [
  'consuming:', UNWATCHED, WATCHED,
  // Nothing left to play: the round is over the moment the write side runs.
  'restarter:', WATCHED,
  // One entry finished, one still unwatched — NOT exhausted.
  'restarter_partial:', UNWATCHED, WATCHED,
  '',
].join('\n');
const FX = useFixtures({ sets: SETS, queues: QUEUES });

const routing = await import('../server/src/engine/routing.js');
const session = await import('../server/src/session.js');
const exhaustion = await import('../server/src/exhaustion.js');

const FAILS: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

/** Every fixture set here is `source: queue`, so the cfg union is narrowed once. */
const queueSet = (reg: { sets: Record<string, unknown> }, id: string): RoutingQueueCfg =>
  reg.sets[id] as RoutingQueueCfg;

// --- 1. sets parsing: the flag round-trips, and the precedence resolves ---------------- //
const PARSE_YAML = `sets:
  - id: normalq
    label: Normal Queue
    source: queue
    sections: [1]
  - id: restartq
    label: Restarting Queue
    source: queue
    sections: [1]
    restart_when_exhausted: true
  - id: playlist_and_restart
    label: Contradictory Queue
    source: queue
    sections: [1]
    keep_completed: true
    restart_when_exhausted: true
  - id: reel_and_restart
    label: Contradictory Reel
    source: queue
    sections: [1]
    reel: true
    restart_when_exhausted: true
`;
const parseDir = mkdtempSync(path.join(tmpdir(), 'completion-parse-'));
const parsePath = path.join(parseDir, 'sets.yaml');
writeFileSync(parsePath, PARSE_YAML);
// `loadSets` is nullable only for a MISSING/unparseable file — this one was just written above.
const reg = routing.loadSets(parsePath)!;
ok('sets.yaml parses', Boolean(reg));
ok('a normal queue does NOT restart', !queueSet(reg, 'normalq').restart_when_exhausted);
ok('restart_when_exhausted: true lands on the cfg',
  queueSet(reg, 'restartq').restart_when_exhausted === true);
// The contradiction is RESOLVED, not refused: both of these sets still parse, and both read as
// the non-consuming queue they behave as.
ok('keep_completed WINS over restart_when_exhausted',
  queueSet(reg, 'playlist_and_restart').restart_when_exhausted === false
  && queueSet(reg, 'playlist_and_restart').keep_completed === true);
ok('reel WINS over restart_when_exhausted',
  queueSet(reg, 'reel_and_restart').restart_when_exhausted === false
  && queueSet(reg, 'reel_and_restart').reel === true);

// --- 2. the write side: marked like a consuming queue, cleared when nothing is left ---- //
async function run(setName: string) {
  // Same fixture PATHS every time (env.js/config.js snapshot them at module-eval); only the
  // file contents are reset, so each scenario starts from a queue with nothing marked done.
  writeFileSync(FX.queuesPath, QUEUES);
  resetSession();
  const res = await session.startSession({ set: setName, kind: 'movie' });
  return { res, yaml: readFileSync(FX.queuesPath, 'utf8') };
}

// The control: the same corpus, the same entries, no flag. This is what "marks done" looks
// like, and the assertion below is that the restarting queue does exactly this and then some.
const consuming = await run('consuming');
ok('a consuming queue marks the finished entry done', consuming.yaml.includes('done: true'),
  consuming.yaml);

// Something is still unwatched, so the round is not over — the done flag stays exactly where a
// consuming queue would have left it. This is the half that proves the mode MARKS.
const partial = await run('restarter_partial');
ok('a restarting queue still marks done while anything is unwatched',
  partial.yaml.includes('done: true'), partial.yaml);

// Nothing left. The write side marks the last entry and then clears the queue, so the file
// comes back with no done flag at all — and NOT because it never wrote one, which is what
// `restarter_partial` above rules out.
const exhausted = await run('restarter');
ok('an exhausted restarting queue comes back cleared',
  !exhausted.yaml.includes('done: true'), exhausted.yaml);
ok('and it kept its entries — a restart is not a delete',
  exhausted.yaml.includes('Movie C (2003)'), exhausted.yaml);

// --- 3. the SEAM: the clear is injected, so the seasonal reset can own it -------------- //
//
// `resetQueueWatchedState(setId)` clears three stores — the done flags, the
// `queue_entry_history` rows and the `lead_cooldown` rows — and lives on another branch. This
// pins the shape it plugs into: ONE call replaces the clear, and the exhaustion rule keeps
// deciding WHEN.
const cleared: string[] = [];
exhaustion.setQueueWatchedStateReset(async (setName: string) => {
  cleared.push(setName);
});
const injected = await run('restarter');
ok('the injected reset is called, with the set name', cleared.join(',') === 'restarter',
  JSON.stringify(cleared));
ok('and the default clear no longer runs', injected.yaml.includes('done: true'),
  injected.yaml);

const notExhausted = await run('restarter_partial');
ok('a queue with something left never calls the reset', cleared.join(',') === 'restarter',
  JSON.stringify(cleared));
ok('and its file is untouched by the seam', notExhausted.yaml.includes('done: true'),
  notExhausted.yaml);

console.log(FAILS.length ? `FAILURES: ${FAILS.length}` : 'done');
process.exit(FAILS.length ? 1 : 0);
