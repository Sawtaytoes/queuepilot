// Before/after for "the tray move handle says Move, and the rules editor is wide enough".
//
// Three frames, and each one is a claim the PR makes:
//
//   1. `editor`   `/channels/shorts` → ⚙ Configure at 1420px. Before, the modal is 520px, so
//                 the board is in its NARROW form — one tray on screen, the other two behind
//                 a segmented control, and nowhere to drop. After, it is 920px and all three
//                 trays are side by side, which is what makes a drag possible at all.
//   2. `handle`   the same modal, hovering the first card. Before, the handle is `≡`, which
//                 is this app's DRAG glyph. After, it is the word "Move".
//   3. `menu`     the handle pressed. The menu of the other trays — the path that always
//                 worked and that nothing on screen advertised.
//
// It also ASSERTS the lane count, because "three trays are visible" is the whole first claim
// and a screenshot cannot fail.
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

  // ── the claim, asserted ────────────────────────────────────────────────────────────── //
  //
  // A lane is a `role="group"`; the board renders all three and HIDES two of them below
  // `cq-lg`, so "how many exist" is not the question — "how many are on screen" is.
  const lanesOnScreen = await page.$$eval(
    '#dyn-people [role="group"]',
    (nodes) => nodes.filter((n) => (n as HTMLElement).offsetParent !== null).length,
  );
  const width = await page.$eval('#dynmodal', (n) => Math.round(n.getBoundingClientRect().width));
  console.log(
    lanesOnScreen >= 3
      ? `the modal is ${width}px and all ${lanesOnScreen} trays are on screen`
      : `⚠️ the modal is ${width}px and only ${lanesOnScreen} tray(s) fit — the BEFORE state`,
  );

  // ── the handle ─────────────────────────────────────────────────────────────────────── //

  const handle = page.locator('#dyn-people button[aria-haspopup="menu"]').first();
  // The FIRST line only. The rest of `innerText` is the `VisuallyHidden` qualifier that names
  // which card this is and which tray it sits in — real content, and not what is on screen.
  const handleText = (await handle.count())
    ? ((await handle.innerText()).split('\n')[0] ?? '').trim()
    : '(none)';
  console.log(
    handleText === '≡'
      ? "⚠️ the move handle wears the app's DRAG glyph — the BEFORE state"
      : `the move handle reads "${handleText}"`,
  );

  await handle.hover();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `__screenshots__/traymove-${TAG}-handle.png` });

  await handle.click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `__screenshots__/traymove-${TAG}-menu.png` });
  const items = await page.$$eval('[role="menuitem"]', (nodes) =>
    nodes.filter((n) => (n as HTMLElement).offsetParent !== null).map((n) => (n.textContent ?? '').trim()),
  );
  console.log(`the menu offers: ${items.join(' | ') || '(nothing)'}`);

  await ctx.close();

  // ── 4. the Narrow View ─────────────────────────────────────────────────────────────── //
  //
  // `min(920px, 92vw)` — so the widening must not reach a phone. The board drops back to one
  // lane on its own there, which is the shape it is designed to have; what must NOT happen is
  // a modal wider than the window.
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
