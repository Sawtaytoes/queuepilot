// Two things on the Companion command path that cost latency, and one that cost correctness.
//
// (1) `companionTarget()` memoised a HIT and nothing else. A player that is advertising no
//     connection therefore re-asked plex.tv `/api/v2/devices` — a WAN round trip — on every
//     poll, every seek and every transport verb. "Advertising no connection" is exactly the
//     state Plex is in while it navigates between items, which is the moment a seek is about
//     to be due, so the miss was paid at the worst possible time. A miss is now cached for
//     COMPANION_MISS_TTL_MS.
//
// (2) A plex.tv FAILURE is not a miss. "Could not ask" and "asked, and it is not there" are
//     different answers, and caching the first would extend a network blip into a fixed
//     outage. The failure path must keep re-asking.
//
// (3) `commandID` was hardcoded to '1' on every Companion command. Companion's contract is a
//     monotonically increasing id per controlling client; a repeated id is only ambiguous
//     when two commands are in flight close together, which this app has never done. Fixed
//     ahead of the first caller that does.
//
// No Plex and no player: global `fetch` is replaced for the plex.tv calls.
//
// Run:  server/node_modules/.bin/tsx e2e/companion-target-cache-test.ts   (from the repo root)

// env.js reads process.env at module-eval, so these must precede the playback import.
process.env.PLEX_TOKEN = 'test-token';
process.env.COMPANION_MISS_TTL_MS = '10000';
// A dead local port, so `machineIdentifier()` fails immediately rather than reaching for a
// real Plex server. It already tolerates the failure — it caches the empty string.
process.env.PLEX_API_SERVER_URL = 'http://127.0.0.1:1';
// No direct URI, so `findClient()` goes through `companionTarget()` — which is the path under
// test. The name and id are the placeholders the fake plex.tv below answers with.
process.env.SHIELD_CLIENT_URI = '';
process.env.SHIELD_CLIENT_NAME = 'Living Room Player';
process.env.SHIELD_CLIENT_MACHINE_ID = 'aaaabbbbccccdddd';

const playback = await import('../server/src/playback.js');

let failed = 0;
const check = (label: string, isOk: boolean, detail = ''): void => {
  if (isOk) console.log(`PASS ${label}`);
  else {
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
};

// --- a fake plex.tv ----------------------------------------------------------- //

interface FakeRow { name: string; clientIdentifier: string; provides: string; connections: { uri: string }[] }

let calls = 0;
let rows: FakeRow[] = [];
let isBroken = false;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (): Promise<Response> => {
  calls += 1;
  if (isBroken) throw new Error('plex.tv unreachable');
  return new Response(JSON.stringify(rows), { status: 200 });
}) as typeof globalThis.fetch;

const TARGET_NAME = process.env.SHIELD_CLIENT_NAME!;
const TARGET_ID = process.env.SHIELD_CLIENT_MACHINE_ID!;

/** A player that IS advertising a direct Companion endpoint. */
const advertising: FakeRow[] = [{
  name: TARGET_NAME,
  clientIdentifier: TARGET_ID,
  provides: 'player,pubsub-player',
  connections: [{ uri: 'http://192.0.2.30:32500' }],
}];

/** The same player, mid-navigation: still a player, but with no connection to send to. */
const silent: FakeRow[] = [{
  name: TARGET_NAME,
  clientIdentifier: TARGET_ID,
  provides: 'player,pubsub-player',
  connections: [],
}];

// --- (1) the miss is cached --------------------------------------------------- //

let clockMs = 1_000_000;
const now = (): number => clockMs;

playback._resetCompanionTarget();
rows = silent;
calls = 0;
const missA = await playback.companionTarget(TARGET_NAME, TARGET_ID, { now });
const missB = await playback.companionTarget(TARGET_NAME, TARGET_ID, { now });
const missC = await playback.companionTarget(TARGET_NAME, TARGET_ID, { now });
check('a player advertising no connection still resolves to nothing',
  missA === null && missB === null && missC === null,
  JSON.stringify([missA, missB, missC]));
check('…and three lookups inside the TTL cost ONE plex.tv round trip, not three',
  calls === 1, `${calls} call(s)`);

// --- the miss expires --------------------------------------------------------- //

clockMs += 10_001;
calls = 0;
await playback.companionTarget(TARGET_NAME, TARGET_ID, { now });
check('past the TTL it asks again — a player coming back online is noticed',
  calls === 1, `${calls} call(s)`);

