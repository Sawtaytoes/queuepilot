// Offline gate for a FILTERED QUEUE — a queue that is a narrower view of another queue.
//
// Every HTTP call is stubbed, so this runs with no token, no network and no Kavita. What it
// pins is the whole reason a filtered queue is a VIEW and not a copy, end to end:
//
//   * It has NO entries of its own. `queues.listSet('strips')` answers the PARENT's list, and
//     `queues.addItem('strips', …)` writes on the parent's line. Two entry lists would drift
//     the first time either one was added to, and two sets of done flags are two different
//     answers to "where am I" — which is exactly what the owner asked not to happen.
//   * The LINEUP is narrowed. A curated entry outside the filter's libraries never reaches the
//     reading list, even though the entries themselves are the parent's.
//   * The reading list is its OWN. `materialize` finds and titles a SECOND list from the
//     child's label, and never touches the parent's. This is the one thing a view does not
//     share, and it is the point: a mixed-format list bounces Kavita's reader between
//     variants, and a webtoon-only list does not.
//   * A series whose library cannot be read is KEPT. Losing one of the owner's curated entries
//     to a metadata gap is worse than showing him one that does not belong.
//
// The fixture cast is invented (AGENTS.md): a "Comics & Strips" queue over libraries 2 and 5,
// and a "Strips" view of it.
//
// Run:  server/node_modules/.bin/tsx e2e/filtered-queue-test.ts   (repo root; non-zero on failure)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { errMessage } from '../server/src/errors.js';
import type { KavitaArtifact, KavitaPlayItem } from '../server/src/types.js';
import type { KavitaHttpClient } from '../server/src/providers/kavita-client.js';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'filtered-queue-'));
const SETS_PATH = path.join(SCRATCH, 'sets.yaml');
const QUEUES_PATH = path.join(SCRATCH, 'queues.yaml');
process.env.PROVIDERS_PATH = path.join(SCRATCH, 'providers.yaml');
process.env.PROVIDERS_SECRETS_PATH = path.join(SCRATCH, 'providers.secrets.yaml');
process.env.SETS_PATH = SETS_PATH;
process.env.QUEUES_PATH = QUEUES_PATH;
process.env.CACHE_PATH = path.join(SCRATCH, 'cache.sqlite');
process.env.STORE_PATH = path.join(SCRATCH, 'store.sqlite');
process.env.KAVITA_API_SERVER_URL = 'https://kavita.invalid';

// The PARENT holds four series across two libraries; the VIEW keeps library 5. Note the view's
// record is four lines long — an id, a name, a parent and a filter — and carries no provider,
// no lanes and no batch. Everything it needs is inherited.
writeFileSync(
  SETS_PATH,
  'sets:\n'
  + '  - id: reading\n'
  + '    label: Comics & Strips\n'
  + '    kind: picks\n'
  + '    source: queue\n'
  + '    add_as: priority\n'
  + '    episodes: 1\n'
  + '    providers:\n'
  + '      - provider: kavita\n'
  + '        libraries: [2, 5]\n'
  + '  - id: strips\n'
  + '    label: Strips\n'
  + '    filtered_from: reading\n'
  + '    filter:\n'
  + '      libraries: ["5"]\n',
);
writeFileSync(
  QUEUES_PATH,
  'reading:\n'
  + '  - ratingKey: "747"\n    title: A Flame Reborn\n'
  + '  - ratingKey: "3882"\n    title: A Hero Who Knows His Stuff\n'
  + '  - ratingKey: "500"\n    title: A Bound Volume\n'
  + '  - ratingKey: "777"\n    title: A Series With No Library\n'
  + 'strips: []\n',
);

