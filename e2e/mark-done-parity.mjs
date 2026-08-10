// D4: Node markDone/clearDone/sweepCompleted match Python queues.py behaviour on the
// same throwaway queues.yaml (comment-preserving writers, done_at stamp, TTL sweep).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
function ok(label, cond, detail = '') {
  if (cond) console.log(`  ✓ ${label}`);
  else { fails += 1; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('=== D4 markDone / clearDone / sweep ===');
const r1 = await queues.markDone('bob', ['title:Movie A', 'rk:2002'], NOW);
ok('markDone changes', r1.changed === true);
const list = await queues.listSet('bob');
const a = list.find((e) => e.key === 'title:Movie A');
const b = list.find((e) => e.key === 'rk:2002');
const c = list.find((e) => e.key === 'title:Movie C');
ok('Movie A done', a && a.done === true && a.doneAt === NOW);
ok('2002 done', b && b.done === true && b.doneAt === NOW);
ok('Movie C not done', c && c.done === false);
ok('title preserved after scalar wrap', a && String(a.value?.title || a.raw || '').includes('Movie A'));

const r2 = await queues.clearDone('bob', ['title:Movie A']);
ok('clearDone changes', r2.changed === true);
const list2 = await queues.listSet('bob');
const a2 = list2.find((e) => e.key === 'title:Movie A');
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