// --- a HIT clears the remembered miss ----------------------------------------- //

playback._resetCompanionTarget();
rows = silent;
calls = 0;
await playback.companionTarget(TARGET_NAME, TARGET_ID, { now });
clockMs += 10_001;
rows = advertising;
const hit = await playback.companionTarget(TARGET_NAME, TARGET_ID, { now });
check('the player coming online resolves to its direct endpoint',
  hit?.uri === 'http://192.0.2.30:32500', JSON.stringify(hit));
calls = 0;
const hitAgain = await playback.companionTarget(TARGET_NAME, TARGET_ID, { now });
check('…and the hit is memoised, as it always was',
  hitAgain?.uri === 'http://192.0.2.30:32500' && calls === 0, `${calls} call(s)`);

// --- (2) a plex.tv FAILURE is not cached as a miss ---------------------------- //

playback._resetCompanionTarget();
isBroken = true;
calls = 0;
const failA = await playback.companionTarget(TARGET_NAME, TARGET_ID, { now });
const failB = await playback.companionTarget(TARGET_NAME, TARGET_ID, { now });
check('a plex.tv failure resolves to nothing, as before',
  failA === null && failB === null, JSON.stringify([failA, failB]));
check('…and is NOT remembered — "could not ask" is not "it is not there"',
  calls === 2, `${calls} call(s)`);
isBroken = false;

// --- (3) commandID increases -------------------------------------------------- //
//
// Read through the public seam: every Companion verb builds its own params, so the ids are
// observed on the wire rather than off the counter.

// `undici.request` is what plexReq calls, and a module export cannot be swapped. So the ids
// are read where they are genuinely observable: a Companion host that records the URL it was
// asked for. A tiny local HTTP server is that host.
const seenIds: string[] = [];
const http = await import('node:http');
const server = http.createServer((req, res) => {
  const params = new URLSearchParams((req.url || '').split('?')[1] || '');
  const id = params.get('commandID');
  if (id) seenIds.push(id);
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Failure: 200 OK');
});
await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;

playback._resetCompanionTarget();
playback._resetCommandId();
rows = [{
  name: TARGET_NAME,
  clientIdentifier: TARGET_ID,
  provides: 'player',
  connections: [{ uri: `http://127.0.0.1:${port}` }],
}];

await playback.transport('pause');
await playback.transport('resume');
await playback.seekTo(90_000);
await playback.transport('next');

check('four Companion commands carry four DIFFERENT command ids',
  new Set(seenIds).size === 4, JSON.stringify(seenIds));
check('…and they increase monotonically, which is what Companion asks for',
  seenIds.every((id, i) => i === 0 || Number(id) > Number(seenIds[i - 1])),
  JSON.stringify(seenIds));

// --- (4) a target handed in at arm time can go stale -------------------------- //
//
// Resolving the target ONCE per session is where most of the plex.tv cost went. The price of
// that is a cached address, and an address can stop working mid-session — the player takes a
// new one off DHCP, or plex.tv starts advertising a different connection. So a seek that
// fails against a HANDED-IN target drops what is memoised, resolves again and sends once
// more. A target the seek resolved for itself is already fresh, so its failure is final.

playback._resetCompanionTarget();
const before = seenIds.length;
const staleTarget = { name: TARGET_NAME, machineIdentifier: TARGET_ID, uri: 'http://127.0.0.1:1' };
const recovered = await playback.seekTo(90_000, { client: staleTarget });
check('a seek against a stale cached target re-resolves and lands',
  recovered.seeked === true, JSON.stringify(recovered));
check('…and the retry is ONE extra command, not a loop',
  seenIds.length === before + 1, `${seenIds.length - before} command(s)`);

playback._resetCompanionTarget();
rows = silent; // nothing to re-resolve TO
const unrecoverable = await playback.seekTo(90_000, { client: staleTarget });
check('a seek with nothing to fall back to reports the failure rather than hanging on it',
  unrecoverable.seeked === false && Boolean(unrecoverable.error), JSON.stringify(unrecoverable));

await new Promise<void>((resolve) => { server.close(() => resolve()); });
globalThis.fetch = realFetch;

console.log(failed ? `companion-target-cache FAILED (${failed})` : 'companion-target-cache OK');
process.exit(failed ? 1 : 0);
