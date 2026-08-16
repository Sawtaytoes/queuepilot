// The comment-round-trip regression gate (Phase E).
//
// ruamel.yaml (the Python writer) used to provide comment preservation implicitly. Once Python
// is gone, the Node `yaml` Document writer is the ONLY writer, and the risk shifts from "two
// writers with different styles churn the file" to "a mutation eats a comment a human typed
// over SMB." This asserts that every mutation in queues.js and sets.js pushes a
// comment-laden file through untouched except for the intended lines.
//
// It imports the real modules (so it exercises YAML_OUT and the actual node/edit paths) with
// QUEUES_PATH / SETS_PATH pointed at temp files. Run standalone or from run.sh.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const QUEUES_PATH = '/tmp/rt-queues.yaml';
const SETS_PATH = '/tmp/rt-sets.yaml';
process.env.QUEUES_PATH = QUEUES_PATH;
process.env.SETS_PATH = SETS_PATH;

let failures = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};

const read = (p: string) => readFileSync(p, 'utf8');
const has = (p: string, s: string) => read(p).includes(s);

// A fixture with EVERY comment shape the round-trip must preserve: a head comment, a
// blank-line grouping, an inline comment on an entry, a foot comment, and a long title that
// `lineWidth: 0` must keep on one line.
const LONG_TITLE = 'The Assassination of Jesse James by the Coward Robert Ford (2007)';
const QUEUES_FIXTURE = `# HEAD: Bob's curated wishlists (top plays next). Hand-edit over SMB is fine.
# A second head line, to prove multi-line heads survive.

bob:
  - "Duel (1971)"  # INLINE: Bob's favourite
  - "${LONG_TITLE}"

  - "Cowboy Bebop"
family:
  - "Up (2009)"
# FOOT: everything above is play order.
`;

const SETS_FIXTURE = `# HEAD: the set registry. id is IMMUTABLE.

sets:
  - id: bob
    label: Bob — Movies  # INLINE: rename freely, never the id
    kind: movies
    source: queue
    sections: [1, 14]
  - id: fam
    label: Family
    kind: movies
    source: queue
    sections: [1]
  - id: kids
    label: Younger Kids
    kind: cartoons
    source: rotation
    sections: [2]
# FOOT: order = shelf order.
`;

// Fresh fixtures + no stale locks before each module's suite.
function seed() {
  for (const f of [QUEUES_PATH, SETS_PATH, `${QUEUES_PATH}.lock`, `${SETS_PATH}.lock`, `${QUEUES_PATH}.tmp`, `${SETS_PATH}.tmp`]) {
    rmSync(f, { force: true, recursive: true });
  }
  writeFileSync(QUEUES_PATH, QUEUES_FIXTURE);
  writeFileSync(SETS_PATH, SETS_FIXTURE);
}

const COMMENTS = ['# HEAD:', '# INLINE:', '# FOOT:'];
const assertCommentsSurvive = (label: string, path: string) => {
  for (const c of COMMENTS) ok(`${label}: kept ${c}`, has(path, c));
};

const queues = await import('../server/src/queues.js');

// --- queues.js mutations ------------------------------------------------------ //
seed();
await queues.addItem('bob', 'Ronin (1998)', 'top');
assertCommentsSurvive('addItem(top)', QUEUES_PATH);
ok('addItem: entry added', has(QUEUES_PATH, 'Ronin (1998)'));
ok('addItem: long title stayed on one line', new RegExp(`- .?${LONG_TITLE.replace(/[()]/g, '\\$&')}`).test(read(QUEUES_PATH)));

seed();
await queues.removeItem('bob', 'title:Duel (1971)');
// The inline comment lived on the Duel line — removing that entry legitimately removes its
// inline comment, but the HEAD and FOOT must survive.
ok('removeItem: kept # HEAD:', has(QUEUES_PATH, '# HEAD:'));
ok('removeItem: kept # FOOT:', has(QUEUES_PATH, '# FOOT:'));
ok('removeItem: entry gone', !has(QUEUES_PATH, 'Duel (1971)'));

