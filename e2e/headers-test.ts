// Browserless regression gate for the Phase A transfer/caching work (compression +
// pre-compressed siblings + cache headers). A future edit to the server's static-serving
// wiring can silently undo any of these — the bytes still render, so no browser suite would
// notice — which is exactly why this asserts the HEADERS directly. It is also the evidence
// that swapping the hand-rolled block for `@charcuterie/server` was behaviour-preserving:
// it passes against that package UNMODIFIED.
//
// Boots THIS checkout's server against the fixture on a private port, then makes raw fetches
// with hand-set Accept-Encoding. Needs the Vite build present (web/dist) — e2e/run.sh builds
// it; run `npm --prefix web run build` first if invoking this alone.
import { killServer, spawnServer } from './stubs/server-process.mjs';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.WEB_PORT || 18790;
const BASE = `http://localhost:${PORT}`;

let failures = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};

// The hashed asset filenames change every build, so discover one .js from the build output
// rather than hardcoding it. (dist must exist — see the header comment.)
function findHashedAsset(ext: string): string {
  const dir = path.join(ROOT, 'web', 'dist', 'assets');
  const hit = readdirSync(dir).find((f) => f.endsWith(ext) && !f.endsWith('.br') && !f.endsWith('.gz'));
  if (!hit) throw new Error(`no ${ext} asset in web/dist/assets — run the web build first`);
  return `/assets/${hit}`;
}

const srv = spawnServer({
  cwd: ROOT,
  env: {
    ...process.env,
    WEB_PORT: String(PORT),
    QUEUES_PATH: '/tmp/queues-headers.yaml',
    SETS_PATH: '/tmp/sets-headers.yaml',
    MQTT_HOST: '',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
// Wait for the listen line. `stdio` is an explicit triple above, so `spawn`'s typings widen
// stdout to `Readable | null` — the throw is the honest read of "this suite cannot work
// without the pipe it just asked for", not a cast.
const stdout = srv.stdout;
if (!stdout) throw new Error('server stdout was not piped');
for await (const chunk of stdout) {
  if (String(chunk).includes('listening on')) break;
}

try {
  const asset = findHashedAsset('.js');

  // 1. A hashed asset, requested WITH brotli, comes back brotli-encoded from the .br sibling,
  //    typed from the ORIGINAL extension, one-year immutable, and Vary: Accept-Encoding.
  const br = await fetch(`${BASE}${asset}`, { headers: { 'Accept-Encoding': 'br' } });
  ok('hashed asset: content-encoding br', br.headers.get('content-encoding') === 'br',
    br.headers.get('content-encoding') || '(none)');
  ok('hashed asset: js content-type preserved', /javascript/.test(br.headers.get('content-type') || ''),
    br.headers.get('content-type') || '(none)');
  ok('hashed asset: immutable 1y cache', /immutable/.test(br.headers.get('cache-control') || '') && /max-age=31536000/.test(br.headers.get('cache-control') || ''),
    br.headers.get('cache-control') || '(none)');
  ok('hashed asset: Vary Accept-Encoding', /accept-encoding/i.test(br.headers.get('vary') || ''),
    br.headers.get('vary') || '(none)');

  // 2. gzip fallback for a client that negotiates only gzip.
  const gz = await fetch(`${BASE}${asset}`, { headers: { 'Accept-Encoding': 'gzip' } });
  ok('hashed asset: gzip fallback', gz.headers.get('content-encoding') === 'gzip',
    gz.headers.get('content-encoding') || '(none)');

  // 3. A client that accepts NO encoding gets the raw file (no Content-Encoding), still cached.
  const raw = await fetch(`${BASE}${asset}`, { headers: { 'Accept-Encoding': 'identity' } });
  ok('hashed asset: identity has no content-encoding', !raw.headers.get('content-encoding'),
    raw.headers.get('content-encoding') || '(none)');
  ok('hashed asset: identity still immutable', /immutable/.test(raw.headers.get('cache-control') || ''));

  // 4. index.html is NOT hashed → must revalidate, never `immutable`.
  const html = await fetch(`${BASE}/`, { headers: { 'Accept-Encoding': 'br, gzip' } });
  ok('index.html: no-cache (revalidate)', /no-cache/.test(html.headers.get('cache-control') || ''),
    html.headers.get('cache-control') || '(none)');
  ok('index.html: not immutable', !/immutable/.test(html.headers.get('cache-control') || ''));

  // 5. The JSON API is dynamically compressed (a non-trivial body), and Content-Type is intact.
  const shelves = await fetch(`${BASE}/api/shelves`, { headers: { 'Accept-Encoding': 'gzip' } });
  ok('/api/shelves: json content-type', /application\/json/.test(shelves.headers.get('content-type') || ''),
    shelves.headers.get('content-type') || '(none)');

  // 6. THE SSE GATE. /api/events must NOT be compressed — a buffered event-stream looks dead.
  //    (sse-test.mjs is the behavioural gate; this is the header-level one.)
  const ev = await fetch(`${BASE}/api/events`, { headers: { 'Accept-Encoding': 'gzip, br' } });
  ok('/api/events: NOT content-encoded', !ev.headers.get('content-encoding'),
    ev.headers.get('content-encoding') || '(none)');
  ok('/api/events: event-stream type', /text\/event-stream/.test(ev.headers.get('content-type') || ''));
  await ev.body?.cancel();
}
finally {
  killServer(srv);
  await once(srv, 'exit').catch(() => {});
}

console.log(failures ? `\n${failures} header assertion(s) failed` : '\nall header assertions passed');
process.exit(failures ? 1 : 0);
