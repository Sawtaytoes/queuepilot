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

// --- the SECTION WINDOW: start.position_ms and end.position_ms ----------------- //
//
// Two keys that say where inside the first played unit playback begins and where it stops
// (decision `2026-09-01-a-start-point-carries-a-position-and-end-is-its-mirror`). They ride in
// the same `extras` bag as `weight` and `episodes`, so they answer the same four questions
// every other sparse override answers here: the value is written, it survives an unrelated
// later edit, the sparse case drops the key, and junk drops the key.

// START. A film section is a position with NO series and NO episode — the case
// `normalizeStart`'s old two-field guard discarded silently, which is why it is first.
seed();
await queues.setStart('bob', 'title:Cowboy Bebop', { position_ms: 3660000 });
assertCommentsSurvive('setStart(position_ms)', QUEUES_PATH);
ok('setStart(position_ms): a MOVIE section is written with no series and no episode',
  /Cowboy Bebop[\s\S]*position_ms: 3660000/.test(read(QUEUES_PATH)));
ok('setStart(position_ms): it wrote no season it was never given',
  !has(QUEUES_PATH, 'season:'));
await queues.setEpisodes('bob', 'title:Cowboy Bebop', 2);
assertCommentsSurvive('setStart(position_ms) + a later episodes edit', QUEUES_PATH);
ok('setStart(position_ms): survives an unrelated later edit',
  /Cowboy Bebop[\s\S]*position_ms: 3660000/.test(read(QUEUES_PATH)));
ok('setStart(position_ms): the later edit landed too', has(QUEUES_PATH, 'episodes: 2'));
// The SPARSE case: a start whose only field is a cleared position is no start at all, so the
// whole `start` key goes rather than an empty mapping being left behind.
await queues.setStart('bob', 'title:Cowboy Bebop', { position_ms: null });
ok('setStart(position_ms: null): the whole start key is dropped', !has(QUEUES_PATH, 'start:'));
ok('setStart(position_ms: null): episodes override survived the clear', has(QUEUES_PATH, 'episodes: 2'));
// JUNK: unusable text, a negative offset and a blank all drop the key rather than writing 0.
for (const junk of ['12:30', -1, '']) {
  await queues.setStart('bob', 'title:Cowboy Bebop', { position_ms: junk });
  ok(`setStart(position_ms: ${JSON.stringify(junk)}): junk drops the key`,
    !has(QUEUES_PATH, 'position_ms'));
}
// …but junk beside a real unit leaves the unit alone.
await queues.setStart('bob', 'title:Cowboy Bebop', { season: 1, episode: 3, position_ms: 'soon' });
ok('setStart(junk position beside a unit): the unit is kept, the position is not',
  /episode: 3/.test(read(QUEUES_PATH)) && !has(QUEUES_PATH, 'position_ms'));
assertCommentsSurvive('setStart(junk position)', QUEUES_PATH);

// END — the mirror, same four questions.
seed();
await queues.setEnd('bob', 'title:Cowboy Bebop', { position_ms: 3960000 });
assertCommentsSurvive('setEnd', QUEUES_PATH);
ok('setEnd: value written', /Cowboy Bebop[\s\S]*end:[\s\S]*position_ms: 3960000/.test(read(QUEUES_PATH)));
await queues.setWeight('bob', 'title:Cowboy Bebop', 3);
assertCommentsSurvive('setEnd + a later weight edit', QUEUES_PATH);
ok('setEnd: survives an unrelated later edit',
  /Cowboy Bebop[\s\S]*position_ms: 3960000/.test(read(QUEUES_PATH)));
ok('setEnd: the later edit landed too', has(QUEUES_PATH, 'weight: 3'));
await queues.setEnd('bob', 'title:Cowboy Bebop', null);
ok('setEnd(null): key dropped', !has(QUEUES_PATH, 'end:'));
ok('setEnd(null): weight override survived the clear', has(QUEUES_PATH, 'weight: 3'));
for (const junk of [{ position_ms: 'later' }, { position_ms: -1 }, { position_ms: '' }, {}]) {
  await queues.setEnd('bob', 'title:Cowboy Bebop', junk);
  ok(`setEnd(${JSON.stringify(junk)}): junk drops the key`, !has(QUEUES_PATH, 'end:'));
}
assertCommentsSurvive('setEnd(junk)', QUEUES_PATH);

