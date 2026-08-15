// Ad-hoc screenshots of the picker changes, for the owner to eyeball over devshare:
//  1. Play menu ("Play on ▾") — the full-width bug fixed (sized to its ~220px, not edge-to-edge).
//  2. The tier picker open — a themed Listbox, not the native OS dropdown.
//  3. The queue Add-to position picker open — same.
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startFakeMqtt } from './fake-mqtt.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.env.WEB_PORT || '18811', 10);
const FAKE = parseInt(process.env.FAKE_MQTT_PORT || '11911', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;

async function waitReady(url: string, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) { try { if ((await fetch(url)).ok) return; } catch { /* */ } if (Date.now() > end) throw new Error('not ready'); await new Promise((r) => setTimeout(r, 300)); }
}

await fs.mkdir(OUT, { recursive: true });
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-shot.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-shot.yaml');
for (const p of ['/tmp/sets-shot.yaml.lock', '/tmp/queues-shot.yaml.lock']) await fs.rm(p, { force: true });

const fake = await startFakeMqtt({ port: FAKE });
const srv = spawnServer({
  env: { ...process.env, QUEUES_PATH: '/tmp/queues-shot.yaml', SETS_PATH: '/tmp/sets-shot.yaml',
    HISTORY_PATH: '/tmp/.history-shot.json', WEB_PORT: String(PORT),
    MQTT_HOST: '127.0.0.1', MQTT_PORT: String(FAKE), NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

try {
  await waitReady(`${BASE}/api/queues`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // 1 + 2 — Play landing: the tier picker open, then the Play menu open.
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#playdynamic .playrow');
  await page.locator('#playdynamic .playrow').first().locator('.rowtier').click();
  await page.waitForSelector('[role="listbox"] [role="option"]');
  await page.screenshot({ path: `${OUT}/dd-tier-listbox.png` });
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(150);

  await page.locator('#playdynamic .playrow').first().locator('.playbtn').click();
  await page.waitForSelector('.playmenu');
  await page.waitForTimeout(400); // let devices arrive
  await page.screenshot({ path: `${OUT}/dd-playmenu-width.png` });

  // 3 — Queue Add-to position picker open.
  const qid = await page.evaluate(() => fetch('/api/queues').then((r) => r.json()).then((j) => Object.keys(j.sets)[0]));
  await page.goto(`${BASE}/#/q/${qid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.add [data-testid="addpos"]', { timeout: 15000 }).catch(() => {});
  const addpos = await page.$('[data-testid="addpos"]');
  if (addpos) {
    await addpos.click();
    await page.waitForSelector('[role="listbox"] [role="option"]');
    await page.screenshot({ path: `${OUT}/dd-addpos-listbox.png` });
  }

  await browser.close();
  console.log('screenshots written to', OUT);
} finally {
  killServer(srv);
  try { fake.client.end(true); } catch { /* */ }
  try { fake.server.close(); fake.aedes.close(); } catch { /* */ }
}
process.exit(0);
