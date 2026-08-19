// MiSTer provider — OFFLINE. No network, no MiSTer.
//
// What this pins, in order of how badly it would hurt to get wrong:
//
//   1. IT NEVER CLAIMS PROGRESS. mrext keeps no history, so `progressState()` is empty and
//      `newlyDone` is empty — always. A provider that guessed (say, from `/games/playing`)
//      would retire a queued game because something else was launched from the MiSTer's own
//      menu, which is how most games actually get started in this house.
//   2. IT NEVER LAUNCHES. mrext exposes `POST /games/launch` and calling it would skip the
//      OSD save, the Xbox adapter enable and the activity switch that Home Assistant does
//      around a launch. The stub records every request and the suite asserts that path is
//      not among them.
//   3. A powered-down MiSTer is not an empty queue. A queue must still render — titles come
//      off the stored path, so tiles cost no network call at all.
//   4. Several named systems fan out and MERGE, because mrext takes one system per request.
//
// Run:  server/node_modules/.bin/tsx e2e/mister-provider-test.ts   (repo root)
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { errMessage } from '../server/src/errors.js';
import type { MisterArtifact } from '../server/src/types.js';
import type { MisterGameDto, MisterHttpClient } from '../server/src/providers/mister-client.js';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'mister-'));
process.env.PROVIDERS_PATH = path.join(SCRATCH, 'providers.yaml');
process.env.PROVIDERS_SECRETS_PATH = path.join(SCRATCH, 'providers.secrets.yaml');
process.env.SETS_PATH = path.join(SCRATCH, 'sets.yaml');
process.env.QUEUES_PATH = path.join(SCRATCH, 'queues.yaml');
process.env.CACHE_PATH = path.join(SCRATCH, 'cache.sqlite');
process.env.MISTER_API_SERVER_URL = 'https://mister.invalid';
writeFileSync(path.join(SCRATCH, 'sets.yaml'), 'sets: []\n');
writeFileSync(path.join(SCRATCH, 'queues.yaml'), '{}\n');

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

const DEF = { id: 'mister', kind: 'mister', label: 'MiSTer', base_url: 'https://mister.invalid' };

const SMW = '/media/fat/games/SNES/Games/Super Mario World (USA).zip/Super Mario World (USA).sfc';
const ZELDA = '/media/fat/games/NES/Games/Legend of Zelda, The (USA).zip/Legend of Zelda, The (USA).nes';

const GAMES: MisterGameDto[] = [
  { name: 'Super Mario World (USA)', path: SMW, system: { id: 'SNES', name: 'SNES' } },
  { name: 'Legend of Zelda, The (USA)', path: ZELDA, system: { id: 'NES', name: 'NES' } },
];

let CALLS: string[] = [];
const asClient = (c: unknown) => c as unknown as MisterHttpClient;

function stubClient() {
  return {
    _base: `${DEF.base_url}/api`,
    systems() {
      CALLS.push('/games/search/systems');
      return Promise.resolve([{ id: 'SNES', name: 'SNES' }, { id: 'NES', name: 'NES' }]);
    },
    search(query: string, system = 'all') {
      CALLS.push(`/games/search?q=${query}&system=${system}`);
      const term = query.toLowerCase();
      return Promise.resolve(
        GAMES.filter((g) => String(g.name).toLowerCase().includes(term))
          .filter((g) => system === 'all' || g.system?.id === system),
      );
    },
    playing() {
      CALLS.push('/games/playing');
      return Promise.resolve(null);
    },
  };
}

const { misterProvider, titleFromPath, systemFromPath } = await import('../server/src/providers/mister.js');
const { boxartUrls, LIBRETRO_SYSTEM } = await import('../server/src/providers/mister-boxart.js');
const {
  boxartCacheDir, isCachedMiss, readCachedArt, writeCachedArt,
} = await import('../server/src/providers/mister-boxart-cache.js');
const { publicView, definitionFor, isConfigured } = await import('../server/src/providers/config.js');

const provider = () => misterProvider({ def: DEF, client: asClient(stubClient()) });

// --- the load-bearing ones ------------------------------------------------------ //

await ok('never claims progress — mrext keeps no history', async () => {
  const p = provider();
  const done = await p.progressState({
    cfg: {},
    entries: [{ id: SMW, queuedAt: 1 }, { id: ZELDA, queuedAt: 1 }],
  });
  assert.equal((done as Set<string>).size, 0, 'progress was invented from somewhere');

  const res = await p.buckets({ cfg: {}, entries: [{ id: SMW }, { id: ZELDA }] });
  assert.deepEqual(res.newlyDone, [], 'an entry was retired without HA saying so');
});

