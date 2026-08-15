// D3 curated-resolver parity (follow-on #2): prove server/src/engine/resolve.js resolves a
// curated QUEUE and a REEL the same as the retired queue_builder/plex.py did, over the SYNTHETIC
// corpus (owner decision 2026-08-07, docs/d3-engine-parity-corpus.md — no real library data).
// Expectations are that Python resolver's RECORDED answers, frozen in
// e2e/fixtures/golden/curated.json when Python was deleted (2026-08-12):
//   python -m queue_builder.cli next-queue-json bobq   (real next_queue, on a throwaway copy)
//   python -m queue_builder.cli reel-json      demo    (real build_reel)
// Both are DETERMINISTIC: the queue is non-anime (no shuffle) and the reel is file-order, so the
// dicts compare byte-for-byte. next_queue's YAML side effects (mark_done/sweep) are D4 and are NOT
// compared here — only the resolution result (e2e/mark-done-parity.ts covers the write side).
//
// Run locally: server/node_modules/.bin/tsx e2e/curated-parity.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(REPO, 'e2e', 'fixtures');
const CORPUS = path.join(FIX, 'engine-corpus');
const SETS = path.join(FIX, 'engine.sets.yaml');
const QUEUES = path.join(FIX, 'engine.queues.yaml');

// env.js / config.js read process.env at module-eval → set the paths BEFORE importing the port.
process.env.SETS_PATH = SETS;
process.env.QUEUES_PATH = QUEUES;
const routing = await import('../server/src/engine/routing.js');
const select = await import('../server/src/engine/select.js');
const resolve = await import('../server/src/engine/resolve.js');
const { replayClient } = await import('../server/src/engine/plex-replay.js');

const GOLDEN = JSON.parse(readFileSync(path.join(FIX, 'golden', 'curated.json'), 'utf8'));
// The golden is free-form recorded JSON whose shape differs per key, and every use below
// compares it through `canon()` rather than by field — so the return is deliberately `any`
// (the caller then reshapes `.last` / `.play` in place, as the oracle's own script did).
const pyCli = (...args: string[]): any => {
  const key = args.join('|');
  if (!(key in GOLDEN)) throw new Error(`no golden for ${key}`);
  // Structured-clone so a test that mutates its expectation can't poison a later lookup.
  return JSON.parse(JSON.stringify(GOLDEN[key]));
};

// Canonical JSON (recursively sorted keys) so key-order/whitespace never causes a false mismatch.
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${canon(rec[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The `last` field as BOTH oracles spell it once normalised — ratingKey stringified. */
interface LastItem { title: string; type: string; ratingKey: string }
const normLast = (l: { title?: unknown; type?: unknown; ratingKey?: unknown } | null | undefined):
LastItem | null => (
  l ? { title: l.title as string, type: l.type as string, ratingKey: String(l.ratingKey) } : null
);

const client = replayClient(CORPUS);
// Nullable only for a MISSING/unparseable sets.yaml, and `sets[id]` only for an id the file
// does not carry; both are committed fixtures, so each `!` fails exactly where the original did.
const reg = routing.loadSets(SETS)!;

// Node next_queue (deterministic queue), projected to the oracle's shape.
async function nodeNextQueue(setName: string) {
  const cfg = reg.sets[setName]!;
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
async function nodeReel(setName: string) {
  const cfg = reg.sets[setName]!;
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
function check<T>(label: string, want: unknown, got: T, describe: (got: T) => string): void {
  if (canon(want) === canon(got)) {
    console.log(`  ✓ ${label}: ${describe(got)}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}\n      golden: ${canon(want)}\n      node:   ${canon(got)}`);
  }
}

console.log('=== curated parity: next_queue (Node resolve.js ↔ recorded cli next-queue-json) ===');
const wantQ = pyCli('next-queue-json', 'bobq');
wantQ.last = normLast(wantQ.last);
wantQ.play = wantQ.play.map(String);
check('bobq', wantQ, await nodeNextQueue('bobq'), (r) =>
  `play=[${r.play.join(',')}] last=${r.last ? r.last.title : '∅'} done=[${r.done.join(', ')}] `
  + `unresolved=[${r.unresolved.join(', ')}] remaining=${r.remaining} offset=${r.offset}`);

console.log('=== curated parity: build_reel (Node resolve.js ↔ recorded cli reel-json) ===');
const wantR = pyCli('reel-json', 'demo');
wantR.last = normLast(wantR.last);
wantR.play = wantR.play.map((e: { ratingKey: unknown; title?: unknown }) =>
  ({ ratingKey: String(e.ratingKey), title: e.title ?? null }));
check('demo', wantR, await nodeReel('demo'), (r) =>
  `play=[${r.play.map((e) => e.ratingKey).join(',')}] (${r.play.length} items) `
  + `unresolved=[${r.unresolved.join(', ')}]`);

console.log(failures ? `\nFAILED: ${failures} mismatch(es)` : '\nOK: Node curated resolver matches the recorded Python oracle');
process.exit(failures ? 1 : 0);
