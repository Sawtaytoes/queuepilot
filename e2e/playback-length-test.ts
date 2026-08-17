// PLAYBACK LENGTH — how many items a set plays in one sitting, for EVERY kind of set.
//
// Four code paths independently answered this and three hardcoded it, so the thing that has to
// hold is not "the number is read" but "the number is read in the same way everywhere, and no
// existing set moves on deploy". That second half is what this pins hardest: every kind's
// `defaultFor` is the behaviour it already had, so a file that never says `length:` builds the
// same lineup after this change as before it.
//
// Run: server/node_modules/.bin/tsx e2e/playback-length-test.ts   (repo root; non-zero on failure)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { errMessage } from '../server/src/errors.js';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'playlen-'));
const SETS_PATH = path.join(SCRATCH, 'sets.yaml');
process.env.SETS_PATH = SETS_PATH;
process.env.QUEUES_PATH = path.join(SCRATCH, 'queues.yaml');
process.env.CACHE_PATH = path.join(SCRATCH, 'cache.sqlite');
process.env.PROVIDERS_PATH = path.join(SCRATCH, 'providers.yaml');
process.env.PROVIDERS_SECRETS_PATH = path.join(SCRATCH, 'providers.secrets.yaml');
// Pinned, not inherited: these are configurable, so a deployment that moves them must not
// silently move this test's expectations with them.
process.env.ROTATION_LENGTH = '12';
process.env.ROTATION_LENGTH_MAX = '200';

writeFileSync(process.env.QUEUES_PATH, '{}\n');
writeFileSync(
  SETS_PATH,
  'sets:\n  - id: seed\n    label: Seed\n    kind: cartoons\n    source: rotation\n    sections: [1]\n',
);