await ok('never launches — /games/launch is not among the calls', async () => {
  CALLS = [];
  const p = provider();
  await p.libraries?.();
  await p.search?.('mario', { libraries: [] });
  const res = await p.buckets({ cfg: {}, entries: [{ id: SMW }] });
  const artifact = await p.materialize(res.play, { setName: 'retro' });
  await p.handoff(artifact as never);

  assert.ok(CALLS.length > 0, 'the stub saw no calls at all');
  assert.ok(
    !CALLS.some((c) => c.includes('/games/launch') || c.includes('/launch')),
    `a call reached a launch endpoint: ${CALLS.join(', ')}`,
  );
});

await ok('a tile needs no network call, so a sleeping MiSTer still renders its queue', async () => {
  CALLS = [];
  const rows = await provider().tiles?.([SMW, ZELDA]);
  assert.equal(CALLS.length, 0, `tiles hit the MiSTer ${CALLS.length} times`);
  assert.equal(rows?.[0]?.title, 'Super Mario World (USA)');
  assert.equal(rows?.[0]?.libraryId, 'SNES');
  assert.equal(rows?.[1]?.libraryId, 'NES');
  assert.equal(rows?.[0]?.unreadCount, 1);
  assert.equal(rows?.[0]?.next?.unit, 'play');
});

// --- search --------------------------------------------------------------------- //

await ok('no systems named searches everything, in ONE request', async () => {
  CALLS = [];
  const hits = await provider().search?.('mario', { libraries: [] });
  assert.deepEqual(hits?.map((h) => h.id), [SMW]);
  assert.deepEqual(CALLS, ['/games/search?q=mario&system=all']);
});

await ok('several named systems fan out and merge', async () => {
  // mrext takes ONE system per request, so this is N requests reduced to one list.
  CALLS = [];
  const hits = await provider().search?.('e', { libraries: ['SNES', 'NES'] });
  assert.equal(CALLS.length, 2, `expected one request per system, got ${CALLS.length}`);
  assert.deepEqual(hits?.map((h) => h.id).sort(), [ZELDA, SMW].sort());
});

await ok('an empty term asks nothing', async () => {
  CALLS = [];
  assert.deepEqual(await provider().search?.('', { libraries: [] }), []);
  assert.equal(CALLS.length, 0);
});

await ok('the libraries are the installed systems', async () => {
  const libs = await provider().libraries?.();
  assert.deepEqual(libs, [{ id: 'SNES', title: 'SNES' }, { id: 'NES', title: 'NES' }]);
});

// --- path helpers ---------------------------------------------------------------- //

await ok('a title and a system are derived from the stored path', async () => {
  assert.equal(titleFromPath(SMW), 'Super Mario World (USA)');
  assert.equal(systemFromPath(SMW), 'SNES');
  assert.equal(systemFromPath(ZELDA), 'NES');
  // A path that is nothing like the convention must not throw or invent a system.
  assert.equal(systemFromPath('nonsense'), '');
  assert.equal(titleFromPath(''), '');
});

// --- box art --------------------------------------------------------------------- //
//
// mrext serves no artwork, so the art comes from the libretro archive, which is keyed on
// No-Intro names — the naming this ROM share already uses. Measured 47/48 on real games
// before this was built; these gates pin the URL SHAPE, which is what would silently rot.

await ok('a mapped system builds boxart, title and snap urls in that order', async () => {
  const urls = boxartUrls('SNES', 'Super Mario World (USA)');
  assert.equal(urls.length, 3);
  assert.match(urls[0] as string, /Named_Boxarts/);
  assert.match(urls[1] as string, /Named_Titles/);
  assert.match(urls[2] as string, /Named_Snaps/);
  assert.equal(
    urls[0],
    'https://thumbnails.libretro.com/Nintendo%20-%20Super%20Nintendo%20Entertainment%20System'
    + '/Named_Boxarts/Super%20Mario%20World%20(USA).png',
  );
});

await ok('an UNMAPPED system returns nothing rather than guessing', async () => {
  // The failure this prevents: handing back a neighbouring console's art because a fuzzy
  // match looked close enough. A grey tile is honest; the wrong box is not.
  assert.deepEqual(boxartUrls('Galaksija', 'Anything'), []);
  assert.deepEqual(boxartUrls('', 'Anything'), []);
  assert.deepEqual(boxartUrls('SNES', ''), []);
});

await ok('a No-Intro name is used verbatim, ampersands and revisions included', async () => {
  // Stripping a region or a `(Rev 1)` tail is how a title stops matching the archive.
  const [rev] = boxartUrls('NES', 'Legend of Zelda, The (USA) (Rev 1)');
  assert.match(rev as string, /Legend%20of%20Zelda%2C%20The%20\(USA\)%20\(Rev%201\)\.png$/);
  const [amp] = boxartUrls('Genesis', 'Sonic & Knuckles (World)');
  assert.match(amp as string, /Sonic%20%26%20Knuckles/);
});

