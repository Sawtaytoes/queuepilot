// SSE now-playing re-sync on (re)connect (browserless, self-contained). Regression for the
// slept-tab bug: a phone that backgrounds the browser drops the /api/events stream and misses
// the `now` event published while it was gone, so on return the now-playing tile showed the
// stale page-load value until a manual refresh. The fix has the server REPLAY the current
// retained now-playing snapshot to EVERY freshly-connected client — so a reconnect (a new
// EventSource) reconciles immediately, with no new MQTT publish.
//
// Two layers, so this runs in CI (no broker) yet still proves the end-to-end payload locally:
//   1. Always (no broker needed): a fresh /api/events connection is handed an `event: now`
//      frame in its opening burst, BEFORE any publish or file change. Before the fix the burst
//      was `hello` only and the client waited for the next change. Each connection gets its own.
//   2. When a fake MQTT broker is importable (local sandbox; skipped in CI): seed a RETAINED
//      now-playing, then a freshly-connected client's `now` frame carries THAT snapshot's
//      ratingKey — no publish after connect.
import { killServer, spawnServer } from './stubs/server-process.mjs';
import { promises as fs } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import type { FakeMqtt } from './fake-mqtt.js';

const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) process.exitCode = 1; };

/**
 * The `now` frame's payload. `JSON.parse` is `any` at the boundary and this is a wire
 * shape the server owns, so the two fields the assertions read are named and the rest is
 * left unchecked rather than mirrored from server/src/types.ts.
 */
interface NowFrame {
  now: { ratingKey?: unknown } | null;
  set?: unknown;
}

// Read the SSE stream for `ms`, WITHOUT sending anything, then abort and return the raw text.
async function readEvents(port: number, ms: number): Promise<string> {
  const ctrl = new AbortController();
  const res = await fetch(`http://localhost:${port}/api/events`, {
    headers: { accept: 'text/event-stream' },
    signal: ctrl.signal,
  });
  const decoder = new TextDecoder();
  let text = '';
  if (!res.body) throw new Error('/api/events answered with no body');
  const reader = res.body.getReader();
  /** A chunk, or the timeout sentinel the read is raced against. */
  type Step = { timeout: true } | (Awaited<ReturnType<typeof reader.read>> & { timeout?: undefined });
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const timeLeft = deadline - Date.now();
      const step = await Promise.race<Step>([
        reader.read(),
        new Promise<Step>((r) => setTimeout(() => r({ timeout: true }), timeLeft)),
      ]);
      if (step.timeout) break;
      if (step.done) break;
      text += decoder.decode(step.value, { stream: true });
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closing */ }
    ctrl.abort();
  }
  return text;
}

// Parse the FIRST `event: now` frame's JSON `data` out of an SSE text blob.
function firstNowFrame(text: string): NowFrame | null {
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    if (!lines.some((l) => l === 'event: now')) continue;
    const data = lines.find((l) => l.startsWith('data:'));
    if (!data) continue;
    try { return JSON.parse(data.slice(5).trim()) as NowFrame; } catch { return null; }
  }
  return null;
}

