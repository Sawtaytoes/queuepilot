// D3 curated-resolver parity (follow-on #2): prove server/src/engine/resolve.js resolves a
// curated QUEUE and a REEL the same as queue_builder/plex.py, over the SYNTHETIC corpus (owner
// decision 2026-08-07, docs/d3-engine-parity-corpus.md — no real library data). The Python side is
// the oracle:
//   python -m queue_builder.cli next-queue-json bobq   (real next_queue, on a throwaway copy)
//   python -m queue_builder.cli reel-json      demo    (real build_reel)
// vs the Node resolver replaying the same corpus. Both are DETERMINISTIC: the queue is non-anime
// (no shuffle) and the reel is file-order, so the returned dicts compare byte-for-byte. next_queue's
// YAML side effects (mark_done/sweep) are D4 and are NOT compared here — only the resolution result.
//
// Run locally: PYTHONPATH=/tmp/pylibs:. node e2e/curated-parity.mjs   (needs ruamel importable).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(REPO, 'e2e', 'fixtures');
const CORPUS = path.join(FIX, 'engine-corpus');
const SETS = path.join(FIX, 'engine.sets.yaml');
const QUEUES = path.join(FIX, 'engine.queues.yaml');

// (Re)generate the synthetic corpus + its sets.yaml/queues.yaml — hermetic, pure Python.
execFileSync('python3', ['e2e/gen-synthetic-corpus.py', CORPUS], { cwd: REPO, stdio: 'inherit' });

// env.js / config.js read process.env at module-eval → set the paths BEFORE importing the port.
process.env.SETS_PATH = SETS;
process.env.QUEUES_PATH = QUEUES;
const routing = await import('../server/src/engine/routing.js');
const select = await import('../server/src/engine/select.js');
const resolve = await import('../server/src/engine/resolve.js');
const { replayClient } = await import('../server/src/engine/plex-replay.js');

const PY_ENV = {
  ...process.env,
  SETS_PATH: SETS,
  QUEUES_PATH: QUEUES,
  PLEX_REPLAY_DIR: CORPUS,
  PLEX_API_SERVER_URL: 'https://plex.invalid', // guarantee no live call slips through
  PLEX_TOKEN: 'WRONG',
};
const pyCli = (...args) =>
  JSON.parse(execFileSync('python3', ['-m', 'queue_builder.cli', ...args],
    { cwd: REPO, env: PY_ENV, encoding: 'utf8' }).trim());

// Canonical JSON (recursively sorted keys) so key-order/whitespace never causes a false mismatch.
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
const normLast = (l) => (l ? { title: l.title, type: l.type, ratingKey: String(l.ratingKey) } : null);

const client = replayClient(CORPUS);
const reg = routing.loadSets(SETS);

// Node next_queue (deterministic queue), projected to the oracle's shape.
async function nodeNextQueue(setName) {
  const cfg = reg.sets[setName];
  const binding = routing.bindingFor(cfg);
  const watched = await select.watchedForSet(client, cfg, binding);
  const token = await client.accountToken(cfg.user_uuid);
  const res = await resolve.nextQueue(client, setName, cfg, resolve.loadEntries(setName), watched, token);
  return {
    set: res.set,
    play: res.play.map((e) => String(e.ratingKey)),
    last: normLast(res.last),
    done: res.done,
    unresolved: res.unresolved,
    remaining: res.remaining,
    offset: res.offset,
  };
}

// Node build_reel (deterministic file order), projected to the oracle's shape.
async function nodeReel(setName) {
  const cfg = reg.sets[setName];
  const token = await client.accountToken(cfg.user_uuid);
  const res = await resolve.buildReel(client, setName, cfg, resolve.loadEntries(setName), token);
  return {
    set: res.set,
    play: res.play.map((e) => ({ ratingKey: String(e.ratingKey), title: e.title ?? null })),
    last: normLast(res.last),
    unresolved: res.unresolved,
    remaining: res.remaining,
  };
}

let failures = 0;
function check(label, want, got, describe) {
  if (canon(want) === canon(got)) {
    console.log(`  ✓ ${label}: ${describe(got)}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}\n      python: ${canon(want)}\n      node:   ${canon(got)}`);
  }
}

console.log('=== curated parity: next_queue (Node resolve.js ↔ python cli next-queue-json) ===');
const wantQ = pyCli('next-queue-json', 'bobq');
wantQ.last = normLast(wantQ.last);
wantQ.play = wantQ.play.map(String);
check('bobq', wantQ, await nodeNextQueue('bobq'), (r) =>
  `play=[${r.play.join(',')}] last=${r.last ? r.last.title : '∅'} done=[${r.done.join(', ')}] `
  + `unresolved=[${r.unresolved.join(', ')}] remaining=${r.remaining} offset=${r.offset}`);

console.log('=== curated parity: build_reel (Node resolve.js ↔ python cli reel-json) ===');
const wantR = pyCli('reel-json', 'demo');
wantR.last = normLast(wantR.last);
wantR.play = wantR.play.map((e) => ({ ratingKey: String(e.ratingKey), title: e.title ?? null }));
check('demo', wantR, await nodeReel('demo'), (r) =>
  `play=[${r.play.map((e) => e.ratingKey).join(',')}] (${r.play.length} items) `
  + `unresolved=[${r.unresolved.join(', ')}]`);

console.log(failures ? `\nFAILED: ${failures} mismatch(es)` : '\nOK: Node curated resolver matches the Python oracle');
process.exit(failures ? 1 : 0);
