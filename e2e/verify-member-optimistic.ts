// Verifier for OPTIMISTIC add/remove on the channel member grid — the tile must land (and
// vanish) instantly, before the PATCH + member re-resolve round-trip finishes, and the server
// must end up agreeing. Mirrors what PR #18 did for the queue grid.
//
// Boots its own fake MQTT broker + this checkout's server against the rich fixtures, so it
// never touches real data. Needs the root agentic .env (Plex token) + playwright.
//
//   set -a; source /mnt/TrueNAS-Apps/Repos/agentic/.env; set +a
//   server/node_modules/.bin/tsx e2e/verify-member-optimistic.ts
import { chromium } from './playwright.js';
import { pickValueMaybe } from './pick.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startFakeMqtt } from './fake-mqtt.js';

/**
 * A JSON body off the API. `Response.json()` is honestly `unknown`; this suite reads the
 * registry the server itself wrote (`sets[].members`), so the cast lives here once rather
 * than at each read.
 */
type JsonBody = Record<string, any>;


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.env.WEB_PORT || '18785', 10);
const FAKE_MQTT_PORT = parseInt(process.env.FAKE_MQTT_PORT || '11888', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;
// How long an optimistic mutation may take to show up. The real PATCH + re-resolve is
// seconds; anything under this proves the UI did not wait for it.
const INSTANT_MS = 600;

const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) process.exitCode = 1; };

async function waitReady(url: string, ms = 30000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server not ready: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

await fs.mkdir(OUT, { recursive: true });
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-optm.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-optm.yaml');
for (const p of ['/tmp/queues-optm.yaml.lock', '/tmp/sets-optm.yaml.lock', '/tmp/.history-optm.json']) {
  await fs.rm(p, { recursive: true, force: true });
}

const fake = await startFakeMqtt({ port: FAKE_MQTT_PORT });
const srv = spawnServer({
  env: {
    ...process.env,
    QUEUES_PATH: '/tmp/queues-optm.yaml',
    SETS_PATH: '/tmp/sets-optm.yaml',
    HISTORY_PATH: '/tmp/.history-optm.json',
    WEB_PORT: String(PORT),
    MQTT_HOST: '127.0.0.1',
    MQTT_PORT: String(FAKE_MQTT_PORT),
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function shutdown(code: number): Promise<void> {
  killServer(srv);
  try { fake.client.end(true); } catch { /* */ }
  try { fake.server.close(); } catch { /* */ }
  try { fake.aedes.close(); } catch { /* */ }
  process.exit(code);
}

const members = async (): Promise<JsonBody[]> => {
  const reg = await fetch(`${BASE}/api/sets`).then((r) => r.json()) as JsonBody;
  return reg.sets.find((s: JsonBody) => s.id === 'younger').members || [];
};

try {
  await waitReady(`${BASE}/api/queues`);
  await fetch(`${BASE}/api/sets/younger`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ members: ['104060', { ratingKey: '104933', title: 'Toy Story (1995)' }] }),
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const tiles = () => page.locator('#chmembers li.tile').count();

  await page.goto(`${BASE}/#/channels/shows`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#channels:not([hidden])', { timeout: 30000 });
  await pickValueMaybe(page, '[data-testid="chprofile"]', 'younger');
  await page.waitForSelector('#chmembers li.tile', { timeout: 30000 });
  await page.waitForTimeout(1000);
  ok('starts with 2 members', (await tiles()) === 2);

  // --- ADD: the tile must appear before the PATCH + re-resolve finishes -------- //
  await page.fill('#chmsearch', 'bananya');
  await page.waitForSelector('#chmresults.open li', { timeout: 30000 });
  const t0 = Date.now();
  await page.click('#chmresults li');
  await page.waitForFunction(() => document.querySelectorAll('#chmembers li.tile').length === 3,
    undefined, { timeout: 5000 });
  const addMs = Date.now() - t0;
  ok(`add lands instantly (${addMs}ms < ${INSTANT_MS}ms)`, addMs < INSTANT_MS);
  ok('added tile is alphabetically placed', (await page.locator('#chmembers li.tile .title')
    .allInnerTexts()).findIndex((t) => t.startsWith('Bananya')) === 0);
  await page.screenshot({ path: `${OUT}/member-optimistic-add.png` });

  // …and the server catches up on its own.
  await page.waitForTimeout(6000);
  ok('add reached the server', (await members()).length === 3);
  ok('no duplicate tile after reconcile', (await tiles()) === 3);
  ok('reconciled tile carries its next-up episode (only the server knows it)',
    /E\d+/.test(await page.locator('#chmembers li.tile').first().locator('.next').innerText()));

  // --- REMOVE: the tile must vanish before the PATCH finishes ------------------ //
  // Measured IN PAGE around a programmatic click: a real click's actionability wait (the
  // poster lifts 3px on hover, so Playwright waits for it to settle) would swamp the app's
  // own latency, which is the thing under test. The handler removes the tile synchronously
  // and PATCHes afterwards, so this number is the whole user-visible cost.
  const rmMs = await page.evaluate(() => {
    const t = performance.now();
    // Throw rather than optional-chain on a missing control: a silent no-op here would
    // report an impossibly fast "remove" and pass.
    const btn = document.querySelector<HTMLElement>('#chmembers li.tile .remove');
    if (!btn) throw new Error('no remove control on the first member tile');
    btn.click();
    return performance.now() - t;
  });
  ok(`remove lands instantly (${Math.round(rmMs)}ms < ${INSTANT_MS}ms)`, rmMs < INSTANT_MS);
  ok('tile is gone before the PATCH resolves', (await tiles()) === 2);
  await page.waitForTimeout(5000);
  const after = await members();
  ok('remove reached the server (2 left)', after.length === 2);
  ok('the RIGHT member was removed',
    !JSON.stringify(after).toLowerCase().includes('360420'));

  // --- indices stay correct after an optimistic remove ------------------------- //
  // Removing the (now) first tile must delete ITS stored slot, not a shifted neighbour.
  const remaining = await page.locator('#chmembers li.tile .title').allInnerTexts();
  await page.evaluate(() => {
    const btn = document.querySelector<HTMLElement>('#chmembers li.tile .remove');
    if (!btn) throw new Error('no remove control on the first member tile');
    btn.click();
  });
  await page.waitForTimeout(5000);
  const left = await members();
  ok('second remove kept the other member', left.length === 1);
  ok('the survivor is the one still on screen',
    JSON.stringify(left).includes(String(remaining[1]).startsWith('Toy Story') ? '104933' : '104060'));

  ok('no console errors', errors.length === 0);
  if (errors.length) console.log(errors);
  await page.screenshot({ path: `${OUT}/member-optimistic-after.png` });
  await browser.close();
  console.log('done');
  await shutdown(Number(process.exitCode) || 0);
} catch (e) {
  console.error('verify-member-optimistic FAILED:', e);
  await shutdown(1);
}
