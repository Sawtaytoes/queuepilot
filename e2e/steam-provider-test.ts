// Steam provider — OFFLINE. No network, no key, no Valve.
//
// What this pins, in order of how badly it would hurt to get wrong:
//
//   1. PROGRESS IS COUNTED FROM `queued_at`, never from `playtime_forever`. The account this
//      was built against has a 508-hour game in it. If lifetime playtime were ever counted,
//      every game the owner has ever touched would be "played" the instant it was queued and
//      the queue would retire itself on the first read.
//   2. NO `queued_at` MEANS NOT PLAYED. This is the opposite of the Board Game Picker's
//      pre-stamp behaviour, and deliberately so: there, a lifetime log with no stamp reads as
//      finished; here it must read as waiting, because retiring an unplayed game is the
//      failure the owner would actually notice.
//   3. PRIVACY. This repo is public. The client touches ONE Valve endpoint and the art CDN;
//      it never asks for the profile, the friends list, or anything else carrying people.
//   4. A PRIVATE PROFILE FAILS LOUDLY. Steam answers 200 with an empty body when game
//      details are private — indistinguishable from "owns nothing" unless it is called out.
//   5. The library response is fetched ONCE for many questions. ~960 games and a search box
//      that fires per keystroke is nine full downloads to type "elden".
//   6. `handoff()` returns `steam://rungameid/<appid>`.
//
// Run:  server/node_modules/.bin/tsx e2e/steam-provider-test.ts   (repo root)
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { errMessage } from '../server/src/errors.js';
import type { BucketsResult, SteamArtifact } from '../server/src/types.js';
import type { SteamGameDto, SteamHttpClient } from '../server/src/providers/steam-client.js';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'steam-'));
const SETS_PATH = path.join(SCRATCH, 'sets.yaml');
const QUEUES_PATH = path.join(SCRATCH, 'queues.yaml');
process.env.PROVIDERS_PATH = path.join(SCRATCH, 'providers.yaml');
process.env.PROVIDERS_SECRETS_PATH = path.join(SCRATCH, 'providers.secrets.yaml');
process.env.SETS_PATH = SETS_PATH;
process.env.QUEUES_PATH = QUEUES_PATH;
process.env.CACHE_PATH = path.join(SCRATCH, 'cache.sqlite');
process.env.STEAM_ID = '76561190000000000';
process.env.STEAM_WEB_API_KEY = 'not-a-real-key';

