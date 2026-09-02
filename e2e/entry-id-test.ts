// THE ENTRY-ID GATE — one queue may hold the same file more than once (2026-09-01).
//
// A queue entry may carry an opaque `id`, and `entryKey()` reads it as its FIRST branch. That
// is the whole feature, and the whole risk: the key is what roughly sixty call sites, two
// SQLite primary keys and every `?only=<key>` URL address a line by, so a change to it that
// moved an existing line would re-key the household's file. Four things are under test, in the
// order they would hurt:
//
//   1. NOTHING RE-KEYS. An entry with no `id` keys byte-for-byte as it always did — scalar,
//      rating key, collection, title, and the `{title: "Collection: X"}` spelling of a
//      collection. This is the assertion every pinned entry-key string in the other gates
//      depends on, and it is why none of them needed editing.
//   2. THE TWO COPIES AGREE. `queues.entryKey()` (write side) and `engine/resolve.entryKey()`
//      (read side) are separate implementations by design. They are compared value by value
//      here, including the new branch, so a change to one is a red gate rather than a queue
//      that reorders differently from the way it plays.
//   3. TWO LINES ARE INDEPENDENTLY ADDRESSABLE. Both `entryKey` families — the first-match
//      setters (`rewriteEntry`) and the all-match mutations (`removeItem`, `markDone`,
//      `clearDone`) — plus `moveItem`, `reorder`, `queue_entry_history` and `lead_cooldown`
//      each touch ONE of two lines for one rating key. That convergence is the argument for
//      the design: neither family had to learn anything new.
//   4. THE HOLE IS CLOSED. `addItem` mints an id only where it would otherwise have refused,
//      `findDuplicateItem` keeps its refusal except for an add that names a window, and a
//      hand-written duplicate key with no id is refused BY ENTRY while its queue still plays.
//
// Hermetic and offline. Nothing here reaches Plex: every fixture entry carries a rating key, so
// `findDuplicateItem` answers from its free first pass and never resolves a title.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

const SCRATCH = mkdtempSync(nodePath.join(tmpdir(), 'qp-entry-id-'));
const QUEUES_PATH = nodePath.join(SCRATCH, 'queues.yaml');
const SETS_PATH = nodePath.join(SCRATCH, 'sets.yaml');
process.env.QUEUES_PATH = QUEUES_PATH;
process.env.SETS_PATH = SETS_PATH;
// Named rather than derived: sections 5 and 6 write real rows, and a harness that fell back to
// `/config/queuepilot.sqlite` would edit the household's book of record.
process.env.STORE_PATH = nodePath.join(SCRATCH, 'queuepilot.sqlite');