const FAILS: string[] = [];
const ok = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}  -- ${errMessage(e)}`);
    FAILS.push(name);
  }
};

const {
  INFINITE, defaultFor, initialQueueSize, isTargetMet, needsTopup, playbackLength,
} = await import('../server/src/engine/playbackLength.js');
const sets = await import('../server/src/sets.js');

const blockFor = (id: string): string => {
  const after = readFileSync(SETS_PATH, 'utf8').split(`\n- id: ${id}\n`)[1];
  assert.ok(after !== undefined, `set ${id} is not in the file`);
  return after.split('\n- id:')[0] ?? '';
};

// --------------------------------------------------------------------------- //
// defaults — the whole no-behaviour-change claim rests on these four
// --------------------------------------------------------------------------- //
console.log('=== every kind keeps the length it already had ===');

await ok('a filtered pool on progress follows the env window', () => {
  assert.equal(defaultFor({ behavior: 'progress', source: 'rotation' }), 12);
});

await ok('a REWATCH pool follows 1 — it returned exactly one film, hardcoded', () => {
  assert.equal(defaultFor({ behavior: 'rewatch', source: 'rotation' }), 1);
  // …and via the legacy `mode:` spelling, which older files still use.
  assert.equal(defaultFor({ mode: 'rewatch', source: 'rotation' }), 1);
});

await ok('a CURATED pool follows the window — it read ROTATION_LENGTH directly', () => {
  assert.equal(defaultFor({ kind: 'anime', source: 'queue' }), 12);
});

await ok('an ORDERED queue follows 1 — it played its head entry and stopped', () => {
  assert.equal(defaultFor({ kind: 'movies', source: 'queue' }), 1);
});

// --------------------------------------------------------------------------- //
// resolution
// --------------------------------------------------------------------------- //
console.log('=== resolving a stored value ===');

await ok('a number wins over the default', () => {
  assert.equal(playbackLength({ behavior: 'rewatch', length: 3, source: 'rotation' }), 3);
});

await ok('`infinite` is null, and is NOT a number anyone can typo into', () => {
  assert.equal(playbackLength({ length: INFINITE, source: 'rotation' }), null);
  assert.equal(playbackLength({ length: 'INFINITE', source: 'rotation' }), null);
  // 0 is not infinite. A falsy count already reads as *uncapped* elsewhere in the engine, so a
  // typo landing here must fall back to the default rather than become a binge.
  assert.equal(playbackLength({ behavior: 'rewatch', length: 0, source: 'rotation' }), 1);
  assert.equal(playbackLength({ length: 999999, source: 'rotation' }), 200);
});

await ok('junk falls back rather than throwing — a dead card is worse', () => {
  assert.equal(playbackLength({ length: 'lots', source: 'rotation' }), 12);
  assert.equal(playbackLength({ length: '', source: 'rotation' }), 12);
  assert.equal(playbackLength(null), 1);
});

await ok('LEGACY `refill: true` reads as infinite, so the live Shorts card is untouched', () => {
  // The 2026-08-17 spelling. The owner's card is on disk RIGHT NOW as
  // `length: 12, refill: true` and must keep refilling without its file being edited.
  assert.equal(playbackLength({ length: 12, refill: true, source: 'rotation' }), null);
  assert.equal(playbackLength({ refill: true, source: 'rotation' }), null);
});

// --------------------------------------------------------------------------- //
// what it means downstream
// --------------------------------------------------------------------------- //
console.log('=== queue size and derived top-up ===');

await ok('the queue is never seeded with more than one window', () => {
  assert.equal(initialQueueSize(null), 12); // infinite
  assert.equal(initialQueueSize(50), 12);
  assert.equal(initialQueueSize(8), 8);
  assert.equal(initialQueueSize(1), 1);
});

await ok('top-up is DERIVED, and a short sitting never tops up', () => {
  assert.equal(needsTopup(null), true); // infinite
  assert.equal(needsTopup(50), true); // longer than a window
  assert.equal(needsTopup(12), false); // exactly a window
  assert.equal(needsTopup(8), false);
  assert.equal(needsTopup(1), false);
});

await ok('a finite target stops topping up once it has been handed over', () => {
  assert.equal(isTargetMet(20, 12), false);
  assert.equal(isTargetMet(20, 20), true);
  assert.equal(isTargetMet(20, 24), true); // Plex accepted more than we asked
  assert.equal(isTargetMet(null, 999), false); // infinite is never met
});

// --------------------------------------------------------------------------- //
// storage
// --------------------------------------------------------------------------- //
console.log('=== storage ===');

const rotation = (label: string, knobs: Record<string, unknown> = {}) => ({
  behavior: 'progress',
  blocklist: [],
  item_sections: [],
  kind: 'cartoons',
  label,
  movie_excludes: [],
  sections: [1],
  source: 'rotation',
  ...knobs,
});

await ok('`infinite` is written as the NAMED value', async () => {
  const { id } = await sets.createSet(rotation('Infinite Pool', { length: INFINITE }));
  assert.match(blockFor(id), /length: infinite/);
  const reg = await sets.getRegistry();
  assert.equal(reg.sets.find((x) => x.id === id)?.length, INFINITE);
});

await ok('saving `infinite` RETIRES the legacy refill key', async () => {
  const { id } = await sets.createSet(rotation('Migrate Me', { refill: true }));
  assert.match(blockFor(id), /refill: true/);
  // The registry already reads it as infinite, before anything is rewritten…
  const before = await sets.getRegistry();
  assert.equal(before.sets.find((x) => x.id === id)?.length, INFINITE);
  // …and the first save through the editor writes the new spelling and drops the old one.
  await sets.updateSet(id, { length: INFINITE });
  const yaml = blockFor(id);
  assert.match(yaml, /length: infinite/);
  assert.doesNotMatch(yaml, /refill:/);
});

await ok('the sparse rule follows the KIND, not one env constant', async () => {
  // A rewatch pool's default is 1, so storing 1 says nothing…
  const rw = await sets.createSet(rotation('Rewatch', { behavior: 'rewatch' }));
  await sets.updateSet(rw.id, { length: 1 });
  assert.doesNotMatch(blockFor(rw.id), /length:/);
  // …but the same 1 on a PROGRESS pool is a real override, because its default is 12.
  const pg = await sets.createSet(rotation('Progress'));
  await sets.updateSet(pg.id, { length: 1 });
  assert.match(blockFor(pg.id), /length: 1/);
});

await ok('power-off is opt-in and stored by absence', async () => {
  const { id } = await sets.createSet(rotation('Lights Out', { power_off_when_done: true }));
  assert.match(blockFor(id), /power_off_when_done: true/);
  assert.equal((await sets.getRegistry()).sets.find((x) => x.id === id)?.power_off_when_done, true);
  await sets.updateSet(id, { power_off_when_done: false });
  assert.doesNotMatch(blockFor(id), /power_off_when_done/);
});

await ok('an untouched pool gains no keys when something unrelated is saved', async () => {
  const { id } = await sets.createSet(rotation('Untouched'));
  const reg = await sets.getRegistry();
  const entry = reg.sets.find((x) => x.id === id)!;
  // The editor posts the EFFECTIVE length on every save — here, the kind's own default.
  await sets.updateSet(id, {
    label: 'Untouched Renamed',
    length: entry.length_default,
    power_off_when_done: false,
  });
  const yaml = blockFor(id);
  assert.match(yaml, /label: Untouched Renamed/);
  assert.doesNotMatch(yaml, /length:|power_off_when_done:|refill:/);
});

await ok('the registry tells the editor what null resolves to', async () => {
  const rw = await sets.createSet(rotation('Default Rewatch', { behavior: 'rewatch' }));
  const pg = await sets.createSet(rotation('Default Progress'));
  const reg = await sets.getRegistry();
  assert.equal(reg.sets.find((x) => x.id === rw.id)?.length_default, 1);
  assert.equal(reg.sets.find((x) => x.id === pg.id)?.length_default, 12);
  // Both still report `length: null` — they have never said.
  assert.equal(reg.sets.find((x) => x.id === rw.id)?.length, null);
});

console.log(FAILS.length ? `\n${FAILS.length} FAILED` : '\nplayback length OK');
process.exit(FAILS.length ? 1 : 0);
