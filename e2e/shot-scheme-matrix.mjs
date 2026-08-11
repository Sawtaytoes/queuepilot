// Reflow-check screenshots: every main view in BOTH colour schemes, at desktop and
// phone widths, driven to the states most exposed to a type-scale change (the header's
// mobile overflow panel open, a modal open, a picker open).
//
//   node e2e/shot-scheme-matrix.mjs before      # writes __screenshots__/before/*.png
//   node e2e/shot-scheme-matrix.mjs after
//
// Boots its own fake MQTT broker + Node server on private ports with the harness
// fixtures copied to /tmp, exactly like e2e/shots.mjs — nothing real is touched.
// The scheme is forced via localStorage (`charcuterie-scheme`), the same key
// `ColorSchemeSwitcher` persists to, so this drives the app's real scheme path.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFakeMqtt } from './fake-mqtt.mjs';
import { chromium } from './playwright.mjs';

const LABEL = process.argv[2] || 'shots';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.env.WEB_PORT || '18821', 10);
const FAKE = parseInt(process.env.FAKE_MQTT_PORT || '11921', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__/${LABEL}`;

const DESKTOP = { width: 1400, height: 1000 };
const PHONE = { width: 390, height: 844 };

async function waitReady(url, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`server not ready: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

await fs.mkdir(OUT, { recursive: true });
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-matrix.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-matrix.yaml');
for (const p of ['/tmp/queues-matrix.yaml.lock', '/tmp/sets-matrix.yaml.lock', '/tmp/.history-matrix.json']) {
  await fs.rm(p, { recursive: true, force: true });
}

const fake = await startFakeMqtt({ port: FAKE });
const srv = spawn('node', [`${ROOT}/server/src/server.js`], {
  env: {
    ...process.env,
    QUEUES_PATH: '/tmp/queues-matrix.yaml',
    SETS_PATH: '/tmp/sets-matrix.yaml',
    HISTORY_PATH: '/tmp/.history-matrix.json',
    WEB_PORT: String(PORT),
    MQTT_HOST: '127.0.0.1',
    MQTT_PORT: String(FAKE),
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

/** documentElement.scrollWidth > clientWidth is the narrow-view overflow bug (2026-08-10). */
async function overflowCheck(page, name, report) {
  const over = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (over.scrollWidth > over.clientWidth) {
    report.push(`${name}: horizontal overflow ${over.scrollWidth} > ${over.clientWidth}`);
  }
}

try {
  await waitReady(`${BASE}/api/queues`);
  const browser = await chromium.launch();
  const report = [];

  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: DESKTOP });
    await context.addInitScript((s) => {
      try { localStorage.setItem('charcuterie-scheme', s); } catch { /* */ }
    }, scheme);
    const page = await context.newPage();
    const shot = async (name, opts = {}) => {
      const file = `${OUT}/${name}-${scheme}.png`;
      await page.screenshot({ path: file, ...opts });
      await overflowCheck(page, `${name}-${scheme}`, report);
      console.log('wrote', file);
    };

    // 1. Play landing (desktop).
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.playrow', { timeout: 30000 });
    await page.waitForTimeout(600);
    await shot('01-play');

    // 2. The "Play on ▾" device menu open — a popover sized to its own text.
    const playBtn = await page.$('.playrow .playbtn');
    if (playBtn) {
      await playBtn.click();
      await page.waitForTimeout(600);
      await shot('02-playmenu');
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);
    }

    // 3. Home / all queues — the shelves grid + the toolbar in the sticky header.
    await page.goto(`${BASE}/#/queues`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.shelf', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1000);
    await shot('03-queues');

    // 4. A movie queue grid (posters, badges, done tiles).
    await page.goto(`${BASE}/#/q/bob`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#queue:not([hidden]) li.tile', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await shot('04-queue-bob');

    // 5. Channels — Shows & Shorts (filters bar + pool).
    await page.goto(`${BASE}/#/channels/shows`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#channels:not([hidden])', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await shot('05-channels-shows');

    // 6. The queue Configure modal — the densest text surface in the app.
    await page.goto(`${BASE}/#/queues`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.shelf', { timeout: 30000 }).catch(() => {});
    await page.hover('.shelf[data-set="bob"] h2').catch(() => {});
    const edit = await page.$('.shelf[data-set="bob"] .shelfedit');
    if (edit) {
      await edit.click();
      await page.waitForSelector('#setmodal[data-open]').catch(() => {});
      await page.waitForTimeout(600);
      await shot('06-setmodal');
      await page.keyboard.press('Escape').catch(() => {});
    }

    // 7-8. Phone width: the header's overflow panel is the most reflow-exposed chrome.
    await page.setViewportSize(PHONE);
    await page.goto(`${BASE}/#/q/bob`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#queue:not([hidden]) li.tile', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await shot('07-phone-queue');

    await page.click('#menu-actions').catch(() => {});
    await page.waitForTimeout(400);
    await shot('08-phone-actions-menu');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);

    await page.click('#menu-nav').catch(() => {});
    await page.waitForTimeout(400);
    await shot('09-phone-nav-menu');
    await page.keyboard.press('Escape').catch(() => {});

    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.playrow', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);
    await shot('10-phone-play');

    await context.close();
  }

  await browser.close();
  if (report.length) {
    console.log('\nLAYOUT WARNINGS:');
    for (const line of report) console.log('  -', line);
  } else {
    console.log('\nno horizontal overflow on any captured state');
  }
  console.log('scheme matrix: done ->', OUT);
  await shutdown(0);
} catch (e) {
  console.error('shot-scheme-matrix failed:', e);
  await shutdown(1);
}
