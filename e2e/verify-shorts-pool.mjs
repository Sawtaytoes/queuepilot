// Verifier for the per-short eligible pool: a LIBRARY bucket (Shorts) must render one tile
// PER SHORT — shorts are standalone films, so a single "Shorts — 462 unwatched" tile never
// said what would actually play — and each tile's Exclude must block that short by itself.
// Boots the fake broker + THIS checkout's server against the fixture, like verify-members.
//
//   node e2e/verify-shorts-pool.mjs
// Needs: root agentic .env (Plex token), e2e/broker deps (aedes), mux-magic playwright,
// PLAYWRIGHT_BROWSERS_PATH. Copies fixtures to /tmp — never touches real data.
import { chromium } from './playwright.mjs';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startFakeMqtt } from './fake-mqtt.mjs';


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // THIS checkout
const PORT = parseInt(process.env.WEB_PORT || '18786', 10);
const FAKE_MQTT_PORT = parseInt(process.env.FAKE_MQTT_PORT || '11889', 10);
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

await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-shorts.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-shorts.yaml');
for (const p of ['/tmp/queues-shorts.yaml.lock', '/tmp/sets-shorts.yaml.lock', '/tmp/.history-shorts.json']) {
  await fs.rm(p, { recursive: true, force: true });
}

const fake = await startFakeMqtt({ port: FAKE_MQTT_PORT });
const srv = spawn('node', [`${ROOT}/server/src/server.js`], {
  env: {
    ...process.env,
    QUEUES_PATH: '/tmp/queues-shorts.yaml',
    SETS_PATH: '/tmp/sets-shorts.yaml',
    HISTORY_PATH: '/tmp/.history-shorts.json',
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

  await page.goto(`${BASE}/#/channels/younger`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chpool li.tile', { timeout: 30000 });
  await page.waitForTimeout(500);

  // The canned preview = 5 show buckets + one library bucket of 5 shorts.
  const titles = await page.$$eval('#chpool li.tile .title', (ts) => ts.map((t) => t.textContent));
  ok(`every short is its own tile (${titles.length} tiles)`, titles.length === 10);
  ok('short titles rendered, not a collapsed "Shorts" tile',
    titles.includes('8 Ball Bunny') && titles.includes('Tummy Trouble') && !titles.includes('Shorts'));
  ok('header still counts the whole pile',
    /5 shows \+ 24 shorts/.test(await page.textContent('#chpool-title')));

  // Exclude on a short blocks THAT short (blocklist is by ratingKey, so the rule pool
  // filters standalone items exactly like it filters shows).
  const idx = titles.indexOf('8 Ball Bunny');
  await page.$$eval('#chpool li.tile', (lis, i) => lis[i].querySelector('.exclude').click(), idx);
  await page.waitForFunction(async () => {
    const r = await fetch('/api/sets').then((x) => x.json());
    return r.sets.find((s) => s.id === 'younger')?.blocklist.includes('269283');
  }, null, { timeout: 15000 });
  ok('per-short Exclude writes that ratingKey to the blocklist', true);

  await browser.close();
  console.log('done');
  await shutdown(process.exitCode || 0);
} catch (e) {
  console.error('verify-shorts-pool FAILED:', e);
  await shutdown(1);
}
