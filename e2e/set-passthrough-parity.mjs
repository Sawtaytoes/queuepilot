// Parity gate: prove server/src/engine/routing.js copies config.py's per-set PASSTHROUGH
// fields, with Python as the oracle (never hardcoded expectations).
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
// Run locally: PYTHONPATH=/tmp/pylibs:. node e2e/set-passthrough-parity.mjs (needs ruamel).
import { execFileSync } from 'node:child_process';
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

// Python oracle: dump the same fields straight out of config.SETS as JSON.
const PY = `
import json, os
from queue_builder import config
out = {}
for sid, cfg in config.SETS.items():
    out[sid] = {f: cfg.get(f) for f in ${JSON.stringify(FIELDS)}}
print(json.dumps(out, sort_keys=True))
`;
const expected = JSON.parse(
  execFileSync('python3', ['-c', PY], {
    cwd: REPO,
    env: { ...process.env, SETS_PATH: FIXTURE },
    encoding: 'utf8',
  }),
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
  console.log('FAIL the Python oracle produced no sets — fixture not loaded?');
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
      console.log(`FAIL ${sid}.${f} — node ${JSON.stringify(have)}, python ${JSON.stringify(want)}`);
      failed++;
    }
  }
}

// Guard the guard: if someone adds a passthrough to config.py and not to FIELDS, this gate
// would keep passing while the new field goes dark exactly like requires_profile did. The
// fixture's `gated` set must at minimum prove the gate field is live.
if (norm(reg.sets.gated?.requires_profile) !== 'someuser') {
  console.log('FAIL the fixture no longer pins requires_profile — this gate is toothless');
  failed++;
}

console.log(failed ? `set-passthrough parity FAILED (${failed})` : 'set-passthrough parity OK');
process.exit(failed ? 1 : 0);
