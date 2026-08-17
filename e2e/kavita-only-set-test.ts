// Regression gate: a set whose ONLY source is a non-Plex provider must save.
//
// The bug this pins, reported from the live app 2026-08-13:
//
//     Save failed: at least one library section required
//
// …when creating a Channel whose single source block was Kavita with Manga + Webtoons
// ticked. `sections` is PLEX's library list, and it is legitimately EMPTY on a Kavita-only
// set — the libraries live in the provider blocks. Every validator counted only `sections`,
// so a perfectly valid reading set was rejected with a Plex-shaped error about a field it
// does not use.
//
// Two separate defects, both covered here:
//   1. createSet / updateSet rejected the save.
//   2. createSet never WROTE `providers` at all, so even once validation passed the blocks
//      were silently dropped and the set would have been created with no source — the worse
//      of the two, because it fails quietly instead of loudly.
//
// The library gate itself is GONE as of 2026-08-17 — naming no library means every library
// (decision `2026-08-17-no-libraries-checked-means-every-library`), so the last case below
// pins that an unscoped set SAVES rather than that it is refused.
//
// Runs offline against a scratch sets.yaml; no Plex, no Kavita, no network.
//
// Run:  server/node_modules/.bin/tsx e2e/kavita-only-set-test.ts   (repo root; non-zero on failure)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { errMessage } from '../server/src/errors.js';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'kvset-'));
// Local consts alongside the env assignment: `process.env.X` reads back as
// `string | undefined`, and these paths are written and re-read below.
const SETS_PATH = path.join(SCRATCH, 'sets.yaml');
const QUEUES_PATH = path.join(SCRATCH, 'queues.yaml');
process.env.SETS_PATH = SETS_PATH;
process.env.QUEUES_PATH = QUEUES_PATH;
process.env.CACHE_PATH = path.join(SCRATCH, 'cache.sqlite');
process.env.PROVIDERS_PATH = path.join(SCRATCH, 'providers.yaml');
process.env.PROVIDERS_SECRETS_PATH = path.join(SCRATCH, 'providers.secrets.yaml');
process.env.KAVITA_API_SERVER_URL = 'https://kavita.invalid';
process.env.KAVITA_API_KEY = 'offline-test-key';

writeFileSync(QUEUES_PATH, '{}\n');
writeFileSync(
  SETS_PATH,
  'sets:\n  - id: seed\n    label: Seed\n    kind: movies\n    source: queue\n    sections: [1]\n',
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
const readYaml = () => readFileSync(SETS_PATH, 'utf8');

// The exact shape the editor sends for a Kavita-only source: no Plex sections at all.
const KAVITA_BLOCK = [{ provider: 'kavita', profile: '', libraries: ['2', '5'] }];

// --------------------------------------------------------------------------- //
// create
// --------------------------------------------------------------------------- //
await ok('a Kavita-only QUEUE saves', async () => {
  const { id } = await sets.createSet({
    kind: 'movies',
    label: 'Reading — Manga',
    providers: KAVITA_BLOCK,
    sections: [],
    source: 'queue',
  });
  assert.ok(id, 'no id returned');
});

await ok('a Kavita-only CHANNEL saves — the case reported from the live app', async () => {
  const { id } = await sets.createSet({
    kind: 'cartoons',
    label: 'Reading — Webtoons',
    providers: KAVITA_BLOCK,
    sections: [],
    source: 'rotation',
  });
  assert.ok(id, 'no id returned');
});

await ok('the blocks are actually WRITTEN, not silently dropped', async () => {
  // The quieter half of the bug: validation passing is not enough if createSet never
  // persists `providers`, because the set is then created with no source at all.
  const text = readYaml();
  assert.match(text, /provider: kavita/, 'no kavita block on disk');
  const reg = await sets.getRegistry();
  for (const id of ['reading_manga', 'reading_webtoons']) {
    const s = reg.sets.find((x) => x.id === id);
    assert.ok(s, `set ${id} missing from the registry`);
    assert.equal(s.providers.length, 1);
    assert.equal(s.providers[0]?.provider, 'kavita');
    assert.deepEqual(s.providers[0]?.libraries, ['2', '5']);
    // A real block, NOT the synthesized legacy one.
    assert.notEqual(s.providers[0]?.implicit, true);
  }
});

await ok('`implicit` never reaches disk', async () => {
  // It is a read-time marker meaning "this set predates blocks". Writing it would make a
  // re-read treat a real block as synthesized.
  assert.doesNotMatch(readYaml(), /implicit/);
});

// --------------------------------------------------------------------------- //
// update
// --------------------------------------------------------------------------- //
await ok('editing a Kavita-only set still saves with empty sections', async () => {
  await sets.updateSet('reading_manga', {
    providers: [{ provider: 'kavita', profile: '', libraries: ['5'] }],
    sections: [],
  });
  const s = (await sets.getRegistry()).sets.find((x) => x.id === 'reading_manga');
  assert.ok(s, 'reading_manga missing from the registry');
  assert.deepEqual(s.providers[0]?.libraries, ['5']);
});

await ok('a set that names NO library saves — it means every library', async () => {
  // The reversal of the old "at least one library section required" gate (decision
  // 2026-08-17-no-libraries-checked-means-every-library). An empty checkbox group means
  // ALL, so an empty `sections` + empty `providers` is a Plex set drawing from every video
  // library — not a set with no source. It has to SAVE, both on create and on update.
  const { id } = await sets.createSet({
    kind: 'movies', label: 'Everything', providers: [], sections: [], source: 'queue',
  });
  const created = (await sets.getRegistry()).sets.find((x) => x.id === id);
  assert.ok(created, 'the unscoped set is missing from the registry');
  assert.deepEqual(created.sections, []);

  await sets.updateSet('reading_manga', { providers: [], sections: [] });
  const updated = (await sets.getRegistry()).sets.find((x) => x.id === 'reading_manga');
  assert.ok(updated, 'reading_manga missing from the registry');
  assert.deepEqual(updated.sections, []);
});

await ok('a block naming an unknown provider is refused by name', async () => {
  await assert.rejects(
    sets.createSet({
      kind: 'movies',
      label: 'Ghost',
      providers: [{ provider: 'ghost', libraries: ['1'] }],
      sections: [],
      source: 'queue',
    }),
    /unknown provider 'ghost'/,
  );
});

await ok('a plain Plex set is unaffected — no providers key appears', async () => {
  const { id } = await sets.createSet({
    kind: 'movies',
    label: 'Plain Plex',
    sections: [1, 14],
    source: 'queue',
  });
  const reg = await sets.getRegistry();
  const s = reg.sets.find((x) => x.id === id);
  assert.ok(s, `set ${id} missing from the registry`);
  assert.deepEqual(s.sections, [1, 14]);
  // Reported as the ONE implicit Plex block…
  assert.equal(s.providers.length, 1);
  assert.equal(s.providers[0]?.provider, 'plex');
  assert.equal(s.providers[0]?.implicit, true);
  // …but nothing was written for it, so the file stays byte-identical in shape.
  const block = readYaml().split('- id: plain_plex')[1] || '';
  assert.doesNotMatch(block.split('- id:')[0] ?? '', /providers:/);
});

console.log(FAILS.length ? `\n${FAILS.length} FAILED` : '\nkavita-only set OK');
process.exit(FAILS.length ? 1 : 0);