writeFileSync(
  QUEUES_PATH,
  'pc:\n'
  + '  - ratingKey: 1245620\n    title: Deep Ring\n'
  + '  - ratingKey: 251470\n    title: Tower Drop\n',
);
writeFileSync(
  SETS_PATH,
  'sets:\n'
  + '  - id: pc\n    label: PC games\n    source: queue\n'
  + '    providers:\n      - provider: steam\n',
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

const DEF = { id: 'steam', kind: 'steam', label: 'Steam', base_url: '' };

const QUEUED = Math.floor(Date.parse('2026-08-10T00:00:00.000Z') / 1000);
const BEFORE_QUEUED = Math.floor(Date.parse('2026-06-01T00:00:00.000Z') / 1000);
const AFTER_QUEUED = Math.floor(Date.parse('2026-08-15T02:31:19.000Z') / 1000);

/**
 * The invented library. `1245620` is the trap: a lifetime of playing, but the last session
 * ended BEFORE it was queued — so it is waiting, not finished.
 */
const GAMES: SteamGameDto[] = [
  { appid: 1245620, name: 'Deep Ring', playtime_forever: 30480, rtime_last_played: BEFORE_QUEUED },
  { appid: 251470, name: 'Tower Drop', playtime_forever: 4438, rtime_last_played: AFTER_QUEUED },
  { appid: 61730, name: 'Critter Crunch', playtime_forever: 0 },
];

const asClient = (c: unknown) => c as unknown as SteamHttpClient;

function stubClient(games: SteamGameDto[] = GAMES) {
  return {
    library: () => Promise.resolve(games),
    game: (appid: string) => Promise.resolve(games.find((g) => String(g.appid) === String(appid)) || null),
    search: (q: string) => Promise.resolve(
      games.filter((g) => String(g.name).toLowerCase().includes(q.toLowerCase())),
    ),
    cover: () => Promise.resolve({ buffer: Buffer.from('jpg'), contentType: 'image/jpeg' }),
  };
}

const { steamProvider } = await import('../server/src/providers/steam.js');
const { steamClient } = await import('../server/src/providers/steam-client.js');
const { publicView, definitionFor, isConfigured } = await import('../server/src/providers/config.js');

const provider = (games: SteamGameDto[] = GAMES) => steamProvider({
  def: DEF, apiKey: 'stub', steamId: 'stub', client: asClient(stubClient(games)),
});

// --- the load-bearing one ------------------------------------------------------ //

await ok('counts from queued_at, never from lifetime playtime', async () => {
  const res: BucketsResult = await provider().buckets({
    cfg: {},
    entries: [{ id: '1245620', queuedAt: QUEUED }],
  });

  // 508 hours behind it, last played before it was queued => still waiting.
  const buckets = res.buckets as { appid: string; played: number; remaining: number }[];
  assert.equal(buckets[0]?.played, 0, 'lifetime playtime was counted as progress');
  assert.equal(buckets[0]?.remaining, 1);
  assert.equal(res.play.length, 1);
  assert.equal((res.play[0] as { appid: string }).appid, '1245620');
});

await ok('a session that ended AFTER queueing finishes the entry', async () => {
  const res = await provider().buckets({ cfg: {}, entries: [{ id: '251470', queuedAt: QUEUED }] });
  assert.equal(res.play.length, 0, 'a played game was still offered');
  assert.deepEqual(res.newlyDone, ['251470']);
});

await ok('no queued_at reads as NOT played — the conservative direction', async () => {
  // Opposite of the picker on purpose; see this file's header. A 508-hour game with no stamp
  // must not retire itself before the owner has played it once from this queue.
  const res = await provider().buckets({ cfg: {}, entries: [{ id: '1245620', queuedAt: null }] });
  assert.equal(res.play.length, 1, 'an unstamped entry was treated as already played');
});

await ok('a game never played is never done', async () => {
  const res = await provider().buckets({ cfg: {}, entries: [{ id: '61730', queuedAt: QUEUED }] });
  assert.equal(res.play.length, 1);
  assert.deepEqual(res.newlyDone, []);
});

// --- lineup rules -------------------------------------------------------------- //

await ok('entries beat libraries: no entries is an empty lineup, not the library', async () => {
  const res = await provider().buckets({ cfg: {}, entries: [], libraries: ['library'] });
  assert.deepEqual(res.play, []);
});

await ok('the head is the first unplayed entry, and only one is ever offered', async () => {
  const res = await provider().buckets({
    cfg: {},
    // Tower Drop is already played; Deep Ring is not.
    entries: [{ id: '251470', queuedAt: QUEUED }, { id: '1245620', queuedAt: QUEUED }],
  });
  assert.equal(res.play.length, 1, 'a session is a whole evening — there is no batch');
  assert.equal((res.play[0] as { appid: string }).appid, '1245620');
});

await ok('a game no longer owned drops out instead of breaking the queue', async () => {
  const res = await provider().buckets({
    cfg: {},
    entries: [{ id: '999999', queuedAt: QUEUED }, { id: '1245620', queuedAt: QUEUED }],
  });
  assert.equal((res.play[0] as { appid: string }).appid, '1245620');
});

await ok('progressState answers the played set', async () => {
  const done = await provider().progressState({
    cfg: {},
    entries: [{ id: '251470', queuedAt: QUEUED }, { id: '1245620', queuedAt: QUEUED }],
  });
  assert.deepEqual([...(done as Set<string>)], ['251470']);
});

// --- tiles --------------------------------------------------------------------- //

await ok('a played tile reads as finished, an unplayed one has a next-up', async () => {
  const rows = await provider().tiles?.(
    ['1245620', '251470'],
    [{ id: '1245620', queuedAt: QUEUED }, { id: '251470', queuedAt: QUEUED }] as never,
  );
  assert.equal(rows?.[0]?.unreadCount, 1);
  assert.equal(rows?.[0]?.next?.unit, 'play');
  assert.equal(rows?.[1]?.unreadCount, 0);
  assert.equal(rows?.[1]?.next, null, 'a played game still offered a next-up');
});

// --- handoff ------------------------------------------------------------------- //

await ok('handoff is a steam:// url for the head', async () => {
  const p = provider();
  const res = await p.buckets({ cfg: {}, entries: [{ id: '1245620', queuedAt: QUEUED }] });
  const artifact = await p.materialize(res.play, { setName: 'pc' }) as SteamArtifact;
  assert.equal(artifact.appid, '1245620');
  assert.equal(artifact.url, 'steam://rungameid/1245620');
  const out = await p.handoff(artifact);
  assert.equal((out as { url: string }).url, 'steam://rungameid/1245620');
});

await ok('an empty lineup hands off an error, never a bare steam:// url', async () => {
  const p = provider();
  const artifact = await p.materialize([], { setName: 'pc' }) as SteamArtifact;
  const out = await p.handoff(artifact);
  assert.equal((out as { url: string | null }).url, null);
});

// --- configuration -------------------------------------------------------------- //

await ok('the implicit definition appears, and is configured by key + account', async () => {
  assert.equal(isConfigured('steam', 'steam'), true);
  const def = definitionFor('steam');
  assert.ok(def, 'no implicit steam definition — STEAM_ID should have produced one');
  const view = publicView(def);
  assert.equal(view.configured, true);
  assert.equal(view.supported, true);
  assert.equal(view.delivery, 'pull');
  assert.equal(view.vocabulary.unit, 'play');
  assert.equal(view.vocabulary.member, 'game');
  assert.equal(view.vocabulary.name, 'Steam');
});

await ok('a missing key reports NOT CONFIGURED by name, never an anonymous request', async () => {
  const saved = process.env.STEAM_WEB_API_KEY;
  delete process.env.STEAM_WEB_API_KEY;
  try {
    const { providerFor } = await import('../server/src/providers/index.js');
    assert.throws(() => providerFor('steam'), /NOT CONFIGURED/);
  } finally {
    process.env.STEAM_WEB_API_KEY = saved;
  }
});

// --- the client: privacy, memoization, private profiles ------------------------- //

function fetchStub(body: unknown, { status = 200 }: { status?: number } = {}) {
  const calls: string[] = [];
  const impl = (url: string) => {
    calls.push(url);
    return Promise.resolve(new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }));
  };
  return { calls, impl };
}

