// Parity gate: prove server/src/engine/routing.js copies the per-set PASSTHROUGH fields the
// retired config.py exposed. Expectations are that Python oracle's RECORDED answers, frozen in
// e2e/fixtures/golden/passthrough.json when Python was deleted (2026-08-12).
//
// Why this exists: `loadSets()` built each cfg but stopped after label/kind/enabled/mode/
// behavior. The five fields below are read by session.js (requires_profile,
// remove_completed_after, max_items), resolve.js (include_specials) and playback.js
// (audio_language) — so a field the builder forgets does not throw and does not fail a
// routing test. It reads `undefined` at the consumer and SILENTLY DISABLES the feature.
// That is how 12 profile-gated sets ran ungated in the Node engine: session.js asked for
// cfg.requires_profile, got undefined, skipped the gate, and fired playMedia at a Plex
// sitting on the user picker — the card "opened Plex and stopped" (2026-08-11).
//
// The D2 gate (binding-parity.mjs) could not catch it: its fixture contains none of these
// fields, and it only diffs routing DECISIONS, not the cfg the decision is made from.
//
// Run locally: node e2e/set-passthrough-parity.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(REPO, 'e2e', 'fixtures', 'passthrough.sets.yaml');

// The fields whose absence is silent. Keep in sync with config.py's tail passthroughs.
const FIELDS = [
  'requires_profile',
  'remove_completed_after',
  'max_items',
  'include_specials',
  'audio_language',
  'batch_stops_at',
];

// env.js reads process.env at module-eval, so set SETS_PATH BEFORE importing the port.
process.env.SETS_PATH = FIXTURE;
const routing = await import('../server/src/engine/routing.js');

// Recorded oracle: the same fields as config.SETS exposed them for this fixture.
const expected = JSON.parse(
  readFileSync(path.join(REPO, 'e2e', 'fixtures', 'golden', 'passthrough.json'), 'utf8'),
);

const reg = routing.loadSets();
if (!reg) {
  console.log('FAIL routing.loadSets() returned null for the fixture');
  process.exit(1);
}

// Python's absent key and JS's undefined both mean "not set" — normalise to null so the two
// spellings compare equal, while a real value difference still shows up.
const norm = (v) => (v === undefined ? null : v);

let failed = 0;
const ids = Object.keys(expected).sort();
if (!ids.length) {
  console.log('FAIL the golden has no sets — e2e/fixtures/golden/passthrough.json is empty?');
  process.exit(1);
}

for (const sid of ids) {
  const got = reg.sets[sid];
  if (!got) {
    console.log(`FAIL ${sid}: missing from the Node registry entirely`);
    failed++;
    continue;
  }
  for (const f of FIELDS) {
    const want = norm(expected[sid][f]);
    const have = norm(got[f]);
    if (JSON.stringify(want) === JSON.stringify(have)) {
      console.log(`PASS ${sid}.${f} = ${JSON.stringify(have)}`);
    } else {
      console.log(`FAIL ${sid}.${f} — node ${JSON.stringify(have)}, golden ${JSON.stringify(want)}`);
      failed++;
    }
  }
}

// Guard the guard: if someone adds a passthrough to the loader and not to FIELDS, this gate
// would keep passing while the new field goes dark exactly like requires_profile did. The
// fixture's `gated` set must at minimum prove the gate field is live.
if (norm(reg.sets.gated?.requires_profile) !== 'someuser') {
  console.log('FAIL the fixture no longer pins requires_profile — this gate is toothless');
  failed++;
}

console.log(failed ? `set-passthrough parity FAILED (${failed})` : 'set-passthrough parity OK');
process.exit(failed ? 1 : 0);
