// Undo history survives a server restart (the file-backed stack in history.js).
// Self-contained: spawns its OWN server on a private port + private temp files — no
// browser, no MQTT, no Plex (the sets registry serves with Plex down).
import { killServer, spawnServer } from './stubs/server-process.mjs';
import { promises as fs } from 'node:fs';
import type { ChildProcess } from 'node:child_process';

const PORT = 18770;
const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  QUEUES_PATH: '/tmp/queues-hist.yaml',
  SETS_PATH: '/tmp/sets-hist.yaml',
  HISTORY_PATH: '/tmp/history-hist.json',
};
/**
 * A JSON body off the API. `Response.json()` is honestly `unknown`, and this suite reads
 * into payloads the server itself produces (`{undo, redo}`, `sets[].id`) — so the cast
 * lives HERE, once and documented, rather than at every read below.
 */
type JsonBody = Record<string, any>;

const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) process.exitCode = 1; };
const api = (p: string, opts?: RequestInit): Promise<JsonBody> =>
  fetch(`http://localhost:${PORT}/api${p}`, opts).then((r) => r.json() as Promise<JsonBody>);
const patch = (p: string, body: unknown) =>
  api(p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

for (const f of ['/tmp/queues-hist.yaml', '/tmp/sets-hist.yaml', '/tmp/history-hist.json']) {
  await fs.rm(f, { force: true });
  await fs.rm(f + '.lock', { recursive: true, force: true });
}
await fs.copyFile(new URL('./fixtures/queues.fixture.yaml', import.meta.url), '/tmp/queues-hist.yaml');

async function startServer(): Promise<ChildProcess> {
  const child = spawnServer({ env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await api('/history'); return child; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('server did not come up');
}
const stop = (child: ChildProcess) => new Promise((r) => { child.once('exit', r); killServer(child); });

let srv = await startServer();
const ids = (await api('/sets')).sets.map((s: JsonBody) => s.id);
await patch('/sets-order', { ids }); // any mutation — the middleware snapshots first
const h1 = await api('/history');
ok(`mutation snapshots (undo=${h1.undo})`, h1.undo === 1);
await stop(srv);

srv = await startServer();
const h2 = await api('/history');
ok(`history survives restart (undo=${h2.undo} redo=${h2.redo})`, h2.undo === 1 && h2.redo === 0);
const u = await api('/undo', { method: 'POST' });
ok('undo works from the reloaded stack', u.ok === true);
const h3 = await api('/history');
ok(`undo moved it to redo (undo=${h3.undo} redo=${h3.redo})`, h3.undo === 0 && h3.redo === 1);
await stop(srv);

srv = await startServer();
const h4 = await api('/history');
ok(`redo stack survives too (redo=${h4.redo})`, h4.redo === 1);
const r = await api('/redo', { method: 'POST' });
ok('redo works from the reloaded stack', r.ok === true);
await stop(srv);
console.log('done');
