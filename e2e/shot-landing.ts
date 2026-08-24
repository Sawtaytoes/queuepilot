// Before/after for the Play landing's layout, against a fixture with the DENSITY the change
// is about — 17 sets across all three kinds, three providers, six groups.
//
// Self-contained: its own server, its own temp copies of `fixtures/landing.*.yaml`, an
// unroutable Plex. `--tag=` names the output, so the same script shoots BEFORE on main and
// AFTER on the branch and the two are comparable frame for frame.
//
// **Fixture data, never live.** The landing renders the household's set NAMES, and those are
// the household — a real "<person> & <person> — Anime" in a screenshot committed to a public repo says
// something about the owner's life. Every name here is the repo's own anonymized cast
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   server/node_modules/.bin/tsx e2e/shot-landing.ts --tag=after
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18789;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  QUEUES_PATH: '/tmp/queues-shotlanding.yaml',
  SETS_PATH: '/tmp/sets-shotlanding.yaml',
  GROUPS_PATH: '/tmp/groups-shotlanding.yaml',
  HISTORY_PATH: '/tmp/history-shotlanding.json',
  CACHE_PATH: '/tmp/cache-shotlanding.sqlite',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  MQTT_HOST: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
};

for (const [src, dest] of [
  ['e2e/fixtures/landing.sets.yaml', env.SETS_PATH],
  ['e2e/fixtures/landing.queues.yaml', env.QUEUES_PATH],
  ['e2e/fixtures/landing.groups.yaml', env.GROUPS_PATH],
] as const) {
  await fs.copyFile(src, dest);
  await fs.rm(`${dest}.lock`, { force: true, recursive: true });
}

let server: ChildProcess | undefined;
const browser = await chromium.launch();

try {
  server = spawnServer({ env, stdio: 'ignore' });

  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://localhost:${PORT}/api/sets`).then((r) => r.json());
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // The owner's UI is dark; the scheme persists to localStorage, so set it before first paint
  // rather than clicking the toggle after it.
  const ctx = await browser.newContext({ viewport: { width: 1420, height: 1000 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('charcuterie-scheme', 'dark');
    } catch {
      /* private mode — the shot is just light then, and says so */
    }
  });

  const page = await ctx.newPage();
  const settle = async () => {
    // `.playrow` on main, `.playcard` on the branch — one selector cannot match both, and a
    // shot script that only knows the NEW class silently produces an empty BEFORE.
    await page.waitForSelector('.playcard, .playrow', { timeout: 30000 });
    await page.waitForTimeout(1800);
  };

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await settle();
  await page.screenshot({ path: `__screenshots__/landing-${TAG}-wide.png`, fullPage: true });

  // One group selected — the case where a kind empties out entirely and the old layout paid
  // for it with a blank column.
  await page.goto(`http://localhost:${PORT}/g/bob`, { waitUntil: 'domcontentloaded' });
  await settle();
  await page.screenshot({ path: `__screenshots__/landing-${TAG}-group.png`, fullPage: true });

  // A group whose NAME is also the account its rule pools are bound to — the case
  // `accountInGroup` exists for. `bob` above cannot show it: it holds only Picks queues, and
  // the account only ever appears in a rule pool's meta. Here "Younger Kids" is the page
  // title, the lit chip, the name `labelInGroup` already stripped off each card, and (before
  // this shot was added) the first two words of two of the three metas.
  await page.goto(`http://localhost:${PORT}/g/younger-kids`, { waitUntil: 'domcontentloaded' });
  await settle();
  await page.screenshot({ path: `__screenshots__/landing-${TAG}-account-group.png`, fullPage: true });

  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await settle();
  await page.screenshot({ path: `__screenshots__/landing-${TAG}-narrow.png`, fullPage: true });

  console.log(`shot: __screenshots__/landing-${TAG}-{wide,group,account-group,narrow}.png`);
} finally {
  await browser.close();
  if (server) killServer(server);
}
