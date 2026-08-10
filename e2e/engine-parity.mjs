// D3 engine parity: prove server/src/engine/select.js computes the unwatched-buckets pool the
// same as queue_builder/plex.py, by diffing both over the SYNTHETIC corpus (owner decision,
// docs/d3-engine-parity-corpus.md — no real library data). The Python side is the oracle:
//   python -m queue_builder.cli buckets kids <profile>   (replaying the corpus)
// vs the Node engine replaying the same corpus files. Parity is on the DETERMINISTIC pool
// (episodic buckets in allLeaves order; the shuffled shorts bucket compared as a sorted set) —
// the RNG shuffle/weighted-pick is out of scope by design (see the doc's RNG caveat).
//
// Run locally: PYTHONPATH=/tmp/pylibs:. node e2e/engine-parity.mjs   (needs ruamel importable).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(REPO, 'e2e', 'fixtures');
const CORPUS = path.join(FIX, 'engine-corpus');
const SETS = path.join(FIX, 'engine.sets.yaml');

// (Re)generate the synthetic corpus + its sets.yaml — hermetic, pure Python (no ruamel/network).
execFileSync('python3', ['e2e/gen-synthetic-corpus.py', CORPUS], { cwd: REPO, stdio: 'inherit' });

// env.js reads process.env at module-eval → set SETS_PATH before importing the port.
process.env.SETS_PATH = SETS;
const routing = await import('../server/src/engine/routing.js');
const select = await import('../server/src/engine/select.js');
const rotation = await import('../server/src/engine/rotation.js');
const { replayClient } = await import('../server/src/engine/plex-replay.js');

const PY_ENV = {
  ...process.env,
  SETS_PATH: SETS,
  PLEX_REPLAY_DIR: CORPUS,
  PLEX_API_SERVER_URL: 'https://plex.invalid', // guarantee no live call slips through
  PLEX_TOKEN: 'WRONG',
};
const pyCli = (...args) =>
  JSON.parse(execFileSync('python3', ['-m', 'queue_builder.cli', ...args],
    { cwd: REPO, env: PY_ENV, encoding: 'utf8' }).trim());
const pyBuckets = (profile) => pyCli('buckets', 'kids', profile);
const pyRewatch = (profile) => pyCli('rewatch-counts', 'kids', profile);
const pyChannelBuckets = (set, profile) => pyCli('channel-buckets-json', set, profile);

const client = replayClient(CORPUS);
const reg = routing.loadSets(SETS);
const cfg = reg.sets.kids;

// Node channel_buckets (rule pool + curated members, deduped), normalized to the _buckets shape.
async function nodeChannelBuckets(set, profile) {
  const c = reg.sets[set];
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
async function nodeBuckets(profile) {
  const binding = routing.bindingFor(cfg, profile);
  return (await select.unwatchedBuckets(client, cfg, binding)).map((bk) => {
    let eps = bk.episodes.map((e) => e.ratingKey);
    if (String(bk.ratingKey).startsWith('section-')) eps = [...eps].sort();
    return { show: bk.show, ratingKey: bk.ratingKey, multi_season: Boolean(bk.multi_season), episodes: eps };
  });
}

// Node rewatch counts, normalized to the Python `_rewatch_counts` shape (sorted by ratingKey).
async function nodeRewatch(profile) {
  const binding = routing.bindingFor(cfg, profile);
  const { counts, titles } = await select.rewatchCounts(
    client, routing.rewatchSections(cfg), binding.movie_ratings,
    binding.watch_count_accounts, await client.accountToken(binding.user_uuid));
  return [...counts.keys()].sort().map((rk) => ({ ratingKey: rk, count: counts.get(rk), title: titles.get(rk) ?? null }));
}

let failures = 0;
console.log('=== engine parity: unwatched_buckets (Node select.js ↔ python cli buckets) ===');
for (const profile of ['Younger', 'Older']) {
  const want = pyBuckets(profile);
  const got = await nodeBuckets(profile);
  if (JSON.stringify(want) === JSON.stringify(got)) {
    console.log(`  ✓ ${profile}: ${got.map((b) => `${b.show}[${b.episodes.join(',')}]`).join('  ')}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${profile}\n      python: ${JSON.stringify(want)}\n      node:   ${JSON.stringify(got)}`);
  }
}

console.log('=== engine parity: rewatch_counts (Node select.js ↔ python cli rewatch-counts) ===');
for (const profile of ['Younger', 'Older']) {
  const want = pyRewatch(profile);
  const got = await nodeRewatch(profile);
  if (JSON.stringify(want) === JSON.stringify(got)) {
    console.log(`  ✓ ${profile}: ${got.map((c) => `${c.title}×${c.count}`).join('  ') || '(none)'}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${profile}\n      python: ${JSON.stringify(want)}\n      node:   ${JSON.stringify(got)}`);
  }
}
console.log('=== engine parity: channel_buckets (Node rotation.js ↔ python cli channel-buckets-json) ===');
{
  const want = pyChannelBuckets('kidsplus', 'Younger');
  const got = await nodeChannelBuckets('kidsplus', 'Younger');
  if (JSON.stringify(want) === JSON.stringify(got)) {
    console.log(`  ✓ kidsplus × Younger: ${got.map((b) => `${b.show}[${b.episodes.join(',')}]`).join('  ')}`);
  } else {
    failures += 1;
    console.log(`  ✗ kidsplus × Younger\n      python: ${JSON.stringify(want)}\n      node:   ${JSON.stringify(got)}`);
  }
}
console.log(failures ? `\nFAILED: ${failures} mismatch(es)` : '\nOK: Node engine matches the Python oracle');
process.exit(failures ? 1 : 0);
