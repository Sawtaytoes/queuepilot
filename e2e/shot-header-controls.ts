// Before/after shots for the header pass — the last controls wearing `.ghost`, the app's
// hand-painted spelling of Charcuterie's `appearance="outline"`.
//
//   bar        — the Wide View bar: back, heading, the rename pen, undo/redo
//   togglebar  — the Narrow View bar: the ☰ and ⋮ glyph toggles
//   navmenu    — the Narrow View LEFT popover (back / rename)
//   actmenu    — the Narrow View RIGHT popover (undo / redo / scheme)
//
// EVERY byte on screen is FIXTURE data — queue labels come from
// `e2e/fixtures/sets.fixture.yaml`, which is synthetic, and Plex is unroutable here. The repo
// is public and a PNG is opaque to every grep.
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live` in the agentic root repo)
//
// Runs against ANY vintage of the app, because it is used to shoot both sides of the change:
// a frame whose control is missing logs SKIP rather than failing the run.
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-header-controls.ts [before|after]`
// Writes `__screenshots__/header-<slug>-<stage>.png`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv[2] === 'after' ? 'after' : 'before';
const PORT = parseInt(process.env.WEB_PORT || '18903', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;
const WIDE = { width: 1400, height: 900 };
const NARROW = { width: 390, height: 844 }; // the Narrow View breakpoint is 760px

const waitReady = async (url: string, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`not ready: ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
};

await fs.mkdir(OUT, { recursive: true });
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-header.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-header.yaml');
for (const lock of ['/tmp/queues-header.yaml.lock', '/tmp/sets-header.yaml.lock']) {
  await fs.rm(lock, { force: true });
}

const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/.history-header.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: '/tmp/queues-header.yaml',
    SETS_PATH: '/tmp/sets-header.yaml',
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

try {
  await waitReady(`${BASE}/api/queues`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: WIDE });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.route('**/api/thumb/**', (route) => route.fulfill({ body: '', status: 404 }));

  const shot = async (slug: string, selector: string) => {
    const target = page.locator(selector);
    if (!(await target.count())) {
      console.log(`SKIPPED ${slug} — no ${selector} at this commit`);
      return;
    }
    const file = `${OUT}/header-${slug}-${STAGE}.png`;
    const box = await target.first().boundingBox();
    await target.first().screenshot({ path: file });
    console.log(`shot: ${file}  ${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : '?'}`);
  };

  // A queue page rather than the landing: it is the only route that has ALL of them —
  // a back target, an editable heading (so the pen is not `hidden`), and the undo/redo pair.
  const openQueue = async () => {
    await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#heading', { timeout: 30000 });
    await page.waitForTimeout(1500);
  };

  // 1 — the Wide View bar. `#undo`/`#redo` are enabled only with history behind them, so
  // the frame is shot as found; what it is about is the box, border and glyph size.
  await openQueue();
  await shot('bar', 'header .bar');

  // 2/3/4 — the Narrow View. `.chrome` is `display:none` below 760px and the two popovers
  // carry the same actions instead.
  await page.setViewportSize(NARROW);
  await openQueue();
  await shot('togglebar', 'header .bar');

  const openPopover = async (toggle: string, panel: string) => {
    if (!(await page.locator(toggle).count())) return false;
    await page.click(toggle);
    await page.waitForTimeout(600); // the panel transitions opacity/transform
    return (await page.locator(panel).count()) > 0;
  };

  if (await openPopover('#menu-nav', '.hmenu-left')) {
    await shot('navmenu', '.hmenu-left');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  } else {
    console.log('SKIPPED navmenu — no #menu-nav at this commit');
  }

  if (await openPopover('#menu-actions', '.hmenu-right')) {
    await shot('actmenu', '.hmenu-right');
  } else {
    console.log('SKIPPED actmenu — no #menu-actions at this commit');
  }

  await browser.close();
} finally {
  killServer(srv);
}
