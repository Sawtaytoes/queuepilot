// Focused visual verification for the v3 backlog items #4 (✕ contrast) and #5 (drag feedback).
// Boots the same offline stack as shots.ts, then: (a) zooms the modal ✕ glyph, and (b) drives
// a real mouse drag on a queue tile and screenshots MID-gesture so the lift/FLIP is visible.
import { chromium } from './playwright.js';
import { killServer, spawnServer, REPO_ROOT } from './stubs/server-process.mjs';
import { promises as fs } from 'node:fs';
import { startFakeMqtt } from './fake-mqtt.js';


const PORT = 18781;
const FAKE_MQTT_PORT = 11884;
const BASE = `http://localhost:${PORT}`;
const OUT = '__screenshots__';
// THIS checkout — the same anchor every sibling harness uses. It was hardcoded to the
// this repo's own checkout (formerly named plex-channels on disk), which since the TS/Hono conversion
// would have shot a DIFFERENT repo's fixtures at this repo's server.
const ROOT = REPO_ROOT;

async function waitReady(url: string, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* */ }
    if (Date.now() > deadline) throw new Error(`server not ready: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-v.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-v.yaml');
for (const p of ['/tmp/queues-v.yaml.lock', '/tmp/sets-v.yaml.lock', '/tmp/.history-v.json']) {
  await fs.rm(p, { recursive: true, force: true });
}
const fake = await startFakeMqtt({ port: FAKE_MQTT_PORT });
const srv = spawnServer({
  env: { ...process.env, QUEUES_PATH: '/tmp/queues-v.yaml', SETS_PATH: '/tmp/sets-v.yaml',
    HISTORY_PATH: '/tmp/.history-v.json', WEB_PORT: String(PORT),
    MQTT_HOST: '127.0.0.1', MQTT_PORT: String(FAKE_MQTT_PORT), NODE_TLS_REJECT_UNAUTHORIZED: '0' },
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
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });

  // --- #4: zoom the modal ✕ so the glyph legibility is unambiguous ------------ //
  await page.goto(`${BASE}/queues`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shelf', { timeout: 30000 });
  await page.hover('.shelf[data-set="bob"] h2');
  await page.click('.shelf[data-set="bob"] .shelfedit');
  await page.waitForSelector('#setmodal[data-open]');
  await page.waitForTimeout(300);
  const x = await page.$('#setmodal .modalx');
  if (!x) throw new Error('no #setmodal .modalx to zoom');
  const box = await x.boundingBox();
  if (!box) throw new Error('#setmodal .modalx is not laid out (no bounding box)');
  await page.screenshot({ path: `${OUT}/verify-x-button.png`,
    clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 } });
  console.log('wrote verify-x-button.png; ✕ visible/styled:', await x.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, background: s.backgroundColor, radius: s.borderRadius, text: el.textContent };
  }));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#setmodal[data-open]'));

  // --- #5: drive a real drag on a queue tile, screenshot MID-gesture --------- //
  await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#queue:not([hidden]) li.tile .thumb', { timeout: 30000 });
  await page.waitForTimeout(1000);
  const tiles = await page.$$('#grid li.tile');
  // The gesture needs a 1st and a 4th tile; a short grid is a fixture problem, and saying
  // so beats dragging from NaN and reporting "drag did not arm".
  const [srcTile, , , dstTile] = tiles;
  if (!srcTile || !dstTile) throw new Error(`need >= 4 tiles in #grid to drag, got ${tiles.length}`);
  const srcThumb = await srcTile.$('.thumb');
  if (!srcThumb) throw new Error('the drag source tile has no .thumb');
  const dstBox = await dstTile.boundingBox();
  const srcBox = await srcThumb.boundingBox();
  if (!srcBox || !dstBox) throw new Error('drag source / target is not laid out (no bounding box)');
  await page.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2);
  await page.mouse.down();
  // Move in steps toward the 4th tile so the drag arms + siblings reflow.
  await page.mouse.move(dstBox.x + dstBox.width / 2, dstBox.y + dstBox.height / 2, { steps: 12 });
  await page.waitForTimeout(120); // let the FLIP transition be visibly in-flight
  const state = await page.evaluate(() => ({
    dragging: !!document.querySelector('#grid li.tile.dragging'),
    gdrag: document.body.classList.contains('gdrag'),
    liftedTransform: (() => { const t = document.querySelector('#grid li.tile.dragging .thumb');
      return t ? getComputedStyle(t).transform : null; })(),
    siblingTransition: (() => { const s = document.querySelector('#grid li.tile:not(.dragging)');
      return s ? getComputedStyle(s).transitionProperty : null; })(),
  }));
  await page.screenshot({ path: `${OUT}/verify-drag-mid.png` });
  console.log('wrote verify-drag-mid.png; drag state:', JSON.stringify(state));
  await page.mouse.up();
  await page.waitForTimeout(300);

  await browser.close();
  console.log('verify: done');
  await shutdown(0);
} catch (e) {
  console.error('verify failed:', e);
  await shutdown(1);
}
