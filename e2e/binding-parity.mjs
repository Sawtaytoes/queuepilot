// D2 parity gate: prove server/src/engine/routing.js decides set:"auto" routing BYTE-FOR-BYTE
// like queue_builder/config.py. The Python side is the oracle — we never hardcode expected
// answers, we diff Node against what the real Python CLI prints:
//   * `python -m queue_builder.cli route <kind> <title>`  → channel_for + binding_for
//   * `python -m queue_builder.cli sections`              → set_sections + rewatch_sections
// over e2e/fixtures/routing.sets.yaml, which covers every branch (disabled/superseded guards,
// explicit-profiles progress vs rewatch, empty-sections, legacy single-binding + PROFILE_SET_MAP
// fallback, NO MAPPING, queue/reel section pools). Exit non-zero on any mismatch.
//
// Run locally: PYTHONPATH=/tmp/pylibs:. node e2e/binding-parity.mjs   (needs ruamel importable).
// CI installs ruamel via requirements.txt and runs it from the repo root.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(REPO, 'e2e', 'fixtures', 'routing.sets.yaml');
// A controlled map so the legacy-tier fallback is reachable ("Legacy Kid" binds no explicit
// channel). Both halves read THIS exact value, so the two engines can't disagree on the map.
const PROFILE_SET_MAP = JSON.stringify({
  'Younger Kids': 'younger',
  'Older Kids': 'older',
  'Legacy Kid': 'younger',
});
const PY_ENV = { ...process.env, SETS_PATH: FIXTURE, PROFILE_SET_MAP };

// env.js reads process.env at module-eval, so set these BEFORE importing the port (dynamic
// import evaluates after these assignments; a static import would hoist above them).
process.env.SETS_PATH = FIXTURE;
process.env.PROFILE_SET_MAP = PROFILE_SET_MAP;
const routing = await import('../server/src/engine/routing.js');

const py = (...args) =>
  execFileSync('python3', ['-m', 'queue_builder.cli', ...args], {
    cwd: REPO,
    env: PY_ENV,
    encoding: 'utf8',
  }).trim();

// Parse the human-readable `route` line into a comparable record.
//   route[cartoons × 'Younger Kids'] -> set 'shows' (via channel_for), binding plex_user='Younger Kids' account_id=11110001
//   route[cartoons × 'Guest'] -> NO MAPPING (would error, as today)
function parseRoute(line) {
  if (/-> NO MAPPING/.test(line)) return { sid: null, via: null, plex_user: null, account_id: null };
  const m = line.match(/-> set '([^']*)' \(via (\w+)\), binding plex_user=(.+) account_id=(.+)$/);
  if (!m) throw new Error(`unparseable route line: ${line}`);
  const [, sid, via, userRepr, acct] = m;
  return {
    sid,
    via,
    plex_user: userRepr === 'None' ? null : userRepr.replace(/^'(.*)'$/, '$1'),
    account_id: acct === 'None' ? null : acct,
  };
}

// Node route() → the same comparable record (account_id stringified like Python's f-string).
function nodeRoute(kind, title) {
  const r = routing.route(kind, title);
  return {
    sid: r.sid,
    via: r.sid == null ? null : r.via,
    plex_user: r.binding ? r.binding.plex_user ?? null : null,
    account_id: r.binding && r.binding.account_id != null ? String(r.binding.account_id) : null,
  };
}

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`  ✗ ${msg}`);
};

// --- routing decision (channel_for + binding_for + PROFILE_SET_MAP fallback) ----------------
const INPUTS = [
  ['cartoons', 'Younger Kids'],
  ['cartoons', 'Older Kids'],
  ['cartoons', 'Legacy Kid'],
  ['cartoons', 'Guest'],
  ['cartoons', 'Nobody At All'],
  ['movie', 'Younger Kids'],
  ['movie', 'Older Kids'],
  ['movie', 'Legacy Kid'],
  ['movie', 'Guest'],
];

console.log('=== route parity (Node engine vs python -m queue_builder.cli route) ===');
for (const [kind, title] of INPUTS) {
  const want = parseRoute(py('route', kind, title));
  const got = nodeRoute(kind, title);
  const same = JSON.stringify(want) === JSON.stringify(got);
  if (same) {
    console.log(`  ✓ ${kind} × ${title} → ${want.sid ?? 'NO MAPPING'}${want.via ? ` (${want.via})` : ''}`);
  } else {
    fail(`${kind} × ${title}\n      python: ${JSON.stringify(want)}\n      node:   ${JSON.stringify(got)}`);
  }
}

// --- section pools (set_sections + rewatch_sections) for EVERY set --------------------------
console.log('=== section parity (Node engine vs python -m queue_builder.cli sections) ===');
const pySections = JSON.parse(py('sections'));
const reg = routing.loadSets(FIXTURE);
for (const sid of reg.order) {
  const cfg = reg.sets[sid];
  const wantSet = pySections[sid].set_sections;
  const wantRe = pySections[sid].rewatch_sections;
  const gotSet = routing.setSections(cfg);
  const gotRe = routing.rewatchSections(cfg);
  const okSet = JSON.stringify(wantSet) === JSON.stringify(gotSet);
  const okRe = JSON.stringify(wantRe) === JSON.stringify(gotRe);
  if (okSet && okRe) {
    console.log(`  ✓ ${sid}: set=${JSON.stringify(gotSet)} rewatch=${JSON.stringify(gotRe)}`);
  } else {
    if (!okSet) fail(`${sid} set_sections — python ${JSON.stringify(wantSet)} vs node ${JSON.stringify(gotSet)}`);
    if (!okRe) fail(`${sid} rewatch_sections — python ${JSON.stringify(wantRe)} vs node ${JSON.stringify(gotRe)}`);
  }
}
// Guard: the two engines must even see the SAME set of ids (a parse divergence would else hide).
const pyIds = Object.keys(pySections);
if (JSON.stringify(pyIds) !== JSON.stringify(reg.order)) {
  fail(`set id/order mismatch — python ${JSON.stringify(pyIds)} vs node ${JSON.stringify(reg.order)}`);
}

console.log(failures ? `\nFAILED: ${failures} mismatch(es)` : '\nOK: Node routing matches the Python oracle');
process.exit(failures ? 1 : 0);
