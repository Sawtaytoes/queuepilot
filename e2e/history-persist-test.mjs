// Undo history survives a server restart (the file-backed stack in history.js).
// Self-contained: spawns its OWN server on a private port + private temp files — no
// browser, no MQTT, no Plex (the sets registry serves with Plex down).
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

const PORT = 18770;
const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  QUEUES_PATH: '/tmp/queues-hist.yaml',
  SETS_PATH: '/tmp/sets-hist.yaml',
  HISTORY_PATH: '/tmp/history-hist.json',
};
const ok = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) process.exitCode = 1; };
const api = (p, opts) => fetch(`http://localhost:${PORT}/api${p}`, opts).then((r) => r.json());
const patch = (p, body) =>
  api(p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

for (const f of ['/tmp/queues-hist.yaml', '/tmp/sets-hist.yaml', '/tmp/history-hist.json']) {
  await fs.rm(f, { force: true });
  await fs.rm(f + '.lock', { recursive: true, force: true });
}
await fs.copyFile(new URL('./fixtures/queues.fixture.yaml', import.meta.url), '/tmp/queues-hist.yaml');

async function startServer() {
  const child = spawn('node', ['server/src/server.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await api('/history'); return child; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('server did not come up');
}
const stop = (child) => new Promise((r) => { child.once('exit', r); child.kill(); });

let srv = await startServer();
const ids = (await api('/sets')).sets.map((s) => s.id);
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
