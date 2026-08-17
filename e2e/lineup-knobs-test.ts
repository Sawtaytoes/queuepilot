// The WRITE side of the lineup knobs — `length`, `refill`, `on_complete` — now that the pool
// editor is the thing that sets them.
//
// e2e/rotation-length-test.ts and e2e/on-complete-test.ts already pin the READ side (the
// loader carries them onto the cfg, and the engine acts on them). Nothing pinned what a SAVE
// writes, and the editor changes what that has to mean:
//
//   * The editor posts EVERY knob it renders on every Save, including the ones the user never
//     touched. Without sparse storage, opening a pool to rename it would stamp `length: 12`,
//     `refill: false` and `on_complete: drop` onto a channel that said none of those — three
//     keys that say nothing, and a `length` that has silently stopped following the env
//     default if that ever moves. Same rule the entry counts use (decision
//     `2026-08-16-entry-count-follows-the-set-default`): EQUAL TO THE DEFAULT drops the key.
//
//   * `createSet` never handled these at all. A pool created from the editor with top-up
//     switched on came back with it switched off, and the only clue was the file — the
//     quietest possible failure, and the exact shape of the `providers` bug the Kavita-only
//     gate exists for.
//
// Runs offline against a scratch sets.yaml; no Plex, no network.
//
// Run:  server/node_modules/.bin/tsx e2e/lineup-knobs-test.ts   (repo root; non-zero on failure)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { errMessage } from '../server/src/errors.js';
import type { RotationSet } from '../server/src/types.js';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'lineup-'));
const SETS_PATH = path.join(SCRATCH, 'sets.yaml');
process.env.SETS_PATH = SETS_PATH;
process.env.QUEUES_PATH = path.join(SCRATCH, 'queues.yaml');
process.env.CACHE_PATH = path.join(SCRATCH, 'cache.sqlite');
process.env.PROVIDERS_PATH = path.join(SCRATCH, 'providers.yaml');
process.env.PROVIDERS_SECRETS_PATH = path.join(SCRATCH, 'providers.secrets.yaml');
// Pinned rather than inherited: the whole point of these is that they are configurable, so a
// deployment that moves them must not silently move this test's expectations with it.
process.env.ROTATION_LENGTH = '12';
process.env.ROTATION_LENGTH_MAX = '200';

writeFileSync(process.env.QUEUES_PATH, '{}\n');
// Seeded with a real BLOCK-style entry, not `sets: []`. The YAML writer follows the style it
// finds, and an empty flow sequence makes it write every new set on one flow line — which
// every "is this key on the file" assertion below would then read out of a sibling's block.
writeFileSync(
  SETS_PATH,
  'sets:\n  - id: seed\n    label: Seed\n    kind: cartoons\n    source: rotation\n    sections: [1]\n',
);

