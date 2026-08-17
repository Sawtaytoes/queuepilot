// `length:` — how many items a rotation channel's LINEUP holds. The SIZE to `episodes`'s
// per-entry share.
//
// Why it exists (owner, 2026-08-17): ROTATION_LENGTH is global, so the Younger Kids' Shorts
// card and the Shows card both queued 12. At ~22 minutes an episode that is four hours; at
// ~3 minutes a short it is half an hour, and the kids ran the card dry mid-evening and had to
// re-scan. The number was never wrong — sharing ONE number across cards of different runtime
// was.
//
// This pins BOTH halves, because a passthrough that the loader forgets does not throw: it
// reads `undefined` at the consumer and silently disables the feature (the same failure that
// ran 12 profile-gated sets ungated — see e2e/set-passthrough-parity.ts). So:
//   1. loadSets() actually CARRIES `length` onto the cfg, and
//   2. rotationLength() derives the right number from that cfg.
// Testing only (2) would pass forever against a field nothing populates.
//
// Run: server/node_modules/.bin/tsx e2e/rotation-length-test.ts
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// env.js and routing.js read these at module eval → set them BEFORE importing either. run.sh
// exports a SETS_PATH of its own for the UI suites; this overrides it for this process only.
process.env.SETS_PATH = path.join(REPO, 'e2e', 'fixtures', 'rotation-length.sets.yaml');
process.env.QUEUES_PATH = '/nonexistent-so-loadEntries-is-never-consulted.yaml';
// Pinned explicitly rather than inherited: the whole point is that these are configurable, so
// a deployment that moves them must not silently move this test's expectations with them.
process.env.ROTATION_LENGTH = '12';
process.env.ROTATION_LENGTH_MAX = '200';

const routing = await import('../server/src/engine/routing.js');
const { rotationLength } = await import('../server/src/engine/rotation.js');

const registry = routing.loadSets();
assert.ok(registry, 'fixture did not load — loadSets() returned null (file absent or empty)');
const sets = registry.sets;

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  try {
    assert.deepEqual(actual, expected);
    console.log(`  ok   ${name}`);
  } catch {
    console.log(`  FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed += 1;
  }
};

console.log('=== loadSets carries `length` onto the cfg ===');
// ABSENT, not null: the loader mirrors config.py's truthiness for optional passthroughs, and
// the difference between `undefined` and `null` here is the difference between "follow the
// env default" and "someone stored a value". Asserted so a later normalize-to-null is caught.
check('no key => undefined', sets.default_length?.length, undefined);
check('length: 30 => "30"', sets.short_runtime?.length, '30');
check('length: 5000 carried verbatim (clamped at read)', sets.over_cap?.length, '5000');
check('length: 0 carried verbatim', sets.zero_length?.length, '0');
check('length: lots carried verbatim', sets.junk_length?.length, 'lots');

console.log('=== rotationLength() resolves set > env ===');
check('absent => env ROTATION_LENGTH', rotationLength(sets.default_length), 12);
check('30 => 30 (the Shorts case)', rotationLength(sets.short_runtime), 30);
// Clamped at READ and not only at write: sets.yaml is hand-edited over SMB at least as often
// as it is saved through the UI, so the engine cannot assume the writer's ceiling ever ran.
check('5000 => ROTATION_LENGTH_MAX', rotationLength(sets.over_cap), 200);
// The trap from docs/todos/batch-all-or-infinite.md: a falsy batch reads as UNCAPPED in
// resolve.ts's applyBatch, so 0 must fall back to the default here, never mean "infinite".
// When infinite lands it gets a NAMED sentinel (`all`) — not 0, and not 999.
check('0 => the default, NOT infinite', rotationLength(sets.zero_length), 12);
check('non-numeric => the default', rotationLength(sets.junk_length), 12);

console.log('=== rotationLength() tolerates a missing cfg ===');
// A dead card on the wall is worse than a default-length one, so every bad input falls back
// rather than throwing.
check('null cfg', rotationLength(null), 12);
check('undefined cfg', rotationLength(undefined), 12);
check('empty cfg', rotationLength({}), 12);

if (failed) {
  console.error(`\nrotation-length-test: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nrotation-length-test: all checks passed');