let failures = 0;
const ok = (name: string, cond: boolean, extra = ''): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};
const same = (name: string, got: unknown, want: unknown): void => {
  ok(name, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

writeFileSync(SETS_PATH, `sets:
- id: demo
  label: Demo Reel
  kind: movies
  source: queue
  sections: [1]
- id: spare
  label: Spare
  kind: movies
  source: queue
  sections: [1]
- id: handedit
  label: Hand Edit
  kind: movies
  source: queue
  sections: [1]
`);

const queues = await import('../server/src/queues.js');
const resolve = await import('../server/src/engine/resolve.js');
const entryFormat = await import('../server/src/entryFormat.js');
const entryIdentity = await import('../server/src/entryIdentity.js');
const promote = await import('../server/src/promote.js');
const queueEntryHistory = await import('../server/src/store/db/queueEntryHistory.js');
import type { ResolveCfg } from '../server/src/engine/resolve.js';
import type { EntryValue, PlexClient } from '../server/src/types.js';

const keysOf = async (set: string): Promise<string[]> =>
  (await queues.listSet(set)).map((e) => e.key);

// --- 1. an id-less entry keys exactly as it always did -------------------------- //

// Every shape the file holds, with the key each one has returned since before this feature. A
// single character out of place here is a re-keyed household file.
const UNCHANGED: [unknown, string | null][] = [
  ['A Loud Film (2019)', 'title:A Loud Film (2019)'],
  [12345, 'rk:12345'],
  ['12345', 'rk:12345'],
  ['Collection: A Franchise', 'title:Collection: A Franchise'],
  [{ ratingKey: '1001', title: 'A Loud Film (2019)' }, 'rk:1001'],
  [{ ratingKey: 1001 }, 'rk:1001'],
  [{ title: 'A Long Show (2024)' }, 'title:A Long Show (2024)'],
  [{ title: '  A Long Show (2024)  ' }, 'title:A Long Show (2024)'],
  [{ collection: 'A Franchise' }, 'title:Collection: A Franchise'],
  [{ title: 'Collection: A Franchise' }, 'title:Collection: A Franchise'],
  [{ title: '' }, null],
  // The sibling fields an entry already carries have never keyed it, and still do not.
  [{ ratingKey: '1001', weight: 3, done: true, queued_at: 1786000000 }, 'rk:1001'],
];
for (const [value, want] of UNCHANGED) {
  same(`entryKey(${JSON.stringify(value)}) is unchanged`, queues.entryKey(value), want);
}

// --- 2. an id'd entry keys as `id:` --------------------------------------------- //

const IDD: [unknown, string | null][] = [
  [{ id: '8f3a2c', ratingKey: '1001', title: 'A Loud Film (2019)' }, 'id:8f3a2c'],
  // The id WINS over both fallbacks — that is what "first branch" means.
  [{ id: '8f3a2c', collection: 'A Franchise' }, 'id:8f3a2c'],
  [{ id: '8f3a2c' }, 'id:8f3a2c'],
  [{ id: '  8f3a2c  ', ratingKey: '1001' }, 'id:8f3a2c'],
  // A hand-written all-digit id parses off YAML as a NUMBER. Both copies coerce it the same
  // way, so it is a usable id — `mintEntryId` still refuses to GENERATE one (section 4).
  [{ id: 42, ratingKey: '1001' }, 'id:42'],
  // Blank is not an identity: it falls back rather than keying every such line alike.
  [{ id: '', ratingKey: '1001' }, 'rk:1001'],
  [{ id: '   ', ratingKey: '1001' }, 'rk:1001'],
  [{ id: null, ratingKey: '1001' }, 'rk:1001'],
  [{ id: '', title: 'A Long Show (2024)' }, 'title:A Long Show (2024)'],
];
for (const [value, want] of IDD) {
  same(`entryKey(${JSON.stringify(value)})`, queues.entryKey(value), want);
}

// --- 3. the two copies agree, and normalizing preserves identity ---------------- //

let disagreed = 0;
let renamed = 0;
for (const [value] of [...UNCHANGED, ...IDD]) {
  if (queues.entryKey(value) !== resolve.entryKey(value)) {
    disagreed += 1;
    console.log(`  read/write split on ${JSON.stringify(value)}: `
      + `${queues.entryKey(value)} vs ${resolve.entryKey(value)}`);
  }
  // `toEntryObject` is the write boundary. It must never move a line — the property the
  // undo/redo reshape depends on.
  const normalized = entryFormat.toEntryObject(value as never);
  if (queues.entryKey(normalized) !== queues.entryKey(value)) {
    renamed += 1;
    console.log(`  toEntryObject re-keyed ${JSON.stringify(value)}`);
  }
}
ok('queues.entryKey and resolve.entryKey agree on every shape', disagreed === 0, `${disagreed} split(s)`);
ok('entryKey(toEntryObject(v)) === entryKey(v) for every v', renamed === 0, `${renamed} re-key(s)`);

// --- 4. addItem mints an id ONLY where it would otherwise refuse ---------------- //

const FILM = { ratingKey: '1001', title: 'A Loud Film (2019)' };
writeFileSync(QUEUES_PATH, `demo:
- {ratingKey: '1001', title: 'A Loud Film (2019)'}
- {ratingKey: '1002', title: 'Another Film (2021)'}
spare: []
`);

const plain = await queues.addItem('demo', FILM, 'bottom');
same('a plain duplicate add is still refused', plain.added, false);
same('…and it still reports the key it collided with', plain.key, 'rk:1001');
same('…and nothing was written', (await keysOf('demo')).length, 2);

const minted = await queues.addItem('demo', { ...FILM }, 'bottom', { allowDuplicate: true });
ok('an explicit duplicate add lands', minted.added);
ok('…keyed by a minted id', minted.key.startsWith('id:'), minted.key);
const SECOND = minted.key;
const mintedId = SECOND.slice('id:'.length);
ok('…the id is URL-safe verbatim', encodeURIComponent(mintedId) === mintedId, mintedId);
ok('…the id is short enough to read in hand-edited YAML', mintedId.length <= 12, mintedId);
ok('…and is not all digits, so YAML keeps it a string', !/^\d+$/.test(mintedId), mintedId);
same('the queue now holds three lines', (await keysOf('demo')).length, 3);
same('…with three distinct keys', new Set(await keysOf('demo')).size, 3);
ok('…and the ORIGINAL line kept its key', (await keysOf('demo')).includes('rk:1001'));

// An add that names a WINDOW says "this is a line" on its own — no flag needed. The window
// FIELDS are a later change (`docs/clip-playback-design.md`), so `Start` does not declare
// `position_ms` yet and this literal is cast. That is the dependency, spelled out: identity had
// to understand a section before the section could be written, and this is the seam where the
// two meet. Delete the cast in the change that adds the fields.
const sectioned = await queues.addItem(
  'demo',
  { ...FILM, start: { position_ms: 3660000 }, end: { position_ms: 3960000 } } as EntryValue,
  'bottom',
);
ok('an add carrying a section mints an id without the flag', sectioned.key.startsWith('id:'), sectioned.key);
same('…and the four lines are four keys', new Set(await keysOf('demo')).size, 4);

// Minting is CHECKED against the file, never trusted to entropy. Ten more copies, all unique.
for (let i = 0; i < 10; i += 1) {
  await queues.addItem('demo', { ...FILM }, 'bottom', { allowDuplicate: true });
}
const many = await keysOf('demo');
same('ten more duplicate adds are ten more distinct keys', new Set(many).size, many.length);
ok('…and every minted id is distinct', new Set(many.filter((k) => k.startsWith('id:'))).size === 12,
  String(many.filter((k) => k.startsWith('id:')).length));

// `mintEntryId` refuses an id the caller says is taken, and grows rather than spinning.
const crowded = new Set(Array.from({ length: 200 }, (_, i) => `taken${i}`));
const fresh = entryFormat.mintEntryId(crowded);
ok('mintEntryId avoids every id it is handed', !crowded.has(fresh), fresh);

// --- 5. two lines for one rating key, addressed one at a time ------------------- //

writeFileSync(QUEUES_PATH, `demo:
- {ratingKey: '1001', title: 'A Loud Film (2019)'}
- {id: 8f3a2c, ratingKey: '1001', title: 'A Loud Film (2019)'}
- {ratingKey: '1002', title: 'Another Film (2021)'}
spare: []
`);
const FIRST_LINE = 'rk:1001';
const SECOND_LINE = 'id:8f3a2c';

same('both lines are visible', (await keysOf('demo')).join(','), `${FIRST_LINE},${SECOND_LINE},rk:1002`);
same('…and the resolver sees both too', resolve.loadEntries('demo').map((d) => d.key).join(','),
  `${FIRST_LINE},${SECOND_LINE},rk:1002`);

/** One line's mapping, as it is on disk right now. */
const lineAt = async (key: string): Promise<Record<string, unknown>> => {
  const row = (await queues.listSet('demo')).find((e) => e.key === key);
  return (row?.value ?? {}) as Record<string, unknown>;
};

// (a) the first-match family — every `rewriteEntry` setter.
await queues.setWeight('demo', SECOND_LINE, 3);
same('a setter reaches the id line', (await lineAt(SECOND_LINE)).weight, 3);
ok('…and leaves the rating-key line alone', (await lineAt(FIRST_LINE)).weight === undefined,
  JSON.stringify(await lineAt(FIRST_LINE)));
await queues.setWeight('demo', FIRST_LINE, 2);
same('…and the other line takes its own value', (await lineAt(FIRST_LINE)).weight, 2);
same('…without disturbing the first', (await lineAt(SECOND_LINE)).weight, 3);
ok('…and a rewrite keeps the id, so the line keeps its key',
  (await keysOf('demo')).includes(SECOND_LINE));

// (b) the all-match family — markDone / clearDone.
await queues.markDone('demo', [SECOND_LINE]);
same('markDone reaches the id line', (await lineAt(SECOND_LINE)).done, true);
ok('…and not the rating-key line', (await lineAt(FIRST_LINE)).done === undefined);
await queues.markDone('demo', [FIRST_LINE]);
await queues.clearDone('demo', [SECOND_LINE]);
ok('clearDone reaches only the id line', (await lineAt(SECOND_LINE)).done === undefined);
same('…and the other stays done', (await lineAt(FIRST_LINE)).done, true);
await queues.clearDone('demo', [FIRST_LINE]);

// (c) reorder — two lines, one rating key, two ranks.
await queues.reorder('demo', [SECOND_LINE, 'rk:1002', FIRST_LINE]);
same('reorder ranks the two lines separately', (await keysOf('demo')).join(','),
  `${SECOND_LINE},rk:1002,${FIRST_LINE}`);

// (d) moveItem — one line crosses to another queue, the other stays.
await queues.moveItem('demo', 'spare', SECOND_LINE, [SECOND_LINE]);
same('moveItem takes the id line', (await keysOf('spare')).join(','), SECOND_LINE);
same('…and leaves the rating-key line behind', (await keysOf('demo')).join(','), `rk:1002,${FIRST_LINE}`);
await queues.moveItem('spare', 'demo', SECOND_LINE, [FIRST_LINE, SECOND_LINE, 'rk:1002']);
same('…and it comes back where it was asked to', (await keysOf('demo')).join(','),
  `${FIRST_LINE},${SECOND_LINE},rk:1002`);

// (e) removeItem — the all-match filter removes ONE line.
await queues.removeItem('demo', SECOND_LINE);
same('removeItem removes only the id line', (await keysOf('demo')).join(','), `${FIRST_LINE},rk:1002`);

// --- 6. the two SQLite tables keyed on the entry key ---------------------------- //
//
// Both become correct with NO migration, which is the whole reason the key had to stay unique.
// A shared key would have had one section's resume position overwriting the other's, and one
// promoted section suppressing its sibling's lead.

queueEntryHistory.markCompleted('demo', FIRST_LINE, '1001');
same('queue_entry_history records the first line', queueEntryHistory.completedFor('demo', FIRST_LINE).size, 1);
same('…and the second line has its own empty row set',
  queueEntryHistory.completedFor('demo', SECOND_LINE).size, 0);
queueEntryHistory.savePosition('demo', SECOND_LINE, '1001', 5400000, 7200000);
same('…the second line keeps its own position',
  queueEntryHistory.progressFor('demo', SECOND_LINE).get('1001')?.positionMs, 5400000);
ok('…and the first line is still the completed one, not the positioned one',
  queueEntryHistory.progressFor('demo', FIRST_LINE).get('1001')?.isCompleted === true);
queueEntryHistory.clearCompleted('demo', FIRST_LINE);
same('clearing one line leaves the other intact',
  queueEntryHistory.progressFor('demo', SECOND_LINE).get('1001')?.positionMs, 5400000);

await promote.recordLead('demo', FIRST_LINE);
ok('lead_cooldown records the first line', (await promote.lastLedAt('demo', FIRST_LINE)) !== null);
ok('…and the second line has never led', (await promote.lastLedAt('demo', SECOND_LINE)) === null);
await promote.recordLead('demo', SECOND_LINE);
await promote.clearLead('demo', FIRST_LINE);
ok('…clearing one cooldown leaves the other', (await promote.lastLedAt('demo', SECOND_LINE)) !== null);
ok('…and the cleared one is cleared', (await promote.lastLedAt('demo', FIRST_LINE)) === null);

// --- 7. a hand-written duplicate with no id is refused BY ENTRY ----------------- //
//
// The SMB case: somebody types a second line for the same film into `queues.yaml` and gives it
// no `id`. There is no honest answer to "which line is `rk:2001`?", so the second one is
// refused by name — and the queue around it still plays, exactly as a legacy scalar is refused.

writeFileSync(QUEUES_PATH, `handedit:
- {ratingKey: '2001', title: 'A Repeated Film (2018)'}
- {ratingKey: '2002', title: 'A Different Film (2020)'}
- {ratingKey: '2001', title: 'A Repeated Film (2018)', start: {position_ms: 5400000}}
- {ratingKey: '2003', title: 'A Third Film (2022)'}
`);

const logged: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]): void => { logged.push(args.join(' ')); };
const played = resolve.loadEntries('handedit');
const playedAgain = resolve.loadEntries('handedit');
console.log = realLog;

