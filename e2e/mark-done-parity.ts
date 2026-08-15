// D4: Node markDone/clearDone/sweepCompleted match Python queues.py behaviour on the
// same throwaway queues.yaml (comment-preserving writers, done_at stamp, TTL sweep).
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { QueueEntry } from '../server/src/types.js';

const dir = mkdtempSync(path.join(tmpdir(), 'mark-done-'));
const Q = path.join(dir, 'queues.yaml');
const NOW = 1_700_000_000;

const SEED = `# wishlist
bob:
  - "Movie A"
  - 2002
  - title: Movie C
    year: 1999
  - "Keep Me"
`;

writeFileSync(Q, SEED);

process.env.QUEUES_PATH = Q;
const queues = await import('../server/src/queues.js');

let fails = 0;
// `cond` is `unknown`, not `boolean`: every call site below passes a TRUTHY expression
// (`a && a.done === true && …`), and narrowing the parameter would force a `Boolean(...)`
// wrapper onto assertions that must not be rewritten.
function ok(label: string, cond: unknown, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { fails += 1; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

/**
 * A `listSet()` row widened by the two fields this file's assertions probe but `QueueEntry`
 * does not declare: `value.title` — written only once `markDone` rewrites a bare scalar into
 * a mapping — and `raw`, which has NEVER existed on the row. The original reads `raw` as
 * `undefined` and falls through to `''`; the term is kept rather than dropped, because
 * dropping it would silently change what the assertion covers.
 */
type ProbedEntry = QueueEntry & { value?: { title?: unknown }; raw?: unknown };
const findEntry = (rows: readonly QueueEntry[], key: string): ProbedEntry | undefined =>
  rows.find((e) => e.key === key) as ProbedEntry | undefined;

console.log('=== D4 markDone / clearDone / sweep ===');
const r1 = await queues.markDone('bob', ['title:Movie A', 'rk:2002'], NOW);
ok('markDone changes', r1.changed === true);
const list = await queues.listSet('bob');
const a = findEntry(list, 'title:Movie A');
const b = findEntry(list, 'rk:2002');
const c = findEntry(list, 'title:Movie C');
ok('Movie A done', a && a.done === true && a.doneAt === NOW);
ok('2002 done', b && b.done === true && b.doneAt === NOW);
ok('Movie C not done', c && c.done === false);
ok('title preserved after scalar wrap', a && String(a.value?.title || a.raw || '').includes('Movie A'));

const r2 = await queues.clearDone('bob', ['title:Movie A']);
ok('clearDone changes', r2.changed === true);
const list2 = await queues.listSet('bob');
const a2 = findEntry(list2, 'title:Movie A');
ok('Movie A undoned', a2 && a2.done === false && a2.doneAt == null);
ok('2002 still done', list2.find((e) => e.key === 'rk:2002')?.done === true);

// sweep: re-mark A with old done_at via markDone then age it by rewriting? use sweep with now
await queues.markDone('bob', ['title:Movie A'], NOW - 100_000);
const sw = await queues.sweepCompleted('bob', {
  removeCompletedAfter: '24h',
  now: NOW,
});
// Movie A done_at is NOW-100000 (~27h ago) → removed; 2002 done at NOW → kept
ok('sweep removed past-TTL', sw.removed >= 1);
const list3 = await queues.listSet('bob');
ok('Movie A gone after sweep', !list3.some((e) => e.key === 'title:Movie A'));
ok('2002 still present', list3.some((e) => e.key === 'rk:2002'));
ok('Keep Me still present', list3.some((e) => e.key === 'title:Keep Me'));

// YAML still readable
const text = readFileSync(Q, 'utf8');
ok('wishlist comment survived', text.includes('wishlist'));
ok('Movie C year preserved', text.includes('1999') || text.includes('Movie C'));

rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\nFAILED: ${fails}` : '\nOK: D4 Node queue write-side');
process.exit(fails ? 1 : 0);
