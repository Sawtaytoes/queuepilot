// Parity gate: prove server/src/engine/routing.js copies the per-set PASSTHROUGH fields the
// retired config.py exposed. Expectations are that Python oracle's RECORDED answers, frozen in
// e2e/fixtures/golden/passthrough.json when Python was deleted (2026-08-12).
//
// A SECOND set of passthroughs post-dates Python — see POST_PYTHON below. Those expectations
// are AUTHORED here rather than recorded in the golden, because the golden is a frozen
// recording of an interpreter that never had the fields and adding rows to it would make it
// claim otherwise. Same gate, same failure mode, different provenance.
//
// Why this exists: `loadSets()` built each cfg but stopped after label/kind/enabled/mode/
// behavior. The fields below are read by session.js (requires_profile,
// remove_completed_after, max_items), resolve.js (include_specials) and playback.js
// (audio_language) — so a field the builder forgets does not throw and does not fail a
// routing test. It reads `undefined` at the consumer and SILENTLY DISABLES the feature.
// That is how 12 profile-gated sets ran ungated in the Node engine: session.js asked for
// cfg.requires_profile, got undefined, skipped the gate, and fired playMedia at a Plex
// sitting on the user picker — the card "opened Plex and stopped" (2026-08-11).
//
// The D2 gate (binding-parity.ts) could not catch it: its fixture contains none of these
// fields, and it only diffs routing DECISIONS, not the cfg the decision is made from.
//
// Run locally: server/node_modules/.bin/tsx e2e/set-passthrough-parity.ts
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
  'included_specials',
  'audio_language',
  'batch_stops_at',
];

/**
 * The passthroughs added AFTER Python was deleted, with expectations authored here.
 *
 * Every one of them went dark exactly the way `requires_profile` did, or would have, and the
 * two that did stayed dark because every test that covers them
 * (`e2e/priority-lane-test.ts`, `e2e/kind-normalize-test.ts`) hands the engine a cfg
 * DIRECTLY and never runs the loader:
 *
 *   * `promote_window` — read `undefined`, so `resolve.leadWindowMs()` used the product
 *     default instead of the queue's own window. A queue on `20h` held its promoted entry
 *     back for the default instead (2026-09-07).
 *   * `add_as` — read `undefined`, so `kind.normalizeAddAs()` re-derived the lane from
 *     `kind` and every `kind: picks` set that asked for `priority` came back `random`.
 *   * `season_start` / `season_end` — THE SEASON WINDOW, the second gate over `enabled`
 *     (decision `2026-09-08-a-season-window-gates-the-existing-enabled-flag`). It has the
 *     same silent failure as the two above, pointing the other way: dropped, it reads
 *     `undefined` at `season.isSetAvailable`, which answers "no window", and every seasonal
 *     queue is offered all year round. Nothing throws and nothing logs.
 *   * `restart_when_exhausted` — read `undefined` at `finished.applyQueueWriteSide`, so the
 *     queue would simply never start a new round.
 *
 * The first four are carried RAW and trimmed (the lane pair is lower-cased too), which the
 * `lane_priority` and `season_autumn` fixtures spell with padding and a capital letter.
 * `restart_when_exhausted` is the odd one out: it is carried EFFECTIVE, because
 * `keep_completed` and `reel` win over it.
 */
const POST_PYTHON: Record<string, Record<string, unknown>> = {
  lane_priority: { add_as: 'priority', promote_window: '20h' },
  lane_default: { add_as: null, promote_window: null, restart_when_exhausted: false },
  season_autumn: { season_end: '11-05', season_start: '10-01' },
  // The window that CROSSES the new year. Its start is AFTER its end, and the loader must
  // carry that pair unchanged — an ordering check here would make every winter season
  // unexpressible, and a swap would silently turn one into its own complement.
  season_winter: { season_end: '01-06', season_start: '12-01' },
  // No window: the reading the loader returned for every set before this landed, and the one
  // that still has to mean "available all year".
  season_none: { season_end: null, season_start: null },
  // The third completion axis, added 2026-09-08. It is read by
  // `finished.applyQueueWriteSide` and by nothing else, so a loader that forgot it would read
  // `undefined` there and the queue would simply never start a new round — exactly the silent
  // disablement this whole gate exists for. The two contradictory sets pin the PRECEDENCE:
  // a set that never marks an entry done can never exhaust, so `keep_completed` and `reel`
  // both win, and the answer is resolved rather than refused.
  restart_round: { restart_when_exhausted: true },
  restart_vs_playlist: { restart_when_exhausted: false, keep_completed: true },
  restart_vs_reel: { restart_when_exhausted: false, keep_completed: true, reel: true },
};

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
const norm = (v: unknown): unknown => (v === undefined ? null : v);

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
    // FIELDS is a runtime list of passthrough names, so this is a dynamic read by design —
    // the gate exists precisely to catch a field the loader never copied. Indexing the cfg as
    // a record is the whole point; a keyof-typed lookup would only check the ones we listed.
    const have = norm((got as unknown as Record<string, unknown>)[f]);
    if (JSON.stringify(want) === JSON.stringify(have)) {
      console.log(`PASS ${sid}.${f} = ${JSON.stringify(have)}`);
    } else {
      console.log(`FAIL ${sid}.${f} — node ${JSON.stringify(have)}, golden ${JSON.stringify(want)}`);
      failed++;
    }
  }
}

for (const [sid, want] of Object.entries(POST_PYTHON)) {
  const got = reg.sets[sid];
  if (!got) {
    console.log(`FAIL ${sid}: missing from the Node registry entirely`);
    failed++;
    continue;
  }
  for (const [f, expect] of Object.entries(want)) {
    // Same dynamic read as the loop above, and for the same reason: the gate exists to catch
    // a field the loader never copied, so it must index by NAME.
    const have = norm((got as unknown as Record<string, unknown>)[f]);
    if (JSON.stringify(norm(expect)) === JSON.stringify(have)) {
      console.log(`PASS ${sid}.${f} = ${JSON.stringify(have)}`);
    } else {
      console.log(`FAIL ${sid}.${f} — node ${JSON.stringify(have)}, expected ${JSON.stringify(expect)}`);
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
