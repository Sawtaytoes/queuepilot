// D3 engine parity: prove server/src/engine/select.js computes the unwatched-buckets pool the
// same as the retired queue_builder/plex.py did, over the SYNTHETIC corpus (owner decision,
// docs/d3-engine-parity-corpus.md — no real library data). Expectations are that Python
// engine's RECORDED answers (`cli buckets|rewatch-counts|channel-buckets-json`), frozen in
// e2e/fixtures/golden/engine.json when Python was deleted (2026-08-12); the corpus it replayed
// is committed alongside it. Parity is on the DETERMINISTIC pool (episodic buckets in allLeaves
// order; the shuffled shorts bucket compared as a sorted set) — the RNG shuffle/weighted-pick is
// out of scope by design (see the doc's RNG caveat).
//
// Run locally: server/node_modules/.bin/tsx e2e/engine-parity.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(REPO, 'e2e', 'fixtures');
const CORPUS = path.join(FIX, 'engine-corpus');
const SETS = path.join(FIX, 'engine.sets.yaml');

// env.js reads process.env at module-eval → set SETS_PATH before importing the port.
process.env.SETS_PATH = SETS;
const routing = await import('../server/src/engine/routing.js');
const select = await import('../server/src/engine/select.js');
const rotation = await import('../server/src/engine/rotation.js');
const { replayClient } = await import('../server/src/engine/plex-replay.js');

const GOLDEN = JSON.parse(readFileSync(path.join(FIX, 'golden', 'engine.json'), 'utf8'));
const golden = (key: string): unknown => {
  if (!(key in GOLDEN)) throw new Error(`no golden for ${key}`);
  return GOLDEN[key];
};
const pyBuckets = (profile: string) => golden(`buckets|${profile}`);
const pyRewatch = (profile: string) => golden(`rewatch-counts|${profile}`);
const pyChannelBuckets = (set: string, profile: string) => golden(`channel-buckets-json|${set}|${profile}`);

const client = replayClient(CORPUS);
// Nullable only for a MISSING/unparseable sets.yaml, and `sets[id]` only for an id the file
// does not carry; both are the committed corpus fixture, so each `!` fails exactly where the
// original did rather than adding a branch.
const reg = routing.loadSets(SETS)!;
const cfg = reg.sets.kids!;

// Node channel_buckets (rule pool + curated members, deduped), normalized to the _buckets shape.
async function nodeChannelBuckets(set: string, profile: string) {
  const c = reg.sets[set]!;
  const binding = routing.bindingFor(c, profile);
  return (await rotation.channelBuckets(client, c, binding)).map((bk) => {
    let eps = bk.episodes.map((e) => String(e.ratingKey));
    if (String(bk.ratingKey).startsWith('section-')) eps = [...eps].sort();
    return {
      show: bk.show, ratingKey: String(bk.ratingKey),
      multi_season: Boolean(bk.multi_season), episodes: eps,
    };
  });
}

// Node buckets, normalized to the Python `_buckets` shape (episodes as ratingKeys; shorts sorted).
async function nodeBuckets(profile: string) {
  const binding = routing.bindingFor(cfg, profile);
  return (await select.unwatchedBuckets(client, cfg, binding)).map((bk) => {
    let eps = bk.episodes.map((e) => e.ratingKey);
    if (String(bk.ratingKey).startsWith('section-')) eps = [...eps].sort();
    return { show: bk.show, ratingKey: bk.ratingKey, multi_season: Boolean(bk.multi_season), episodes: eps };
  });
}

// Node rewatch counts, normalized to the Python `_rewatch_counts` shape (sorted by ratingKey).
async function nodeRewatch(profile: string) {
  const binding = routing.bindingFor(cfg, profile);
  const { counts, titles } = await select.rewatchCounts(
    client, routing.rewatchSections(cfg), binding.movie_ratings,
    binding.watch_count_accounts, await client.accountToken(binding.user_uuid));
  return [...counts.keys()].sort().map((rk) => ({ ratingKey: rk, count: counts.get(rk), title: titles.get(rk) ?? null }));
}

let failures = 0;
console.log('=== engine parity: unwatched_buckets (Node select.js ↔ recorded cli buckets) ===');
for (const profile of ['Younger', 'Older']) {
  const want = pyBuckets(profile);
  const got = await nodeBuckets(profile);
  if (JSON.stringify(want) === JSON.stringify(got)) {
    console.log(`  ✓ ${profile}: ${got.map((b) => `${b.show}[${b.episodes.join(',')}]`).join('  ')}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${profile}\n      golden: ${JSON.stringify(want)}\n      node:   ${JSON.stringify(got)}`);
  }
}

console.log('=== engine parity: rewatch_counts (Node select.js ↔ recorded cli rewatch-counts) ===');
for (const profile of ['Younger', 'Older']) {
  const want = pyRewatch(profile);
  const got = await nodeRewatch(profile);
  if (JSON.stringify(want) === JSON.stringify(got)) {
    console.log(`  ✓ ${profile}: ${got.map((c) => `${c.title}×${c.count}`).join('  ') || '(none)'}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${profile}\n      golden: ${JSON.stringify(want)}\n      node:   ${JSON.stringify(got)}`);
  }
}
console.log('=== engine parity: channel_buckets (Node rotation.js ↔ recorded cli channel-buckets-json) ===');
{
  const want = pyChannelBuckets('kidsplus', 'Younger');
  const got = await nodeChannelBuckets('kidsplus', 'Younger');
  if (JSON.stringify(want) === JSON.stringify(got)) {
    console.log(`  ✓ kidsplus × Younger: ${got.map((b) => `${b.show}[${b.episodes.join(',')}]`).join('  ')}`);
  } else {
    failures += 1;
    console.log(`  ✗ kidsplus × Younger\n      golden: ${JSON.stringify(want)}\n      node:   ${JSON.stringify(got)}`);
  }
}
console.log(failures ? `\nFAILED: ${failures} mismatch(es)` : '\nOK: Node engine matches the recorded Python oracle');
process.exit(failures ? 1 : 0);