await ok('every mapped folder is a real libretro system name shape', async () => {
  // A typo here is invisible: it just 404s forever and the tile stays grey. Every value is
  // "Maker - System", which is the archive's own convention.
  for (const [system, folder] of Object.entries(LIBRETRO_SYSTEM)) {
    assert.ok(folder && folder.includes(' - '), `${system} -> ${folder} is not a maker-system name`);
  }
});

// --- the art cache ----------------------------------------------------------------- //
//
// This is the first provider whose art comes from the public internet rather than the LAN,
// at ~300 KB a tile. Measured before these gates were written: a hit goes 1 network request
// -> 0, and a MISS goes 3 -> 0. The miss is the half that matters, because a game with no
// art costs three requests (boxart, title, snap) on every single render and will never grow
// any.

await ok('a cached hit is byte-identical and needs no network', async () => {
  const art = Buffer.from('not really a png, but bytes are bytes');
  await writeCachedArt('SNES', 'Cached Game (USA)', art);
  const back = await readCachedArt('SNES', 'Cached Game (USA)');
  assert.ok(back, 'nothing came back out of the cache');
  assert.ok(back.equals(art), 'the cached bytes changed in transit');
});

await ok('a miss is remembered, so it costs three requests once rather than every render', async () => {
  assert.equal(await isCachedMiss('SNES', 'No Art At All (USA)'), false);
  await writeCachedArt('SNES', 'No Art At All (USA)', null);
  assert.equal(await isCachedMiss('SNES', 'No Art At All (USA)'), true);
  // A miss must not masquerade as a hit — the reader has to answer null, not an empty buffer.
  assert.equal(await readCachedArt('SNES', 'No Art At All (USA)'), null);
});

await ok('two games never collide, however awkward their names', async () => {
  // A No-Intro name carries `:` and `/`-hostile characters and runs long, which is why the
  // key is hashed rather than sanitized: every sanitizer eventually maps two titles to one.
  const a = Buffer.from('A');
  const b = Buffer.from('B');
  await writeCachedArt('SNES', 'Sonic 3: Knuckles & Co. (World) (Rev A)', a);
  await writeCachedArt('Genesis', 'Sonic 3: Knuckles & Co. (World) (Rev A)', b);
  assert.ok((await readCachedArt('SNES', 'Sonic 3: Knuckles & Co. (World) (Rev A)'))?.equals(a));
  assert.ok((await readCachedArt('Genesis', 'Sonic 3: Knuckles & Co. (World) (Rev A)'))?.equals(b));
});

await ok('the cache sits beside the sqlite cache, not somewhere surprising', async () => {
  assert.ok(boxartCacheDir().endsWith('/boxart'), boxartCacheDir());
  assert.ok(boxartCacheDir().startsWith(SCRATCH), `${boxartCacheDir()} is outside ${SCRATCH}`);
});

// --- lineup + handoff -------------------------------------------------------------- //

await ok('the head is the first entry left, and entries beat libraries', async () => {
  const p = provider();
  assert.deepEqual((await p.buckets({ cfg: {}, entries: [], libraries: ['SNES'] })).play, []);

  const res = await p.buckets({ cfg: {}, entries: [{ id: SMW }, { id: ZELDA }] });
  assert.equal(res.play.length, 1);
  assert.equal((res.play[0] as { path: string }).path, SMW);
});

await ok('handoff names what is next and hands back NO url', async () => {
  const p = provider();
  const res = await p.buckets({ cfg: {}, entries: [{ id: SMW }] });
  const artifact = await p.materialize(res.play, { setName: 'retro' }) as MisterArtifact;
  assert.equal(artifact.path, SMW);
  assert.equal(artifact.system, 'SNES');

  const out = await p.handoff(artifact as never);
  // No URL: there is no `steam://` equivalent, and a browser cannot start a MiSTer game.
  assert.equal((out as { url: string | null }).url, null);
  assert.match((out as { error: string }).error, /Super Mario World/);
});

// --- configuration ------------------------------------------------------------------ //

await ok('is configured by URL alone — mrext issues no token', async () => {
  assert.equal(isConfigured('mister', 'mister'), true);
  const def = definitionFor('mister');
  assert.ok(def, 'no implicit mister definition');
  const view = publicView(def);
  assert.equal(view.configured, true);
  assert.equal(view.supported, true);
  assert.equal(view.delivery, 'pull');
  assert.equal(view.vocabulary.member, 'game');
  assert.equal(view.vocabulary.name, 'MiSTer');
});

console.log(FAILS.length ? `\n${FAILS.length} FAILED: ${FAILS.join(', ')}` : '\nall mister provider gates passed');
process.exit(FAILS.length ? 1 : 0);
