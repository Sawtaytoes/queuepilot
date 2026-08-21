// THE ENTRY FORMAT GATE — a queues.yaml entry is an OBJECT (2026-08-21).
//
// Three things are under test, and the first is the one that would hurt most if it broke:
//
//   1. THE MIGRATION LOSES NOTHING. Every sibling field an entry carries (`start`, `done`,
//      `done_at`, `weight`, `episodes`, `volumes`, `batch_stops_at`, `queued_at`, and a field
//      this code has never heard of) survives the rewrite, comments survive it, and a second
//      run is byte-identical. Silently dropping a `done_at` would be worse than the bug the
//      migration fixes, because nothing would ever report it.
//   2. THE READER REFUSES A LEGACY SCALAR — per ENTRY, never per file. `loadEntries()` drops a
//      bare string so nothing plays it, while `listSet()` still returns it so the editor can
//      show it and the owner can delete it, and `entryKey()` still addresses it.
//   3. THE WRITER NEVER EMITS ONE. `addItem` normalizes a bare title/rating key/collection into
//      a mapping, and clearing an entry's last override no longer collapses it back to a
//      scalar — which is how the file would have drifted back one edit at a time.
//
// Hermetic and offline: the Plex lookup is an INJECTED resolver, which is the only reason the
// backfill half can be tested at all without a library.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

const SCRATCH = mkdtempSync(nodePath.join(tmpdir(), 'qp-entry-objects-'));
const QUEUES_PATH = nodePath.join(SCRATCH, 'queues.yaml');
const SETS_PATH = nodePath.join(SCRATCH, 'sets.yaml');
process.env.QUEUES_PATH = QUEUES_PATH;
process.env.SETS_PATH = SETS_PATH;

let failures = 0;
const ok = (name: string, cond: boolean, extra = ''): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};

writeFileSync(SETS_PATH, `sets:
- id: bob
  label: Bob — Movies
  kind: movies
  source: queue
  sections: [1]
`);

const { migrateText } = await import('../server/src/tools/entryObjects.js');
const queues = await import('../server/src/queues.js');
const resolve = await import('../server/src/engine/resolve.js');

/**
 * The entries of a queues.yaml TEXT, parsed the way the app parses them.
 *
 * `e2e/` has no `yaml` dependency of its own — the harnesses reach it only through server
 * modules — so the text is written to the scratch `QUEUES_PATH` and read back through
 * `queues.listSet()`, which is the app's own reader and therefore a better witness anyway.
 */
async function entriesOf(text: string): Promise<Record<string, unknown>[]> {
  writeFileSync(QUEUES_PATH, text);
  return (await queues.listSet('bob')).map((e) => e.value as Record<string, unknown>);
}

// --- 1. the migration ---------------------------------------------------------- //

// Every shape the live file held, and every sibling field it carries. `mystery_field` is the
// one that matters most: this code has never heard of it, so if the migration only copied the
// fields it knows about, that is where it would show.
const BEFORE = `# HEAD: hand-edit this over SMB.

bob:
- "Duel (1971)"  # INLINE: an entry's own note
- 12345
- "Collection: Godzilla Collection"
- {title: "Collection: Dragon Ball", weight: 3, start: {series: "1", season: 1, episode: 1}, episodes: 2, batch_stops_at: season}
- {title: "Never Heard Of It", done: true, done_at: 1786668576, volumes: 4, queued_at: 1786000000, mystery_field: keep-me}
- {ratingKey: "999", title: "Already Right"}

- {collection: "Already A Mapping"}
# FOOT: order is play order.
`;

/** The stub library: two titles resolve, one does not. */
const LIBRARY = new Map<string, string>([
  ['Duel (1971)', '210338'],
  ['12345', 'A Film With No Caption'],
]);

async function migrate(text: string, resolveOn = true) {
  const { text: out, changes } = await migrateText(text, () => ({
    label: 'bob',
    resolve: resolveOn
      // Keyed on the entry's raw TEXT, not on `describe()`'s parsed title — `describe()`
      // peels the `(year)` off, which is exactly the sort of detail a fake library should not
      // have an opinion about.
      ? async (value: unknown) => LIBRARY.get(String(
        value != null && typeof value === 'object'
          ? (value as { title?: string; ratingKey?: string }).title
            ?? (value as { ratingKey?: string }).ratingKey
          : value,
      )) ?? null
      : null,
    why: 'stub library',
  }));
  return { out, changes, unresolved: changes.filter((c) => c.verdict === 'unresolved') };
}