async function startServer(env: NodeJS.ProcessEnv, port: number): Promise<ChildProcess> {
  const child = spawnServer({ env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/api/history`);
      if (r.ok) return child;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not come up');
}
const stop = (child: ChildProcess | null) => new Promise<void>((r) => {
  if (!child) return r();
  child.once('exit', () => r());
  killServer(child);
});

// --- Layer 1: on-connect replay frame, no broker --------------------------------------- //
{
  const PORT = 18774;
  const QUEUES = '/tmp/queues-sse-resync.yaml';
  const SETS = '/tmp/sets-sse-resync.yaml';
  const HIST = '/tmp/history-sse-resync.json';
  for (const f of [QUEUES, SETS, HIST]) {
    await fs.rm(f, { force: true });
    await fs.rm(f + '.lock', { recursive: true, force: true });
  }
  await fs.writeFile(QUEUES, 'bob:\n- {title: "Plain Movie A (2020)"}\n', 'utf8');
  const env = {
    ...process.env,
    WEB_PORT: String(PORT),
    QUEUES_PATH: QUEUES,
    SETS_PATH: SETS,
    HISTORY_PATH: HIST,
    PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
    PLEX_TOKEN: '',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  };

  const srv = await startServer(env, PORT);
  try {
    const text = await readEvents(PORT, 1500);
    ok('opening burst includes the hello frame', /event: hello/.test(text));
    const now = firstNowFrame(text);
    // The regression: before the fix a fresh connection got `hello` only and waited for the
    // next publish. Now it is handed the current now-playing snapshot on connect.
    ok('fresh SSE connection is handed a `now` frame with NO publish', now !== null);
    ok('the replayed `now` frame has the {now,set} shape',
      now !== null && 'now' in now && 'set' in now);
    // No broker here, so nothing is playing — the snapshot is empty, but it MUST be delivered.
    ok('with nothing playing the snapshot is null (still delivered)', Boolean(now && now.now === null));

    // A SECOND, independent connection gets its own replay — this is the reconnect path (a
    // resumed tab opens a brand-new EventSource and must reconcile immediately).
    const text2 = await readEvents(PORT, 1500);
    ok('a second (reconnecting) client also gets its own `now` frame', firstNowFrame(text2) !== null);
  } finally {
    await stop(srv);
  }
}

// --- Layer 2: retained snapshot flows through the replay (needs a broker) --------------- //
// The fake broker require-resolves aedes from the primary checkout, which does not exist on a
// CI runner — so import it dynamically and SKIP cleanly when it is unavailable.
let startFakeMqtt: ((opts?: { port?: number }) => Promise<FakeMqtt>) | null = null;
try {
  ({ startFakeMqtt } = await import('./fake-mqtt.js'));
} catch {
  console.log('SKIP retained-snapshot layer (fake MQTT broker unavailable — expected in CI)');
}

if (startFakeMqtt) {
  const FAKE_PORT = 11884;
  const PORT = 18775;
  const QUEUES = '/tmp/queues-sse-resync2.yaml';
  const SETS = '/tmp/sets-sse-resync2.yaml';
  const HIST = '/tmp/history-sse-resync2.json';
  for (const f of [QUEUES, SETS, HIST]) {
    await fs.rm(f, { force: true });
    await fs.rm(f + '.lock', { recursive: true, force: true });
  }
  await fs.writeFile(QUEUES, 'bob:\n- {title: "Plain Movie A (2020)"}\n', 'utf8');

  const broker = await startFakeMqtt({ port: FAKE_PORT });
  // A concrete RETAINED now-playing — the snapshot the server must replay on connect. Plex is
  // pointed at a dead host, so withContext falls back to this raw payload (no resolve needed).
  const RETAINED = { state: 'playing', ratingKey: 424242, title: 'Retained Snapshot Movie', device: 'Family Room SHIELD' };
  await new Promise((resolve) => broker.client.publish(
    'queuepilot/now-playing', JSON.stringify(RETAINED), { qos: 1, retain: true }, resolve,
  ));

  const env = {
    ...process.env,
    WEB_PORT: String(PORT),
    QUEUES_PATH: QUEUES,
    SETS_PATH: SETS,
    HISTORY_PATH: HIST,
    PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
    PLEX_TOKEN: '',
    MQTT_HOST: '127.0.0.1',
    MQTT_PORT: String(FAKE_PORT),
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  };

  const srv = await startServer(env, PORT);
  try {
    // Give the server a moment to connect to the broker and receive the retained now-playing.
    await new Promise((r) => setTimeout(r, 800));
    const now = firstNowFrame(await readEvents(PORT, 1500));
    ok('freshly-connected client receives the retained now-playing on connect',
      now !== null && now.now !== null);
    ok('the replayed snapshot carries the retained ratingKey (no publish after connect)',
      Boolean(now && now.now && Number(now.now.ratingKey) === RETAINED.ratingKey));
  } finally {
    await stop(srv);
    try { broker.client.end(true); } catch { /* ignore */ }
    try { broker.server.close(); } catch { /* ignore */ }
    try { broker.aedes.close(); } catch { /* ignore */ }
  }
}

console.log('done');
