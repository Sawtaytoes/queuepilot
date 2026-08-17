// SPIKE (not a gate): can a LIVE Plex playQueue be extended in place?
//
// Phase 3's whole UX promise rests on this. If `PUT /playQueues/{id}?uri=…` appends to an
// existing queue, a top-up is invisible mid-episode. If it does not, the fallback is "build a
// new playQueue and resume at the current item", which the viewer FEELS — so the answer
// changes what infinite can promise, and must be known before phase 3 is built on it.
//
// Deliberately standalone (raw fetch, no engine imports): a spike must not require exporting
// internals it may turn out not to need, and `plexReq` is module-private on purpose.
//
// Creates a playQueue and never pushes it at a device: NOTHING PLAYS.
//
// Run: set -a; source /mnt/TrueNAS-Apps/Repos/agentic/.env; set +a
//      server/node_modules/.bin/tsx e2e/spike-playqueue-extend.ts
const { PLEX_URL, PLEX_TOKEN } = await import('../server/src/config.js');

const CLIENT_ID = 'queuepilot-spike';

type MC = { MediaContainer?: Record<string, unknown> };

async function req(method: 'GET' | 'POST' | 'PUT', path: string): Promise<MC> {
  const res = await fetch(PLEX_URL + path, {
    method,
    headers: { 'X-Plex-Token': PLEX_TOKEN, 'X-Plex-Client-Identifier': CLIENT_ID, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text) as MC; } catch { return {} as MC; }
}

const size = (d: MC) => (d?.MediaContainer?.size as number | undefined) ?? null;
const metadata = (d: MC) => ((d?.MediaContainer?.Metadata as { ratingKey?: string }[] | undefined) || []);

const ident = await req('GET', '/identity');
const mid = String(ident?.MediaContainer?.machineIdentifier || '');
if (!mid) { console.error('no machineIdentifier from /identity'); process.exit(1); }

// Three arbitrary movies to spike with: two to seed, one to append.
const section = await req('GET', '/library/sections/1/all?type=1&X-Plex-Container-Start=0&X-Plex-Container-Size=3');
const seed = metadata(section).map((m) => String(m.ratingKey));
if (seed.length < 3) { console.error(`need 3 items, section 1 gave ${seed.length}`); process.exit(1); }
const [a, b, c] = seed as [string, string, string];
console.log(`seed ${a}, ${b} — will append ${c}`);

const uriFor = (keys: string[]) => `server://${mid}/com.plexapp.plugins.library/library/metadata/${keys.join(',')}`;

const created = await req('POST', `/playQueues?${new URLSearchParams({
  type: 'video', uri: uriFor([a, b]), continuous: '1', 'X-Plex-Client-Identifier': CLIENT_ID,
})}`);
const pqId = created?.MediaContainer?.playQueueID;
console.log(`created playQueue ${pqId}, size ${size(created)}`);
if (!pqId) { console.error('no playQueueID'); process.exit(1); }

// PUT /playQueues/{id}?uri=… is the documented "add to queue" spelling. `next=0` appends at
// the END rather than immediately after the playing item — a top-up must never jump the queue.
let putSize: number | null = null;
let putErr: string | null = null;
try {
  const extended = await req('PUT', `/playQueues/${pqId}?${new URLSearchParams({
    uri: uriFor([c]), next: '0', 'X-Plex-Client-Identifier': CLIENT_ID,
  })}`);
  putSize = size(extended);
  console.log(`PUT ok, returned size ${putSize}`);
} catch (e) {
  putErr = String(e);
  console.log(`PUT failed: ${putErr}`);
}

// Verify by RE-READING the queue, never by trusting the PUT's own response body.
const after = await req('GET', `/playQueues/${pqId}?${new URLSearchParams({ 'X-Plex-Client-Identifier': CLIENT_ID })}`);
const keys = metadata(after).map((m) => String(m.ratingKey));
console.log(`re-read ${pqId}: size ${size(after)}, items [${keys.join(', ')}]`);

const sameId = String(after?.MediaContainer?.playQueueID) === String(pqId);
const appendedAtEnd = keys.length === 3 && keys[2] === c;
console.log('');
console.log(`VERDICT: id preserved = ${sameId}, appended at end = ${appendedAtEnd}`);
console.log(sameId && appendedAtEnd
  ? '=> extend-in-place WORKS. Top-up can be invisible mid-episode.'
  : '=> extend-in-place did NOT work. Phase 3 needs the rebuild+resume fallback.');