const FAILS: string[] = [];
async function ok(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}  -- ${errMessage(e)}`);
    FAILS.push(name);
  }
}

const sets = await import('../server/src/sets.js');

/**
 * The block of YAML belonging to ONE set, so a "this key is absent" assertion cannot quietly
 * pass by reading a sibling's block. The writer emits sequence items at column 0 and their
 * keys at two spaces, which is what both splits key off.
 */
const blockFor = (id: string): string => {
  const after = readFileSync(SETS_PATH, 'utf8').split(`\n- id: ${id}\n`)[1];
  assert.ok(after !== undefined, `set ${id} is not in the file`);
  return after.split('\n- id:')[0] ?? '';
};

/** The set as the registry REPORTS it, narrowed to the rotation half — the knobs live there
 *  and a curated queue's length is however many entries it has. */
const entry = async (id: string) => {
  const reg = await sets.getRegistry();
  const s = reg.sets.find((x) => x.id === id);
  assert.ok(s, `set ${id} missing from the registry`);
  assert.equal(s.source, 'rotation', `set ${id} did not normalize as a rotation channel`);
  return s as RotationSet;
};

/** What the pool editor posts: the full knob set, every time. */
const editorBody = (
  label: string,
  knobs: Record<string, unknown>,
): Record<string, unknown> => ({
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

// --------------------------------------------------------------------------- //
// create
// --------------------------------------------------------------------------- //
await ok('create carries all three knobs onto the file', async () => {
  const { id } = await sets.createSet(
    editorBody('Younger Kids — Shorts', { length: 60, on_complete: 'restart', refill: true }),
  );
  const yaml = blockFor(id);
  assert.match(yaml, /length: 60/);
  assert.match(yaml, /refill: true/);
  assert.match(yaml, /on_complete: restart/);
  const s = await entry(id);
  assert.equal(s.source, 'rotation');
  assert.equal(s.length, 60);
  assert.equal(s.refill, true);
  assert.equal(s.on_complete, 'restart');
});

await ok('create at the defaults writes NONE of them', async () => {
  // Exactly what the editor posts for a pool nobody touched the Lineup box on.
  const { id } = await sets.createSet(
    editorBody('Untouched', { length: 12, on_complete: 'drop', refill: false }),
  );
  const yaml = blockFor(id);
  assert.doesNotMatch(yaml, /length:/);
  assert.doesNotMatch(yaml, /refill:/);
  assert.doesNotMatch(yaml, /on_complete:/);
  const s = await entry(id);
  // …and it reads back as the channel it has always been: follow env, no refill, drop.
  assert.equal(s.length, null);
  assert.equal(s.refill, false);
  assert.equal(s.on_complete, null);
});

// --------------------------------------------------------------------------- //
// edit
// --------------------------------------------------------------------------- //
await ok('an unrelated rename stamps no lineup keys on the pool', async () => {
  const { id } = await sets.createSet(editorBody('Rename Me', {}));
  // The editor's Save after typing in the Name box — every knob resent at its default. This
  // is the whole reason the sparse rule had to move to "equal to the default", not "cleared".
  await sets.updateSet(id, editorBody('Renamed', { length: 12, on_complete: 'drop', refill: false }));
  const yaml = blockFor(id);
  assert.match(yaml, /label: Renamed/);
  assert.doesNotMatch(yaml, /length:|refill:|on_complete:/);
});

await ok('turning top-up off again removes the key rather than storing false', async () => {
  const { id } = await sets.createSet(editorBody('Toggle', { refill: true }));
  assert.match(blockFor(id), /refill: true/);
  await sets.updateSet(id, { refill: false });
  assert.doesNotMatch(blockFor(id), /refill:/);
  assert.equal((await entry(id)).refill, false);
});

await ok('a length back at the default clears the override', async () => {
  const { id } = await sets.createSet(editorBody('Back To Default', { length: 60 }));
  assert.match(blockFor(id), /length: 60/);
  await sets.updateSet(id, { length: 12 });
  assert.doesNotMatch(blockFor(id), /length:/);
  // Cleared means FOLLOW the env, which is a different thing from pinned-at-12: the engine
  // resolves the absent key through ROTATION_LENGTH.
  assert.equal((await entry(id)).length, null);
});

await ok('a length over the cap is clamped, not rejected', async () => {
  const { id } = await sets.createSet(editorBody('Fat Fingered', { length: 5000 }));
  assert.match(blockFor(id), /length: 200/);
  assert.equal((await entry(id)).length, 200);
});

await ok('an on_complete typo is REJECTED on both paths', async () => {
  // Coercing it to the default would mean a channel quietly stops restarting, and the failure
  // looks exactly like a pool that ran out of shows.
  await assert.rejects(
    () => sets.createSet(editorBody('Typo', { on_complete: 'restart-at-1' })),
    /invalid on_complete/,
  );
  const { id } = await sets.createSet(editorBody('Typo Patch', { on_complete: 'restart' }));
  await assert.rejects(() => sets.updateSet(id, { on_complete: 'restart-at-1' }), /invalid on_complete/);
  // The rejected write left the good value alone.
  assert.equal((await entry(id)).on_complete, 'restart');
});

await ok('a hand-written on_complete typo still READS as the default', async () => {
  // The writer rejects; the reader must not. sets.yaml is hand-edited over SMB as often as it
  // is saved through the UI, and a channel that refuses to load is a dead card on the wall.
  const { id } = await sets.createSet(editorBody('Hand Edited', {}));
  const yaml = readFileSync(SETS_PATH, 'utf8');
  const patched = yaml.replace(`\n- id: ${id}\n`, `\n- id: ${id}\n  on_complete: nonsense\n`);
  assert.notEqual(patched, yaml, 'the hand edit did not apply — the assertion below would be vacuous');
  writeFileSync(SETS_PATH, patched);
  assert.equal((await entry(id)).on_complete, null);
});

console.log(FAILS.length ? `\n${FAILS.length} FAILED` : '\nlineup knobs OK');
process.exit(FAILS.length ? 1 : 0);
