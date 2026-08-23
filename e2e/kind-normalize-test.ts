// Product kind + add_as + auto-rewatch helpers (decision 2026-08-23-kind-is-picks-or-rules).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'qp-kind-'));
process.env.PROMOTE_PATH = path.join(SCRATCH, 'promote.sqlite');

const {
  normalizeProductKind, normalizeAddAs, isRandomOrder, wireKindForSet,
  kindForWrite, isAutoRewatch,
} = await import('../server/src/kind.js');
const promote = await import('../server/src/promote.js');

assert.equal(normalizeProductKind('movies', 'queue'), 'picks');
assert.equal(normalizeProductKind('anime', 'queue'), 'picks');
assert.equal(normalizeProductKind('demo', 'queue'), 'picks');
assert.equal(normalizeProductKind('cartoons', 'rotation'), 'rules');
assert.equal(normalizeProductKind('movies', 'rotation'), 'rules'); // rewatch Movies channel
assert.equal(normalizeProductKind('picks'), 'picks');
assert.equal(normalizeProductKind('rules'), 'rules');

assert.equal(normalizeAddAs(undefined, { kind: 'movies', source: 'queue' }), 'priority');
assert.equal(normalizeAddAs(undefined, { kind: 'anime', source: 'queue' }), 'random');
assert.equal(normalizeAddAs('priority', { kind: 'picks' }), 'priority');
assert.equal(normalizeAddAs(undefined, { kind: 'picks', source: 'queue' }), 'random');
assert.equal(normalizeAddAs(undefined, { kind: null, source: 'queue' }), 'priority');
assert.equal(normalizeAddAs(undefined, { source: 'queue' }), 'priority');

assert.equal(isRandomOrder({ kind: 'anime', source: 'queue' }), true);
assert.equal(isRandomOrder({ kind: 'movies', source: 'queue' }), false);
assert.equal(isRandomOrder({ kind: null, source: 'queue' }), false);
assert.equal(isRandomOrder({ kind: 'picks', add_as: 'random', source: 'queue' }), true);
assert.equal(isRandomOrder({ kind: 'picks', add_as: 'priority', source: 'queue' }), false);
assert.equal(isRandomOrder({ kind: 'cartoons', source: 'rotation' }), false);

assert.equal(wireKindForSet({ kind: 'anime', source: 'queue' }), 'picks');
assert.equal(wireKindForSet({ kind: 'movies', source: 'rotation' }), 'rules');

assert.deepEqual(kindForWrite('anime', 'queue'), { kind: 'picks', add_as: 'random' });
assert.deepEqual(kindForWrite('movies', 'queue'), { kind: 'picks', add_as: 'priority' });
assert.deepEqual(kindForWrite('cartoons', 'rotation'), { kind: 'rules' });

assert.equal(isAutoRewatch({ kind: 'movie' }), true);
assert.equal(isAutoRewatch({ kind: 'rules', behavior: 'rewatch' }), true);
assert.equal(isAutoRewatch({ kind: 'rules' }), false);
assert.equal(isAutoRewatch({ kind: 'cartoons' }), false);

assert.equal(await promote.canLeadOnce('s1', 'e1', 3600_000), true);
await promote.recordLead('s1', 'e1');
assert.equal(await promote.canLeadOnce('s1', 'e1', 3600_000), false);

assert.equal(await promote.canLeadOnce('s1', 'e2', 3600_000), true);
await promote.clearLead('s1', 'e1');
assert.equal(await promote.canLeadOnce('s1', 'e1', 3600_000), true);

assert.equal(promote.parsePromoteWindow('24h'), 24 * 3600_000);
assert.equal(promote.parsePromoteWindow('7d'), 7 * 86_400_000);
assert.equal(promote.parsePromoteWindow(''), null);

promote._closeForTests();
rmSync(SCRATCH, { recursive: true, force: true });
console.log('kind-normalize-test: ok');