const first = await migrate(BEFORE);
const migrated = first.out;
const entries = await entriesOf(migrated);

ok('every entry is now a mapping', entries.every((e) => e != null && typeof e === 'object' && !Array.isArray(e)),
  JSON.stringify(entries.filter((e) => typeof e !== 'object')));
ok('a title gained its rating key', entries[0]?.ratingKey === '210338' && entries[0]?.title === 'Duel (1971)',
  JSON.stringify(entries[0]));
ok('a bare rating key gained a caption', entries[1]?.ratingKey === '12345' && entries[1]?.title === 'A Film With No Caption',
  JSON.stringify(entries[1]));
ok('a Collection string became {collection}', entries[2]?.collection === 'Godzilla Collection',
  JSON.stringify(entries[2]));
ok('a {title: "Collection: …"} mapping became {collection}', entries[3]?.collection === 'Dragon Ball',
  JSON.stringify(entries[3]));

// THE ASSERTION THIS FILE EXISTS FOR.
const collectionEntry = entries[3] ?? {};
ok('collection entry kept weight', collectionEntry.weight === 3);
ok('collection entry kept start', JSON.stringify(collectionEntry.start) === JSON.stringify({ series: '1', season: 1, episode: 1 }));
ok('collection entry kept episodes', collectionEntry.episodes === 2);
ok('collection entry kept batch_stops_at', collectionEntry.batch_stops_at === 'season');
const unresolvedEntry = entries[4] ?? {};
ok('unresolved entry kept done', unresolvedEntry.done === true);
ok('unresolved entry kept done_at', unresolvedEntry.done_at === 1786668576);
ok('unresolved entry kept volumes', unresolvedEntry.volumes === 4);
ok('unresolved entry kept queued_at', unresolvedEntry.queued_at === 1786000000);
ok('unresolved entry kept a field this code never heard of', unresolvedEntry.mystery_field === 'keep-me');
ok('an unresolvable title keeps its title and gains NO rating key',
  unresolvedEntry.title === 'Never Heard Of It' && unresolvedEntry.ratingKey === undefined);
ok('an unresolvable title is REPORTED', first.unresolved.length === 1, JSON.stringify(first.unresolved));

ok('kept the head comment', migrated.includes('# HEAD:'));
ok('kept the foot comment', migrated.includes('# FOOT:'));
ok("kept an entry's own inline comment (moved above the mapping)", migrated.includes('# INLINE:'));

// Idempotency, byte for byte.
const second = await migrate(migrated);
ok('a second run rewrites nothing', second.changes.every((c) => !c.rewritten), JSON.stringify(second.changes));
ok('a second run is byte-identical', second.out === migrated);
ok('…and it still NAMES the unresolvable entry, every time', second.unresolved.length === 1,
  JSON.stringify(second.unresolved));

// --- 2. entryKey is unchanged by any of it ------------------------------------- //

ok('entryKey: a Collection string and {collection} are the SAME line',
  queues.entryKey('Collection: Godzilla Collection') === queues.entryKey({ collection: 'Godzilla Collection' }));
ok('entryKey: a {title: "Collection: …"} mapping is that same line too',
  queues.entryKey({ title: 'Collection: Godzilla Collection' }) === queues.entryKey({ collection: 'Godzilla Collection' }));
ok('entryKey: a numeric scalar and {ratingKey} are the same line',
  queues.entryKey(12345) === queues.entryKey({ ratingKey: '12345' }));
ok('toEntryObject is identity-preserving', ['Duel (1971)', 12345, '999', 'Collection: X'].every(
  (v) => queues.entryKey(v) === queues.entryKey(queues.toEntryObject(v as string | number))));

// The MIGRATED file re-keys exactly the entries that gained a rating key, and nothing else.
const beforeKeys = (await entriesOf(BEFORE)).map((v) => queues.entryKey(v));
const afterKeys = entries.map((v) => queues.entryKey(v));
const rekeyed = beforeKeys.map((k, i) => [k, afterKeys[i]] as const).filter(([a, b]) => a !== b);
ok('no entry was dropped', beforeKeys.length === afterKeys.length, `${beforeKeys.length} vs ${afterKeys.length}`);
ok('every re-key is a title becoming a rating key — nothing else moved',
  rekeyed.every(([a, b]) => String(a).startsWith('title:') && String(b).startsWith('rk:')),
  JSON.stringify(rekeyed));

// --- 3. the reader refuses a legacy scalar, per ENTRY --------------------------- //

