// Before/after for the MODE LANDING — the front door at `/`, and the queue-type chooser
// the "＋ New queue" button opens.
//
// Self-contained: its own server, its own temp copies of `fixtures/landing.*.yaml`, an
// unroutable Plex. `--tag=` names the output, so the same script shoots BEFORE on main and
// AFTER on the branch and the frames are comparable.
//
// **Fixture data, never live.** This repo is public. The landing itself renders no
// household data, but `/queues` does — set names are the household's own, and a real
// "<person> & <person> — Anime" in a committed PNG says something about the owner's life
// that no grep will ever find again. Everything in frame comes from
// `e2e/fixtures/landing.*.yaml`, which is the repo's anonymized cast
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
// Both schemes, because the change is a COLOUR change and a hue that reads in one scheme
// is not thereby readable in the other.
//
//   server/node_modules/.bin/tsx e2e/shot-mode-landing.ts --tag=after
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18797;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  QUEUES_PATH: '/tmp/queues-shotmodelanding.yaml',
  SETS_PATH: '/tmp/sets-shotmodelanding.yaml',
  GROUPS_PATH: '/tmp/groups-shotmodelanding.yaml',
  HISTORY_PATH: '/tmp/history-shotmodelanding.json',
  CACHE_PATH: '/tmp/cache-shotmodelanding.sqlite',
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

  for (const scheme of ['light', 'dark'] as const) {
    // The scheme persists to localStorage and an inline pre-paint script reads it, so it
    // is set BEFORE first paint rather than by clicking the toggle after. Clicking would
    // also have put the switcher in a hover state in every frame.
    const ctx = await browser.newContext({
      colorScheme: scheme,
      deviceScaleFactor: 2,
      viewport: { width: 1420, height: 900 },
    });
    await ctx.addInitScript((want: string) => {
      try {
        localStorage.setItem('charcuterie-scheme', want);
      } catch {
        /* private mode — the assert below then fails loudly rather than mislabelling */
      }
    }, scheme);

    const page = await ctx.newPage();

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mode-landing', { timeout: 30000 });
    await page.waitForTimeout(1200);

    // A frame named `-dark` that is actually light is worse than no frame: it is a claim
    // about a scheme nobody checked. Assert before every shot.
    const painted = await page.$eval('html', (el) => el.getAttribute('data-scheme'));
    if (painted !== scheme) {
      throw new Error(`asked for ${scheme}, page painted ${painted ?? 'nothing'}`);
    }

    await page.screenshot({
      path: `__screenshots__/mode-landing-${TAG}-${scheme}.png`,
      fullPage: true,
    });

    // The queue-type chooser, which is on `/queues` behind "＋ New queue". It was already
    // an `ActionTiles` before this branch — what changes is that the tiles are coloured
    // and carry a glyph, so the BEFORE frame is a real frame rather than an empty one.
    await page.goto(`http://localhost:${PORT}/queues`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#newqueue', { timeout: 30000 });
    await page.click('#newqueue');
    await page.waitForSelector('#queue-type-modal', { timeout: 30000 });
    await page.waitForTimeout(900);

    const modal = await page.$('#queue-type-modal');
    if (!modal) throw new Error('the queue-type modal did not open');
    await modal.screenshot({ path: `__screenshots__/queue-type-${TAG}-${scheme}.png` });

    await ctx.close();
  }

  console.log(
    `shot: __screenshots__/{mode-landing,queue-type}-${TAG}-{light,dark}.png`,
  );
} finally {
  await browser.close();
  if (server) killServer(server);
}
