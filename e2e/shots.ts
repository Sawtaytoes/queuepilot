// Self-contained screenshotter for the dev harness: boots a FAKE MQTT broker + the Node
// server (rich fixtures, real Plex), drives each screen, and writes PNGs to __screenshots__/
// for visual review. No external server needed — it spawns and tears down everything.
//
//   server/node_modules/.bin/tsx e2e/shots.ts     # all screens
// Needs: root agentic .env (Plex token), e2e/broker deps (aedes), mux-magic playwright,
// PLAYWRIGHT_BROWSERS_PATH. Copies fixtures to /tmp — never touches real data.
import { chromium } from './playwright.js';
import { killServer, spawnServer, REPO_ROOT } from './stubs/server-process.mjs';
import { promises as fs } from 'node:fs';
import { startFakeMqtt } from './fake-mqtt.js';


const PORT = parseInt(process.env.WEB_PORT || '18780', 10);
const FAKE_MQTT_PORT = parseInt(process.env.FAKE_MQTT_PORT || '11883', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = '__screenshots__';
// THIS checkout — the same anchor every sibling harness uses. It was hardcoded to
// /mnt/TrueNAS-Apps/Repos/plex-channels (the pre-rename clone), which since the TS/Hono
// conversion would have shot a DIFFERENT repo's fixtures at this repo's server.
const ROOT = REPO_ROOT;

async function waitReady(url: string, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server not ready: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

// --- boot the stack --------------------------------------------------------- //
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-harness.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-harness.yaml');
for (const p of ['/tmp/queues-harness.yaml.lock', '/tmp/sets-harness.yaml.lock', '/tmp/.history-harness.json']) {
  await fs.rm(p, { recursive: true, force: true });
}

const fake = await startFakeMqtt({ port: FAKE_MQTT_PORT });
const srv = spawnServer({
  env: {
    ...process.env,
    QUEUES_PATH: '/tmp/queues-harness.yaml',
    SETS_PATH: '/tmp/sets-harness.yaml',
    HISTORY_PATH: '/tmp/.history-harness.json',
    WEB_PORT: String(PORT),
    MQTT_HOST: '127.0.0.1',
    MQTT_PORT: String(FAKE_MQTT_PORT),
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function shutdown(code: number) {
  killServer(srv);
  try { fake.client.end(true); } catch { /* */ }
  try { fake.server.close(); } catch { /* */ }
  try { fake.aedes.close(); } catch { /* */ }
  process.exit(code);
}

try {
  await waitReady(`${BASE}/api/queues`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const shot = async (name: string) => { await page.screenshot({ path: `${OUT}/${name}` }); console.log('wrote', `${OUT}/${name}`); };

  // 1. Play landing.
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.playrow', { timeout: 30000 });
  await page.waitForTimeout(500);
  await shot('harness-play.png');

  // 2. A movie queue grid (Collection tile + done tiles present).
  await page.goto(`${BASE}/#/q/bob`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#queue:not([hidden]) li.tile', { timeout: 30000 });
  await page.waitForTimeout(1200); // let posters/collection resolve
  await shot('harness-queue-bob.png');

  // 3. A curated (anime) channel grid.
  await page.goto(`${BASE}/#/q/bob_anime`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#queue:not([hidden]) li.tile', { timeout: 30000 });
  await page.waitForTimeout(1200);
  await shot('harness-channel-anime.png');

  // 4. Channels — Shows & Shorts (populated pool via fake MQTT).
  await page.goto(`${BASE}/#/channels/shows`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#channels:not([hidden])', { timeout: 30000 });
  await page.waitForSelector('#chpool li.tile', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await shot('harness-channels-shows.png');

  // 5. Channels — Movies (rewatch pool via fake MQTT).
  await page.goto(`${BASE}/#/channels/movies`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#channels:not([hidden])', { timeout: 30000 });
  await page.waitForSelector('#chpool li.tile', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await shot('harness-channels-movies.png');

  // 6. Dynamic-channel create modal (shows the ✕ close button — #4 verification).
  await page.goto(`${BASE}/#/channels`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#newdyn', { timeout: 30000 }).catch(() => {});
  const nd = await page.$('#newdyn');
  if (nd) {
    await nd.click(); await page.waitForSelector('#dynmodal[data-open]'); await page.waitForTimeout(400);
    await shot('harness-dynmodal.png');
    await page.keyboard.press('Escape'); await page.waitForSelector('#dynmodal', { state: 'detached' }).catch(() => {});
  }

  // 7. Queue Configure modal (setmodal) — the other ✕ (#4).
  await page.goto(`${BASE}/#/queues`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shelf', { timeout: 30000 }).catch(() => {});
  await page.hover('.shelf[data-set="bob"] h2').catch(() => {});
  const edit = await page.$('.shelf[data-set="bob"] .shelfedit');
  if (edit) {
    await edit.click(); await page.waitForSelector('#setmodal[data-open]'); await page.waitForTimeout(400);
    await shot('harness-setmodal.png');
    await page.keyboard.press('Escape'); await page.waitForSelector('#setmodal', { state: 'detached' }).catch(() => {});
  }

  // 8. Device menu ("Play on ▾") open on the Play landing (fake MQTT devices — #0 enabler).
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.playrow', { timeout: 30000 });
  const playBtn = await page.$('.playrow .playbtn');
  if (playBtn) { await playBtn.click(); await page.waitForTimeout(500); await shot('harness-devicemenu.png'); }

  await browser.close();
  console.log('shots: done');
  await shutdown(0);
} catch (e) {
  console.error('shots failed:', e);
  await shutdown(1);
}