const FAILS: string[] = [];
async function ok(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}  -- ${errMessage(e)}`);
    FAILS.push(name);
  }
}

const asClient = (c: unknown): KavitaHttpClient => c as unknown as KavitaHttpClient;

interface StubList { id: number; title: string; ownerUserName?: string; coverImageLocked?: boolean }

// 747 and 3882 are in library 5 (the view keeps them); 500 is in library 2 (it does not); 777
// reports NO library at all, which is the "cannot say" case.
const SERIES: Record<string, { id: number; name: string; libraryId: number | null; format: number }> = {
  747: { id: 747, name: 'A Flame Reborn', libraryId: 5, format: 1 },
  3882: { id: 3882, name: 'A Hero Who Knows His Stuff', libraryId: 5, format: 1 },
  500: { id: 500, name: 'A Bound Volume', libraryId: 2, format: 1 },
  777: { id: 777, name: 'A Series With No Library', libraryId: null, format: 1 },
};

function stubClient({ existingLists = [] }: { existingLists?: StubList[] } = {}) {
  const lists: StubList[] = existingLists.map((l) => ({ ...l }));
  const added: { readingListId: number | string; seriesId: number; chapterId: number }[] = [];
  let nextListId = 500;
  return {
    _base: 'https://kavita.invalid',
    _added: added,
    _lists: lists,
    async whoami() { return 'Reader'; },
    async libraries() {
      return [{ id: 2, name: 'Volumes', type: 0 }, { id: 5, name: 'Strips', type: 0 }];
    },
    async series(id: number | string) { return SERIES[String(id)] ?? null; },
    async seriesForLibrary(libraryId: number | string) {
      return Object.values(SERIES).filter((s) => String(s.libraryId) === String(libraryId));
    },
    async seriesDetail(seriesId: number | string) {
      // One unread chapter per series, numbered from its id so the assertions can name it.
      const n = Number(seriesId);
      return {
        chapters: [{ id: n * 10, number: '1', minNumber: 1, pages: 100, pagesRead: 0 }],
        specials: [],
        volumes: [],
      };
    },
    async readingLists() { return lists; },
    async createList(title: string) {
      const l = { id: nextListId, title, ownerUserName: 'Reader' };
      nextListId += 1;
      lists.push(l);
      return l;
    },
    async addChapter(readingListId: number, seriesId: number, chapterId: number) {
      added.push({ readingListId, seriesId, chapterId });
    },
    async readingListItems() { return []; },
    async deleteItem() { /* nothing stale in these fixtures */ },
    async updateList() { /* no rename in these fixtures */ },
    async uploadListCover() { /* decoration */ },
  };
}

const queues = await import('../server/src/queues.js');
const sets = await import('../server/src/sets.js');
const routing = await import('../server/src/engine/routing.js');
const { kavitaProvider } = await import('../server/src/providers/kavita.js');
const { pullLineup } = await import('../server/src/providers/pullLineup.js');
const DEF = { id: 'kavita', kind: 'kavita', label: 'Kavita', base_url: 'https://kavita.invalid' };

const titlesOf = (play: KavitaPlayItem[]) =>
  play.map((it) => SERIES[String(it.seriesId)]?.name ?? String(it.seriesId)).sort();

// --------------------------------------------------------------------------- //
// The registry: a view inherits everything and owns three things
// --------------------------------------------------------------------------- //
await ok('the view inherits its parent’s provider, lanes and batch', async () => {
  const view = await sets.getSet('strips');
  assert.ok(view, 'the view is not in the registry');
  assert.equal(view.source, 'queue');
  assert.equal(view.kind, 'picks');
  assert.equal(view.delivery, 'pull', 'the view did not inherit a pull provider');
  assert.equal(view.provider_kind, 'kavita');
});

await ok('the view keeps its own name, parent and filter', async () => {
  const view = await sets.getSet('strips');
  assert.equal(view?.label, 'Strips');
  assert.equal(view?.filtered_from, 'reading');
  assert.deepEqual(view?.filter, { libraries: ['5'] });
  // …and the parent is untouched by having a view of it.
  const parent = await sets.getSet('reading');
  assert.equal(parent?.filtered_from, null);
  assert.equal(parent?.label, 'Comics & Strips');
});

await ok('the view’s provider block is NARROWED to what it shows', async () => {
  const view = await sets.getSet('strips');
  assert.deepEqual(
    view?.providers.map((b) => b.libraries),
    [['5']],
    'the view still claimed the library it filters out — its own search would offer it',
  );
});

await ok('the ENGINE’s separate parse of sets.yaml inherits identically', async () => {
  // Two normalizers read this file. A view that inherited on one side and not the other would
  // show up in the UI and then refuse to launch.
  const cfg = routing.loadSets(SETS_PATH)?.sets.strips;
  assert.ok(cfg, 'the view is missing from the engine registry');
  assert.equal(cfg.source, 'queue');
  assert.equal(cfg.filtered_from, 'reading');
  assert.deepEqual(cfg.filter_libraries, ['5']);
  assert.deepEqual(cfg.providers, [{ provider: 'kavita', libraries: ['5'] }]);
});

// --------------------------------------------------------------------------- //
// Entries and progress are the PARENT's
// --------------------------------------------------------------------------- //
await ok('the view reads the parent’s entries, not its own empty list', async () => {
  const rows = await queues.listSet('strips');
  assert.deepEqual(
    rows.map((r) => r.key),
    (await queues.listSet('reading')).map((r) => r.key),
  );
  assert.equal(rows.length, 4);
});

await ok('adding from the view writes on the PARENT’s line', async () => {
  await queues.addItem('strips', { ratingKey: '999', title: 'Added From The View' }, 'bottom');
  const file = readFileSync(QUEUES_PATH, 'utf8');
  const parentBlock = file.slice(file.indexOf('reading:'), file.indexOf('strips:'));
  assert.ok(parentBlock.includes('Added From The View'), 'the add did not land on the parent');
  assert.ok(
    !file.slice(file.indexOf('strips:')).includes('Added From The View'),
    'the view grew an entry list of its own',
  );
  await queues.removeItem('strips', 'rk:999');
});

await ok('finishing from the view is finished in BOTH', async () => {
  await queues.markDone('strips', ['rk:747']);
  const inParent = (await queues.listSet('reading')).find((r) => r.key === 'rk:747');
  const inView = (await queues.listSet('strips')).find((r) => r.key === 'rk:747');
  assert.equal(inParent?.done, true, 'the parent did not see the finish');
  assert.equal(inView?.done, true);
  await queues.clearDone('strips', ['rk:747']);
});

// --------------------------------------------------------------------------- //
// The lineup is narrowed
// --------------------------------------------------------------------------- //
await ok('the view’s lineup drops an entry outside its libraries', async () => {
  const provider = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const cfg = routing.loadSets(SETS_PATH)!.sets.strips!;
  const play = await pullLineup('strips', cfg, provider) as KavitaPlayItem[];
  // 500 lives in library 2 and must not be here. 777 has no library and is KEPT.
  assert.deepEqual(
    titlesOf(play),
    ['A Flame Reborn', 'A Hero Who Knows His Stuff', 'A Series With No Library'],
  );
});

await ok('the PARENT still plays everything', async () => {
  const provider = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const cfg = routing.loadSets(SETS_PATH)!.sets.reading!;
  const play = await pullLineup('reading', cfg, provider) as KavitaPlayItem[];
  assert.equal(play.length, 4, 'the parent lost entries to its own view’s filter');
});

// --------------------------------------------------------------------------- //
// The reading list is the ONE thing a view does not share
// --------------------------------------------------------------------------- //
await ok('the view builds its OWN reading list, titled with its own name', async () => {
  const client = stubClient();
  const provider = kavitaProvider({ def: DEF, client: asClient(client) });
  const cfg = routing.loadSets(SETS_PATH)!.sets.strips!;
  const play = await pullLineup('strips', cfg, provider) as KavitaPlayItem[];
  const artifact = await provider.materialize(
    play,
    { setName: 'strips', setLabel: 'Strips' },
  ) as KavitaArtifact;
  assert.match(artifact.title, /Strips/);
  assert.ok(!/Comics/.test(artifact.title), 'the view titled its list after the parent');
  assert.equal(client._lists.length, 1);
});

await ok('the two lists are separate, and neither rebuild touches the other', async () => {
  const client = stubClient();
  const provider = kavitaProvider({ def: DEF, client: asClient(client) });
  const reg = routing.loadSets(SETS_PATH)!;

  const parentPlay = await pullLineup('reading', reg.sets.reading!, provider) as KavitaPlayItem[];
  const parentList = await provider.materialize(
    parentPlay,
    { setName: 'reading', setLabel: 'Comics & Strips' },
  ) as KavitaArtifact;

  const viewPlay = await pullLineup('strips', reg.sets.strips!, provider) as KavitaPlayItem[];
  const viewList = await provider.materialize(
    viewPlay,
    { setName: 'strips', setLabel: 'Strips' },
  ) as KavitaArtifact;

  assert.equal(client._lists.length, 2, 'the view reused the parent’s reading list');
  assert.notEqual(String(parentList.readingListId), String(viewList.readingListId));
  assert.equal(parentList.count, 4);
  assert.equal(viewList.count, 3);
  // And the chapters really went to different lists.
  const toView = client._added.filter((a) => String(a.readingListId) === String(viewList.readingListId));
  assert.ok(
    !toView.some((a) => a.seriesId === 500),
    'the filtered-out series reached the view’s reading list',
  );
});

console.log(FAILS.length ? `\n${FAILS.length} FAILED: ${FAILS.join(', ')}` : '\nall passed');
process.exit(FAILS.length ? 1 : 0);