same('the duplicate entry does not play', played.map((d) => d.key).join(','), 'rk:2001,rk:2002,rk:2003');
same('…and every other entry in the queue still does', played.length, 3);
// `describe()` parses the trailing `(YEAR)` off a title, which is why this is the bare name.
same('…the FIRST line is the one that survives', played[0]?.title, 'A Repeated Film');
same('a repeated read answers the same', playedAgain.map((d) => d.key).join(','), 'rk:2001,rk:2002,rk:2003');

const complaints = logged.filter((line) => line.includes('repeats the key'));
same('the refusal is logged ONCE per distinct entry per process', complaints.length, 1);
ok('…and it names the entry by set and index', complaints[0]?.includes('handedit[2]') === true, complaints[0]);
ok('…and says the fix', complaints[0]?.includes('`id:`') === true, complaints[0]);
ok('…and says the entry is not played', complaints[0]?.includes('NOT played') === true, complaints[0]);

// The same file, repaired with an id: both lines play, and they key apart.
writeFileSync(QUEUES_PATH, `handedit:
- {ratingKey: '2001', title: 'A Repeated Film (2018)'}
- {ratingKey: '2002', title: 'A Different Film (2020)'}
- {id: 4b7e1a, ratingKey: '2001', title: 'A Repeated Film (2018)', start: {position_ms: 5400000}}
- {ratingKey: '2003', title: 'A Third Film (2022)'}
`);
same('an id repairs the file', resolve.loadEntries('handedit').map((d) => d.key).join(','),
  'rk:2001,rk:2002,id:4b7e1a,rk:2003');

