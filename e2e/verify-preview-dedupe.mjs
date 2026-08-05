// Verifier for the pool-preview double-render fix: two same-target preview loads in
// flight (double Resample in one tick) must render the pool ONCE, not append twice.
// Boots the fake broker + THIS checkout's server against the fixture, like verify-members.
//
//   node e2e/verify-preview-dedupe.mjs
// Needs: root agentic .env (Plex token), e2e/broker deps (aedes), mux-magic playwright,
// PLAYWRIGHT_BROWSERS_PATH. Copies fixtures to /tmp — never touches real data.
import { chromium } from './playwright.mjs';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startFakeMqtt } from './fake-mqtt.mjs';


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // THIS checkout
const PORT = parseInt(process.env.WEB_PORT || '18784', 10);
const FAKE_MQTT_PORT = parseInt(process.env.FAKE_MQTT_PORT || '11887', 10);
const BASE = `http://localhost:${PORT}`;

const ok = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) process.exitCode = 1; };

async function waitReady(url, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server not ready: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-dedupe.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-dedupe.yaml');
for (const p of ['/tmp/queues-dedupe.yaml.lock', '/tmp/sets-dedupe.yaml.lock', '/tmp/.history-dedupe.json']) {
  await fs.rm(p, { recursive: true, force: true });
}

const fake = await startFakeMqtt({ port: FAKE_MQTT_PORT });
const srv = spawn('node', [`${ROOT}/server/src/server.js`], {
  env: {
    ...process.env,
    QUEUES_PATH: '/tmp/queues-dedupe.yaml',
    SETS_PATH: '/tmp/sets-dedupe.yaml',
    HISTORY_PATH: '/tmp/.history-dedupe.json',
    WEB_PORT: String(PORT),
    MQTT_HOST: '127.0.0.1',
    MQTT_PORT: String(FAKE_MQTT_PORT),
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function shutdown(code) {
  try { srv.kill(); } catch { /* */ }
  try { fake.client.end(true); } catch { /* */ }
  try { fake.server.close(); } catch { /* */ }
  try { fake.aedes.close(); } catch { /* */ }
  process.exit(code);
}

try {
  await waitReady(`${BASE}/api/queues`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  // Baseline: one load, let it settle.
  await page.goto(`${BASE}/#/channels/shows`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chpool li.tile', { timeout: 30000 });
  await page.waitForTimeout(500);
  const baseline = (await page.$$('#chpool li.tile')).length;
  ok(`baseline pool renders (${baseline} tiles)`, baseline > 0);

  // Double Resample in ONE tick: two same-target fresh loads in flight at once. The
  // stale-response guard must let only the newest render — the pre-fix bug appended both.
  await page.evaluate(() => {
    const b = document.getElementById('chresample');
    b.click();
    b.click();
  });
  await page.waitForSelector('#chpool li.tile', { timeout: 30000 });
  await page.waitForTimeout(1000); // both responses have landed by now
  const after = (await page.$$('#chpool li.tile')).length;
  ok(`double in-flight load renders once (${after} tiles, not ${baseline * 2})`, after === baseline);

  await browser.close();
  console.log('done');
  await shutdown(process.exitCode || 0);
} catch (e) {
  console.error('verify-preview-dedupe FAILED:', e);
  await shutdown(1);
}
