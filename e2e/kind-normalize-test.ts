// Product kind + add_as + auto-rewatch helpers (decision 2026-08-23-kind-is-picks-or-rules).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'qp-kind-'));
// The lead cooldowns live in the BOOK OF RECORD now (WP-2), not in a `promote.sqlite` of
// their own, so `PROMOTE_PATH` is gone and this is what replaces it. It has to be set
// explicitly rather than derived: `STORE_PATH`'s default is derived from whichever YAML path
// the process was given, this suite gives none, and the fallback is `/config` — which is right
// in production and is not writable on a CI runner.
process.env.STORE_PATH = path.join(SCRATCH, 'queuepilot.sqlite');

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

// --- the WRITE side: what the editor posts must survive the round trip ------------- //
// The Type control posts `kind: picks` + an explicit `add_as`. createSet only ever stamped
// the lane that `kindForWrite` inferred from the OLD create values (movies / anime), so
// `add_as` was dropped and every new Picks queue read back as a Random pool with a
// 12-item playback default. That is the whole point of the control, so it is pinned here.
const setsPath = path.join(SCRATCH, 'sets.yaml');
writeFileSync(setsPath, 'sets:\n  - id: seed\n    label: Seed\n    kind: picks\n    add_as: priority\n    source: queue\n    sections: [1]\n');
process.env.SETS_PATH = setsPath;
process.env.QUEUES_PATH = path.join(SCRATCH, 'queues.yaml');
process.env.CACHE_PATH = path.join(SCRATCH, 'cache.sqlite');

const sets = await import('../server/src/sets.js');

await sets.createSet({ kind: 'picks', add_as: 'priority', label: 'Priority Q', sections: [1] });
await sets.createSet({ kind: 'picks', add_as: 'random', label: 'Random Q', sections: [1] });
// The legacy create values still work, and still imply their lane.
await sets.createSet({ kind: 'movies', label: 'Legacy Ordered', sections: [1] });
await sets.createSet({ kind: 'anime', label: 'Legacy Pool', sections: [1] });

const lanes = async () => {
  const reg = await sets.getRegistry();
  return new Map(reg.sets.map((s) => [s.id, s]));
};

let byId = await lanes();
assert.equal(byId.get('priority_q')?.add_as, 'priority');
// The lane drives the playback default: an ordered queue plays ONE entry, a pool fills a
// window. A dropped add_as moved a new priority queue from 1 to 12 without saying so.
assert.equal(byId.get('priority_q')?.length_default, 1);
assert.equal(byId.get('random_q')?.add_as, 'random');
assert.equal(byId.get('legacy_ordered')?.add_as, 'priority');
assert.equal(byId.get('legacy_pool')?.add_as, 'random');

// Every created set stores the product kind, never a legacy spelling.
for (const s of byId.values()) assert.equal(s.kind, 'picks');

// Edit path: switching the Type control rewrites the lane in place.
await sets.updateSet('random_q', { kind: 'picks', add_as: 'priority', label: 'Random Q' });
byId = await lanes();
assert.equal(byId.get('random_q')?.add_as, 'priority');

// A blank / off window is stored by ABSENCE, on both write paths.
await sets.createSet({ kind: 'picks', add_as: 'priority', label: 'Windowed', promote_window: '7d' });
await sets.createSet({ kind: 'picks', add_as: 'priority', label: 'Unwindowed', promote_window: 'never' });
byId = await lanes();
assert.equal(byId.get('windowed')?.promote_window, '7d');
assert.equal(byId.get('unwindowed')?.promote_window, null);

// Rotation channels have no lanes at all — the fields are rejected, not silently kept.
await sets.createSet({ source: 'rotation', kind: 'rules', label: 'Pool Channel' });
await assert.rejects(
  () => sets.updateSet('pool_channel', { add_as: 'priority' }),
  /only valid on picks/,
);

rmSync(SCRATCH, { recursive: true, force: true });
console.log('kind-normalize-test: ok');