// A legacy scalar is still refused the same way, and the two refusals do not shadow each other.
writeFileSync(QUEUES_PATH, `handedit:
- "A Bare String (1971)"
- {ratingKey: '2002', title: 'A Different Film (2020)'}
`);
same('a legacy scalar is still refused by entry',
  resolve.loadEntries('handedit').map((d) => d.key).join(','), 'rk:2002');

// --- 8. the duplicate guard keeps its refusal and gains a door ------------------ //
//
// `findDuplicateItem` is the LOOSER, item-level test at the add route. Every entry here carries
// a rating key, so it answers from its free first pass and no Plex client is touched.

const noPlex = {
  container(): never { throw new Error('the duplicate guard must not reach Plex here'); },
} as unknown as PlexClient;
const cfg = {} as ResolveCfg;
const held = [
  { key: 'rk:1001', value: { ratingKey: '1001', title: 'A Loud Film (2019)' }, done: false, doneAt: null },
];

const hit = await entryIdentity.findDuplicateItem(noPlex, cfg, held, { ratingKey: '1001' });
same('a plain second copy is still reported', hit?.key, 'rk:1001');
same('…with the item both lines name', hit?.ratingKey, '1001');

const windowed = await entryIdentity.findDuplicateItem(noPlex, cfg, held, {
  ratingKey: '1001', start: { position_ms: 3660000 },
});
same('an add that names a window walks through the guard', windowed, null);
const openEnded = await entryIdentity.findDuplicateItem(noPlex, cfg, held, {
  ratingKey: '1001', end: { position_ms: 3960000 },
});
same('…and so does one that names only an end', openEnded, null);