// THE FOUR OPTIONALITY STATES, on disk. All four are valid and none needs a flag.
seed();
const KEY = 'title:Cowboy Bebop';
ok('neither: no start and no end on an untouched entry',
  !has(QUEUES_PATH, 'position_ms'));
await queues.setStart('bob', KEY, { position_ms: 750000 });
ok('start only: the start is on disk and no end is',
  has(QUEUES_PATH, 'position_ms: 750000') && !has(QUEUES_PATH, 'end:'));
await queues.setStart('bob', KEY, null);
await queues.setEnd('bob', KEY, { position_ms: 1020000 });
ok('end only: the end is on disk and no start is',
  has(QUEUES_PATH, 'position_ms: 1020000') && !has(QUEUES_PATH, 'start:'));
const both = await queues.setStart('bob', KEY, { position_ms: 750000 });
ok('both: a start strictly BEFORE the existing end is accepted', both.ok);
ok('both: the window is on disk',
  has(QUEUES_PATH, 'position_ms: 750000') && has(QUEUES_PATH, 'position_ms: 1020000'));
assertCommentsSurvive('the four optionality states', QUEUES_PATH);

// THE PAIR RULE. `end` must be STRICTLY after `start`, and the refusal is BY NAME rather than
// a swap — a swap would hide the typo that produced it. Both writers ask, because either one
// can be the second of two valid-looking writes that together invert the window.
seed();
await queues.setStart('bob', KEY, { position_ms: 3660000 });
const equalEnd = await queues.setEnd('bob', KEY, { position_ms: 3660000 });
ok('setEnd(equal to start): refused', !equalEnd.ok);
ok('setEnd(equal to start): refused BY NAME, with both offsets in the message',
  !equalEnd.ok && typeof equalEnd.error === 'string'
  && equalEnd.error.includes('3660000') && /strictly after/.test(equalEnd.error),
  !equalEnd.ok ? String(equalEnd.error) : '');
ok('setEnd(equal to start): nothing was written', !has(QUEUES_PATH, 'end:'));
const beforeEnd = await queues.setEnd('bob', KEY, { position_ms: 3000000 });
ok('setEnd(before start): refused', !beforeEnd.ok);
ok('setEnd(before start): nothing was written', !has(QUEUES_PATH, 'end:'));
const afterEnd = await queues.setEnd('bob', KEY, { position_ms: 3960000 });
ok('setEnd(strictly after start): accepted', afterEnd.ok);
ok('setEnd(strictly after start): written', has(QUEUES_PATH, 'position_ms: 3960000'));
assertCommentsSurvive('the pair rule', QUEUES_PATH);

// The other direction — the half a route-level check would miss. `end` is already 3960000;
// moving the START past it must be refused too, or two individually-valid writes reach an
// invalid file.
const lateStart = await queues.setStart('bob', KEY, { position_ms: 3960000 });
ok('setStart(equal to an existing end): refused', !lateStart.ok);
const laterStart = await queues.setStart('bob', KEY, { position_ms: 4000000 });
ok('setStart(after an existing end): refused', !laterStart.ok);
ok('setStart(after an existing end): the file still holds the original window',
  has(QUEUES_PATH, 'position_ms: 3660000') && has(QUEUES_PATH, 'position_ms: 3960000'));
// Clearing one side is always accepted — there is nothing left to compare against, and an
// end-only window is one of the four valid states.
const clearedStart = await queues.setStart('bob', KEY, null);
ok('clearing the start is accepted with an end in place', clearedStart.ok);
ok('…and the end is untouched by it', has(QUEUES_PATH, 'position_ms: 3960000'));
// The end is still 3960000, so the guard is still armed against the next start.
ok('a start after the surviving end is refused',
  !(await queues.setStart('bob', KEY, { position_ms: 4000000 })).ok);
ok('…and a start strictly before it is accepted',
  (await queues.setStart('bob', KEY, { position_ms: 3000000 })).ok);
ok('…leaving the file holding that window',
  has(QUEUES_PATH, 'position_ms: 3000000') && has(QUEUES_PATH, 'position_ms: 3960000'));
assertCommentsSurvive('the pair rule, from the start side', QUEUES_PATH);

// An unknown entry is `{ok: false}` with NO error — "not found" and "refused" are different
// answers and the caller has to be able to tell them apart.
const missing = await queues.setEnd('bob', 'title:Not In This Queue', { position_ms: 10 });
ok('setEnd on an unknown entry is not-found, not a refusal',
  !missing.ok && missing.error === undefined);

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