await ok('the client asks Valve for ONE endpoint, and never for people', async () => {
  const { calls, impl } = fetchStub({ response: { games: GAMES } });
  const c = steamClient({ apiKey: 'k', steamId: 's', fetchImpl: impl as never });
  await c.library();
  await c.search('drop');
  await c.game('251470');

  assert.ok(calls.length > 0, 'the stub saw no calls at all');
  assert.ok(
    calls.every((u) => u.includes('/IPlayerService/GetOwnedGames/')),
    `something other than GetOwnedGames was fetched: ${calls.join(', ')}`,
  );
  for (const forbidden of ['GetFriendList', 'GetPlayerSummaries', 'ISteamUser/']) {
    assert.ok(
      !calls.some((u) => u.includes(forbidden)),
      `a call reached ${forbidden}: ${calls.join(', ')}`,
    );
  }
});

await ok('the library is fetched once for many questions', async () => {
  const { calls, impl } = fetchStub({ response: { games: GAMES } });
  const c = steamClient({ apiKey: 'k', steamId: 's', fetchImpl: impl as never });
  // What typing "drop" into the editor actually does.
  await Promise.all(['d', 'dr', 'dro', 'drop'].map((q) => c.search(q)));
  await c.game('251470');
  assert.equal(calls.length, 1, `the library was downloaded ${calls.length} times`);
});

await ok('a PRIVATE profile fails loudly, and is not read as an empty library', async () => {
  // Steam answers 200 with `{"response":{}}` when game details are private. Read as an empty
  // library, that is a queue that silently renders as "you own nothing".
  const { impl } = fetchStub({ response: {} });
  const c = steamClient({ apiKey: 'k', steamId: 's', fetchImpl: impl as never });
  await assert.rejects(() => c.library(), /PRIVATE profile/);
});

await ok('search ranks a prefix match above a mid-string one', async () => {
  const { impl } = fetchStub({
    response: {
      games: [
        { appid: 1, name: 'Teleportation Simulator', playtime_forever: 900 },
        { appid: 2, name: 'Portal', playtime_forever: 10 },
      ],
    },
  });
  const c = steamClient({ apiKey: 'k', steamId: 's', fetchImpl: impl as never });
  const hits = await c.search('portal');
  assert.equal(hits[0]?.name, 'Portal', 'playtime outranked the prefix match');
});

console.log(FAILS.length ? `\n${FAILS.length} FAILED: ${FAILS.join(', ')}` : '\nall steam provider gates passed');
process.exit(FAILS.length ? 1 : 0);