// `hasSection` is the one reader that decides, so it is pinned on its own. A `start` that picks
// a UNIT (season/episode) is not a window and must not open the door.
same('hasSection({start:{position_ms}})', entryFormat.hasSection({ start: { position_ms: 1000 } }), true);
same('hasSection({end:{position_ms:0}})', entryFormat.hasSection({ end: { position_ms: 0 } }), true);
same('hasSection({start:{season,episode}})',
  entryFormat.hasSection({ start: { season: 2, episode: 4 } }), false);
same('hasSection({start:{season,episode,position_ms}})',
  entryFormat.hasSection({ start: { season: 2, episode: 4, position_ms: 750000 } }), true);
same('hasSection({})', entryFormat.hasSection({}), false);
same('hasSection(a title string)', entryFormat.hasSection('A Loud Film (2019)'), false);
same('hasSection(null)', entryFormat.hasSection(null), false);

// --- 9. the mapping survives the round trip ------------------------------------- //
//
// `id` is a field the store had never heard of when it was written, which is exactly the
// property `store/db/queues.ts` claims: the whole mapping is one JSON payload, so nothing
// needed a column and nothing needed a migration.

writeFileSync(QUEUES_PATH, `demo:
- {id: 4b7e1a, ratingKey: '1001', title: 'A Loud Film (2019)', weight: 3}
`);
await queues.setWeight('demo', 'id:4b7e1a', 4);
const text = readFileSync(QUEUES_PATH, 'utf8');
ok('a rewrite keeps the id on disk', text.includes('4b7e1a'), text.trim());
same('…and the line still keys by it', (await keysOf('demo')).join(','), 'id:4b7e1a');
same('…with the new value', (await lineAt('id:4b7e1a')).weight, 4);

rmSync(SCRATCH, { recursive: true, force: true });
console.log(failures ? `\n${failures} entry-id assertion(s) failed` : '\nall entry-id assertions passed');
process.exit(failures ? 1 : 0);