seed();
await queues.reorder('bob', ['title:Cowboy Bebop', `title:${LONG_TITLE}`, 'title:Duel (1971)']);
assertCommentsSurvive('reorder', QUEUES_PATH);
ok('reorder: Duel inline comment travelled with its node', /Duel \(1971\)"?\s+# INLINE:/.test(read(QUEUES_PATH)));

seed();
await queues.setEpisodes('bob', 'title:Cowboy Bebop', 3);
assertCommentsSurvive('setEpisodes', QUEUES_PATH);
ok('setEpisodes: episodes written', /Cowboy Bebop[\s\S]*episodes: 3/.test(read(QUEUES_PATH)));

// The per-entry batch boundary rides in the same `extras` bag as `episodes`, so it must both
// preserve comments AND coexist with an existing override rather than replacing it.
seed();
await queues.setEpisodes('bob', 'title:Cowboy Bebop', 2);
await queues.setBatchStop('bob', 'title:Cowboy Bebop', 'season');
assertCommentsSurvive('setBatchStop', QUEUES_PATH);
ok('setBatchStop: value written', /Cowboy Bebop[\s\S]*batch_stops_at: season/.test(read(QUEUES_PATH)));
ok('setBatchStop: kept the entry\'s episodes override', /Cowboy Bebop[\s\S]*episodes: 2/.test(read(QUEUES_PATH)));
await queues.setBatchStop('bob', 'title:Cowboy Bebop', 'none');
ok('setBatchStop(none): key dropped', !has(QUEUES_PATH, 'batch_stops_at'));
ok('setBatchStop(none): episodes override survived the clear', has(QUEUES_PATH, 'episodes: 2'));

seed();
await queues.setStart('bob', 'title:Cowboy Bebop', { season: 1, episode: 3 });
assertCommentsSurvive('setStart', QUEUES_PATH);

// WEIGHT rides in the same `extras` bag: it must coexist with the other overrides, and
// clearing it (1 = the default) must take the KEY away rather than write `weight: 1`, or the
// file fills with noise nobody typed.
seed();
await queues.setWeight('bob', 'title:Cowboy Bebop', 3);
assertCommentsSurvive('setWeight', QUEUES_PATH);
ok('setWeight: value written', /Cowboy Bebop[\s\S]*weight: 3/.test(read(QUEUES_PATH)));
await queues.setEpisodes('bob', 'title:Cowboy Bebop', 2);
ok('setWeight: survives a later episodes edit', /Cowboy Bebop[\s\S]*weight: 3/.test(read(QUEUES_PATH)));
await queues.setWeight('bob', 'title:Cowboy Bebop', 1);
ok('setWeight(1): key dropped', !has(QUEUES_PATH, 'weight:'));
ok('setWeight(1): episodes override survived the clear', has(QUEUES_PATH, 'episodes: 2'));
await queues.setWeight('bob', 'title:Cowboy Bebop', 9999);
ok('setWeight: clamped to the engine cap', /weight: 20\b/.test(read(QUEUES_PATH)));
await queues.setWeight('bob', 'title:Cowboy Bebop', 'three');
ok('setWeight(junk): reads as 1 and drops the key', !has(QUEUES_PATH, 'weight:'));

ok('storedCount(missing) is follow-the-set', queues.storedCount(undefined) === null);
ok('storedCount(1) is a real override', queues.storedCount(1) === 1);
ok('storedCount(0) is not a count', queues.storedCount(0) === null);

seed();
await queues.moveItem('bob', 'family', 'title:Duel (1971)', ['title:Up (2009)', 'title:Duel (1971)']);
ok('moveItem: kept # HEAD:', has(QUEUES_PATH, '# HEAD:'));
ok('moveItem: kept # FOOT:', has(QUEUES_PATH, '# FOOT:'));
ok('moveItem: Duel moved to family (inline travels)', /family:[\s\S]*Duel \(1971\)"?\s+# INLINE:/.test(read(QUEUES_PATH)));

// --- sets.js mutations -------------------------------------------------------- //
const sets = await import('../server/src/sets.js');

// Drop the key when the value equals THIS set's default; persist 1 when the default is 2.
seed();
await sets.updateSet('bob', { episodes: 2 });
await queues.setEpisodes('bob', 'title:Cowboy Bebop', 2);
ok('setEpisodes(set-default): key dropped', !has(QUEUES_PATH, 'episodes:'));
await queues.setEpisodes('bob', 'title:Cowboy Bebop', 1);
ok('setEpisodes(1) against default 2: stored', /Cowboy Bebop[\s\S]*episodes: 1/.test(read(QUEUES_PATH)));
await queues.setEpisodes('bob', 'title:Cowboy Bebop', 2);
ok('setEpisodes(back to default): key dropped', !has(QUEUES_PATH, 'episodes:'));
await sets.updateSet('bob', { volumes: 2 });
await queues.setVolumes('bob', 'title:Cowboy Bebop', 1);
ok('setVolumes(1) against default 2: stored', /Cowboy Bebop[\s\S]*volumes: 1/.test(read(QUEUES_PATH)));
await queues.setVolumes('bob', 'title:Cowboy Bebop', 2);
ok('setVolumes(set-default): key dropped', !has(QUEUES_PATH, 'volumes:'));

seed();
await sets.updateSet('bob', { label: 'Bob — Films' });
assertCommentsSurvive('updateSet(label)', SETS_PATH);
ok('updateSet: label changed', has(SETS_PATH, 'Bob — Films'));
ok('updateSet: id untouched', /id: bob\b/.test(read(SETS_PATH)));

seed();
await sets.reorderSets(['fam', 'bob']);
assertCommentsSurvive('reorderSets', SETS_PATH);
ok('reorderSets: fam now first', read(SETS_PATH).indexOf('id: fam') < read(SETS_PATH).indexOf('id: bob'));

seed();
await sets.updateSet('bob', { batch_stops_at: 'season' });
assertCommentsSurvive('updateSet(batch_stops_at)', SETS_PATH);
ok('updateSet: batch_stops_at written', /id: bob[\s\S]*batch_stops_at: season/.test(read(SETS_PATH)));
await sets.updateSet('bob', { batch_stops_at: 'none' });
ok('updateSet(none): batch_stops_at key dropped', !has(SETS_PATH, 'batch_stops_at'));
await sets.updateSet('bob', { batch_stops_at: 'seasons' });
ok('updateSet(typo): nothing written (unrecognised = no boundary)', !has(SETS_PATH, 'batch_stops_at'));

// The rule-pool weight map, written exactly like `starts`: whole-map replace, 1s dropped, and
// an empty map takes the key with it.
seed();
await sets.updateSet('kids', { weights: { 12345: 3, 999: 1 } });
assertCommentsSurvive('updateSet(weights)', SETS_PATH);
ok('updateSet: weights map written', /id: kids[\s\S]*weights:[\s\S]*"?12345"?: 3/.test(read(SETS_PATH)));
ok('updateSet: a weight of 1 is not written', !/999: 1/.test(read(SETS_PATH)));
await sets.updateSet('kids', { weights: {} });
ok('updateSet({}): weights key dropped', !has(SETS_PATH, 'weights:'));

// A curated queue has no rule pool to weight, so the key is rotation-only — same as `starts`.
// (Its entries carry their own `weight:` in queues.yaml; that is a different writer.)
seed();
await sets.updateSet('bob', { weights: { 12345: 5 } });
ok('updateSet: weights ignored on a curated queue', !has(SETS_PATH, 'weights:'));

seed();
await sets.createSet({ label: 'New Queue', kind: 'movies', sections: [1] });
assertCommentsSurvive('createSet', SETS_PATH);
ok('createSet: new set present', has(SETS_PATH, 'label: New Queue'));

// Cleanup.
for (const f of [QUEUES_PATH, SETS_PATH, `${QUEUES_PATH}.lock`, `${SETS_PATH}.lock`]) rmSync(f, { force: true, recursive: true });

console.log(failures ? `\n${failures} round-trip assertion(s) failed` : '\nall yaml round-trip assertions passed');
process.exit(failures ? 1 : 0);