writeFileSync(QUEUES_PATH, `bob:
- {ratingKey: "1", title: Good Entry}
- "A Bare String"
- {ratingKey: "2", title: Another Good Entry}
`);
const descs = resolve.loadEntries('bob');
ok('loadEntries drops the legacy scalar', descs.length === 2, JSON.stringify(descs.map((d) => d.key)));
ok('…and keeps every entry either side of it',
  descs[0]?.key === 'rk:1' && descs[1]?.key === 'rk:2', JSON.stringify(descs.map((d) => d.key)));
const listed = await queues.listSet('bob');
ok('listSet still returns it, so the editor can show and delete it', listed.length === 3,
  JSON.stringify(listed.map((e) => e.key)));
ok('…and it is still addressable by key', listed[1]?.key === 'title:A Bare String');
ok('isLegacyScalarEntry names it', queues.isLegacyScalarEntry('A Bare String') === true
  && queues.isLegacyScalarEntry({ title: 'x' }) === false);
ok('the complaint names the set, the index and the fix',
  /bob\[1\][\s\S]*"A Bare String"[\s\S]*\{"title":"A Bare String"\}/.test(queues.legacyEntryMessage('bob', 1, 'A Bare String')),
  queues.legacyEntryMessage('bob', 1, 'A Bare String'));

// --- 4. the writer never emits a scalar ---------------------------------------- //

const readQueues = (): string => readFileSync(QUEUES_PATH, 'utf8');
const hasScalarEntry = (): boolean => readQueues().split('\n').some((l) => /^\s*-\s+(?!\{)\S/.test(l) && !/^\s*-\s+\w+:/.test(l));

writeFileSync(QUEUES_PATH, 'bob: []\n');
rmSync(`${QUEUES_PATH}.lock`, { force: true, recursive: true });
await queues.addItem('bob', 'A Typed Title', 'bottom');
await queues.addItem('bob', 12345, 'bottom');
await queues.addItem('bob', 'Collection: A Franchise', 'bottom');
await queues.addItem('bob', { ratingKey: '77', title: 'From The UI' }, 'bottom');
const written = (await queues.listSet('bob')).map((e) => e.value as Record<string, unknown>);
ok('addItem(title) writes a mapping', written[0]?.title === 'A Typed Title' && typeof written[0] === 'object',
  JSON.stringify(written[0]));
ok('addItem(ratingKey) writes a mapping', written[1]?.ratingKey === 12345, JSON.stringify(written[1]));
ok('addItem("Collection: …") writes {collection}', written[2]?.collection === 'A Franchise',
  JSON.stringify(written[2]));
ok('addItem(mapping) is unchanged', written[3]?.ratingKey === '77', JSON.stringify(written[3]));
ok('nothing written is a scalar entry', !hasScalarEntry(), readQueues());

// The collapse that used to happen: clearing the LAST override turned the entry back into a
// bare string, which would have undone the migration one edit at a time.
await queues.setWeight('bob', 'title:A Typed Title', 3);
ok('setWeight(3) wrote the override', /A Typed Title[\s\S]*weight: 3/.test(readQueues()));
await queues.setWeight('bob', 'title:A Typed Title', 1);
ok('setWeight(1) drops the key', !readQueues().includes('weight:'));
ok('…and the entry is STILL a mapping, not a bare string', !hasScalarEntry(), readQueues());
ok('…and it kept its identity', (await queues.listSet('bob'))[0]?.key === 'title:A Typed Title');

// --- 5. what the GRID does with each shape ------------------------------------- //
//
// Both of these were regressions waiting to happen the moment the file started spelling a
// collection `{collection: …}`: the caption read "ratingKey undefined", and a legacy scalar
// would have painted a normal poster for a line the engine refuses to play.
const tiles = await import('../server/src/tiles.js');
ok('a {collection} entry captions itself', tiles.displayFor({ collection: 'A Franchise' }) === 'Collection: A Franchise',
  tiles.displayFor({ collection: 'A Franchise' }));
ok('a {ratingKey,title} entry still captions itself', tiles.displayFor({ ratingKey: '1', title: 'A Film' }) === 'A Film');
const legacyTile = tiles.unresolvedTile('A Bare String');
ok('a legacy scalar gets an UNRESOLVED tile — the grid paints that red',
  legacyTile.resolved === false && legacyTile.ratingKey === null && legacyTile.title === 'A Bare String',
  JSON.stringify(legacyTile));

rmSync(SCRATCH, { recursive: true, force: true });
console.log(failures ? `\n${failures} entry-format assertion(s) failed` : '\nall entry-format assertions passed');
process.exit(failures ? 1 : 0);
