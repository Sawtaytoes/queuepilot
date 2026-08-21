// The Phase B gate: prove /api/queues is cache-backed the way the plan claims, by counting
// Plex HTTP calls against a STUB Plex server this test controls.
//
// It asserts three things the eyeball can't:
//   (a) the SECOND /api/queues makes ZERO Plex calls — everything served from cache.sqlite;
//   (b) a conditional GET with the prior ETag returns 304 with no body;
//   (c) a `now-playing` MQTT event invalidates EXACTLY the one show being watched — one
//       allLeaves refetch, nothing else — and busts the ETag.
//
// Correctness of the response SHAPE is api-v2-test.ts / verify-members.ts; this is purely
// about call counts. So the stub returns structurally-valid but content-arbitrary payloads.
import { killServer, spawnServer } from './stubs/server-process.mjs';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let failures = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};

// A one-entry queue is enough to prove the mechanism, and keeps the counts legible.
// queues.yaml's top-level keys ARE the set ids (no `sets:` wrapper — that is sets.yaml).
const QUEUES = 'perf:\n  - {title: "Test Show (2020)"}\n';
const SETS = `sets:
  - id: perf
    label: Perf
    kind: anime
    source: queue
    sections: [11]
`;
const QUEUES_PATH = '/tmp/perf-queues.yaml';
const SETS_PATH = '/tmp/perf-sets.yaml';
const CACHE_PATH = '/tmp/perf-cache.sqlite';
writeFileSync(QUEUES_PATH, QUEUES);
writeFileSync(SETS_PATH, SETS);
for (const f of [CACHE_PATH, `${CACHE_PATH}-wal`, `${CACHE_PATH}-shm`]) rmSync(f, { force: true });

// --- the stub Plex, counting calls by kind -------------------------------------------- //
/** The call ledger. Fixed keys (not an index signature) so the diff arithmetic below stays
 *  `number - number` under noUncheckedIndexedAccess. */
interface Calls {
  title: number;
  allLeaves: number;
  metadata: number;
  collections: number;
  sections: number;
  other: number;
}
const calls: Calls = { title: 0, allLeaves: 0, metadata: 0, collections: 0, sections: 0, other: 0 };
const SHOW_RK = '5001';
const EPISODE_RK = '5002'; // the leaf the "now-playing" event names; its grandparent is SHOW_RK

const plexStub = http.createServer((req, res) => {
  const url = req.url || '';
  res.setHeader('Content-Type', 'application/json');
  if (/\/library\/sections\/\d+\/all\?/.test(url)) {
    calls.title += 1;
    // One matching show, so the entry resolves and triggers an allLeaves call.
    return res.end(JSON.stringify({ MediaContainer: { Metadata: [{ ratingKey: SHOW_RK, type: 'show', title: 'Test Show', year: 2020, thumb: '/t.jpg' }] } }));
  }
  if (/\/library\/metadata\/\d+\/allLeaves/.test(url)) {
    calls.allLeaves += 1;
    return res.end(JSON.stringify({ MediaContainer: { updatedAt: 100, leafCount: 2, viewedLeafCount: 0, Metadata: [
      { ratingKey: EPISODE_RK, type: 'episode', parentIndex: 1, index: 1, title: 'Ep 1', duration: 1000, viewCount: 0 },
      { ratingKey: '5003', type: 'episode', parentIndex: 1, index: 2, title: 'Ep 2', duration: 1000, viewCount: 0 },
    ] } }));
  }
  if (/\/library\/metadata\//.test(url)) {
    calls.metadata += 1;
    // The now-playing leaf resolves to an episode whose grandparent IS the cached show.
    return res.end(JSON.stringify({ MediaContainer: { Metadata: [{ ratingKey: EPISODE_RK, type: 'episode', grandparentRatingKey: SHOW_RK, title: 'Ep 1' }] } }));
  }
  if (/\/library\/sections\/\d+\/collections/.test(url)) {
    calls.collections += 1;
    return res.end(JSON.stringify({ MediaContainer: { Metadata: [] } }));
  }
  if (/\/library\/sections(\?|$)/.test(url)) {
    calls.sections += 1;
    return res.end(JSON.stringify({ MediaContainer: { Directory: [{ key: '11', title: 'Anime', type: 'show' }] } }));
  }
  calls.other += 1;
  res.end(JSON.stringify({ MediaContainer: {} }));
});
await new Promise<void>((r) => plexStub.listen(0, () => r()));
// `address()` is `string | AddressInfo | null`; a TCP listen always yields the object form,
// and the throw is the honest read of "the stub never bound" rather than a cast.
const stubAddress = plexStub.address();
if (stubAddress === null || typeof stubAddress === 'string') {
  throw new Error('the stub Plex did not bind a TCP port');
}
const PLEX_PORT = stubAddress.port;

