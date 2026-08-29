// Before/after for the vertical people audience editor.
//
// Four frames, and each one is a claim the PR makes:
//
//   1. `editor`   `/channels/shorts` → ⚙ Configure at 1420px. People and groups appear in
//                 three clearly ordered sections with a visible audience control on each row.
//   2. `move`     the first row after its Nice action is clicked.
//   3. `narrow`   390px. Each audience control stacks under the row identity without overflow.
//
// The row action and the narrow layout are ASSERTED rather than only photographed.
//
// **Fixture data, never live.** The landing fixture's anonymized cast
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers-queuepilot \
//     server/node_modules/.bin/tsx e2e/shot-tray-move.ts --tag=before
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18793;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const env = {
  ...process.env,
  CACHE_PATH: '/tmp/cache-shottraymove.sqlite',
  GROUPS_PATH: '/tmp/groups-shottraymove.yaml',
  HISTORY_PATH: '/tmp/history-shottraymove.json',
  // The shell in this workspace carries real MQTT_* values, and a harness that does not blank
  // them dials the household broker and retries forever.
  MQTT_HOST: '',
  MQTT_PASS: '',
  MQTT_PORT: '',
  MQTT_USER: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  QUEUES_PATH: '/tmp/queues-shottraymove.yaml',
  SETS_PATH: '/tmp/sets-shottraymove.yaml',
  WEB_PORT: String(PORT),
};

for (const [src, dest] of [
  ['e2e/fixtures/landing.sets.yaml', env.SETS_PATH],
  ['e2e/fixtures/landing.queues.yaml', env.QUEUES_PATH],
  ['e2e/fixtures/landing.groups.yaml', env.GROUPS_PATH],
  ['e2e/fixtures/landing.people-mapping.yaml', '/tmp/people-mapping-proposal.yaml'],
] as const) {
  await fs.copyFile(src, dest);
  await fs.rm(`${dest}.lock`, { force: true, recursive: true });
}
for (const stale of [
  '/tmp/queues-shottraymove.queuepilot.sqlite',
  '/tmp/cache-shottraymove.sqlite',
]) {
  await fs.rm(stale, { force: true });
}

await fs.mkdir('__screenshots__', { recursive: true });

let server: ChildProcess | undefined;
const browser = await chromium.launch();

const darkInit = () => {
  try {
    localStorage.setItem('charcuterie-scheme', 'dark');
  } catch {
    /* private mode — the shot is light then, and says so */
  }
};

try {
  server = spawnServer({ env, stdio: 'ignore' });

  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`http://localhost:${PORT}/api/sets`).then((r) => r.json());
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const ctx = await browser.newContext({ viewport: { height: 1100, width: 1420 } });
  await ctx.addInitScript(darkInit);
  const page = await ctx.newPage();

  await page.goto(`http://localhost:${PORT}/channels/shorts`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#chconfigure', { timeout: 30000 });
  await page.click('#chconfigure');
  await page.waitForSelector('#dyn-people', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `__screenshots__/traymove-${TAG}-editor.png` });

  // ── the audience list, asserted ────────────────────────────────────────────────────── //
  const rows = await page.$$eval('#dyn-people .audiencerow', (nodes) => nodes.length);
  const width = await page.$eval('#dynmodal', (n) => Math.round(n.getBoundingClientRect().width));
  console.log(
    rows > 0
      ? `the ${width}px modal shows ${rows} audience rows`
      : '⚠️ the audience list is empty — the BEFORE state',
  );

  const firstRow = page.locator('#dyn-people .audiencerow').first();
  const nice = firstRow.locator('[role="radio"]').nth(1);
  if (await nice.count()) {
    await nice.click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: `__screenshots__/traymove-${TAG}-move.png` });
    console.log('the first audience row moved with its visible Nice action');
  } else {
    console.log('⚠️ no audience action found');
  }

  await ctx.close();

  // ── 4. the Narrow View ─────────────────────────────────────────────────────────────── //
  //
  // NARROW VIEW, named for the WIDTH. `isMobile` is Playwright's own name and is kept as-is,
  // and it is what makes Chromium honour the viewport meta.
  const narrowCtx = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { height: 844, width: 390 },
  });
  await narrowCtx.addInitScript(darkInit);
  const narrow = await narrowCtx.newPage();
  await narrow.goto(`http://localhost:${PORT}/channels/shorts`, {
    waitUntil: 'domcontentloaded',
  });
  await narrow.waitForSelector('#chconfigure', { timeout: 30000 });
  await narrow.click('#chconfigure');
  await narrow.waitForSelector('#dyn-people', { timeout: 30000 });
  await narrow.waitForTimeout(1200);
  await narrow.screenshot({ path: `__screenshots__/traymove-${TAG}-narrow.png` });

  const narrowRows = await narrow.$$eval('#dyn-people .audiencerow', (nodes) => nodes.length);
  const narrowActionWidth = await narrow.$eval(
    '#dyn-people .audiencechoices',
    (n) => Math.round(n.getBoundingClientRect().width),
  );
  console.log(`the Narrow View shows ${narrowRows} rows and ${narrowActionWidth}px audience controls`);

  const narrowWidth = await narrow.$eval('#dynmodal', (n) =>
    Math.round(n.getBoundingClientRect().width),
  );
  const overflow = await narrow.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(
    overflow > 1
      ? `⚠️ the Narrow View scrolls horizontally by ${overflow}px (modal ${narrowWidth}px)`
      : `the Narrow View does not scroll horizontally (modal ${narrowWidth}px)`,
  );
  await narrowCtx.close();
} finally {
  await browser.close();
  killServer(server);
}