// --- a tiny MQTT broker for the now-playing invalidation (c) --------------------------- //
// Resolved from `import.meta.url` — see the note in `fake-mqtt.ts`. These named an absolute
// `/mnt/TrueNAS-Apps/Repos/plex-channels/...` that existed on exactly one machine.
const requireBroker = createRequire(new URL('./broker/node_modules/', import.meta.url).pathname);
const requireClient = createRequire(new URL('../server/node_modules/', import.meta.url).pathname);
const Aedes = requireBroker('aedes');
const mqtt = requireClient('mqtt');
const aedes = new Aedes();
const broker = net.createServer(aedes.handle);
const MQTT_PORT = 21883;
await new Promise<void>((r) => broker.listen(MQTT_PORT, () => r()));

const WEB_PORT = 18795;
const BASE = `http://localhost:${WEB_PORT}`;
const srv = spawnServer({
  cwd: ROOT,
  env: {
    ...process.env,
    WEB_PORT: String(WEB_PORT),
    QUEUES_PATH,
    SETS_PATH,
    CACHE_PATH,
    PLEX_API_SERVER_URL: `http://localhost:${PLEX_PORT}`,
    PLEX_TOKEN: 'stub',
    MQTT_HOST: 'localhost',
    MQTT_PORT: String(MQTT_PORT),
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
// Wait for readiness by LISTENING, never by `for await (… of srv.stdout) { break }`: breaking
// out of an async iterator destroys the stream, which closes the read end of the child's
// stdout pipe. The server survived that only for as long as it had nothing more to say —
// once the plex.tv device sweep started logging (`[devices] …`, which this suite triggers by
// connecting a real broker) the next console.log killed the server with EPIPE mid-run and the
// suite hung until its timeout. Draining for the whole run keeps the pipe open.
// `stdio` is an explicit triple above, so spawn's typings widen stdout to `Readable | null`.
const stdout = srv.stdout;
if (!stdout) throw new Error('server stdout was not piped');
await new Promise<void>((resolve) => {
  stdout.on('data', (chunk: Buffer | string) => { if (String(chunk).includes('listening on')) resolve(); });
});
stdout.resume(); // keep draining for the rest of the run — a full pipe would stall the server
// Give mqttc a moment to connect + subscribe.
await new Promise((r) => setTimeout(r, 500));

const getQueues = (etag?: string | null) =>
  fetch(`${BASE}/api/queues`, { headers: etag ? { 'If-None-Match': etag } : {} });

try {
  // 1. COLD — resolves the entry, makes real Plex calls.
  const cold = await getQueues();
  const coldTag = cold.headers.get('ETag');
  await cold.json();
  const coldTitle = calls.title;
  const coldLeaves = calls.allLeaves;
  ok('cold /api/queues hit Plex (title lookups)', coldTitle > 0, `title=${coldTitle}`);
  ok('cold /api/queues hit Plex (allLeaves)', coldLeaves > 0, `allLeaves=${coldLeaves}`);

  // 2. WARM — the SECOND call must make ZERO new Plex calls (all served from cache.sqlite).
  const before = { ...calls };
  const warm = await getQueues();
  await warm.json();
  const newCalls = (Object.keys(calls) as (keyof Calls)[])
    .reduce((n, k) => n + (calls[k] - before[k]), 0);
  ok('warm /api/queues makes 0 Plex calls', newCalls === 0, `new=${newCalls}`);

  // 3. 304 — the conditional GET with the prior ETag is empty and cheap.
  const notmod = await getQueues(coldTag);
  ok('conditional GET returns 304', notmod.status === 304, `status=${notmod.status}`);
  const body = await notmod.text();
  ok('304 has an empty body', body.length === 0, `len=${body.length}`);

  // 4. NOW-PLAYING INVALIDATION — publish a now-playing leaf whose grandparent is the cached
  //    show. onNowPlaying → dropLeaves(SHOW_RK) + bumpGeneration. The next /api/queues then
  //    refetches EXACTLY that one show's allLeaves and nothing else, and the ETag busts.
  const pub = mqtt.connect(`mqtt://localhost:${MQTT_PORT}`);
  await once(pub, 'connect');
  const beforeInval = { ...calls };
  pub.publish('queuepilot/now-playing', JSON.stringify({ ratingKey: EPISODE_RK, state: 'playing' }), { qos: 1 });
  // Let the server resolve the context (one metadata call) and invalidate.
  await new Promise((r) => setTimeout(r, 700));

  const after = await getQueues(coldTag);
  ok('now-playing busted the ETag (not 304)', after.status === 200, `status=${after.status}`);
  await after.json();
  const leavesRefetched = calls.allLeaves - beforeInval.allLeaves;
  const titleRefetched = calls.title - beforeInval.title;
  ok('now-playing → exactly one allLeaves refetch', leavesRefetched === 1, `allLeaves=${leavesRefetched}`);
  ok('now-playing → no title re-resolution (still cached)', titleRefetched === 0, `title=${titleRefetched}`);

  pub.end();
}
finally {
  killServer(srv);
  await once(srv, 'exit').catch(() => {});
  aedes.close();
  broker.close();
  plexStub.close();
  for (const f of [QUEUES_PATH, SETS_PATH, CACHE_PATH, `${CACHE_PATH}-wal`, `${CACHE_PATH}-shm`]) rmSync(f, { force: true });
}

console.log(failures ? `\n${failures} assertion(s) failed` : '\nall perf-queues assertions passed');
process.exit(failures ? 1 : 0);
