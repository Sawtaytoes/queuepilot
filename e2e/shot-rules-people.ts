// Before/after for "a Rules queue carries people too".
//
// Two frames, and each one is a claim the PR makes:
//
//   1. `landing`  the Admin landing (`/admin`) at 1420px. On main every Rules card is a name, a badge and
//                 a meta line; on the branch it carries the same row of faces a Picks card
//                 does, because the rows were already in `queue_people` and only the UI was
//                 refusing to read them.
//   2. `editor`   `/channels/shorts` with the ⚙ Configure modal open. On main the modal has
//                 Name, Behavior, Kind tag and then goes straight to the libraries — there is
//                 nowhere at all to put a person, which is what the owner reported. On the
//                 branch the three trays sit under Kind tag.
//
// The BEFORE run is expected to find no faces and no `#dyn-people`. It says so on stdout
// rather than failing — that is the state it is documenting.
//
// **Fixture data, never live.** This repo is public and a PNG is opaque to every grep, so it
// reuses the landing fixture's anonymized cast — Ada, Grace, Linus and the four groups
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers-queuepilot \
//     server/node_modules/.bin/tsx e2e/shot-rules-people.ts --tag=before
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

// Its own port and its own temp files, so this can run beside `shot-landing-people.ts`
// rather than after it.
const PORT = 18799;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const env = {
  ...process.env,
  CACHE_PATH: '/tmp/cache-shotrulespeople.sqlite',
  GROUPS_PATH: '/tmp/groups-shotrulespeople.yaml',
  HISTORY_PATH: '/tmp/history-shotrulespeople.json',
  // The shell in this workspace carries real MQTT_* values, and a harness that does not blank
  // them dials the household broker and retries forever.
  MQTT_HOST: '',
  MQTT_PASS: '',
  MQTT_PORT: '',
  MQTT_USER: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  QUEUES_PATH: '/tmp/queues-shotrulespeople.yaml',
  SETS_PATH: '/tmp/sets-shotrulespeople.yaml',
  WEB_PORT: String(PORT),
};

for (const [src, dest] of [
  ['e2e/fixtures/landing.sets.yaml', env.SETS_PATH],
  ['e2e/fixtures/landing.queues.yaml', env.QUEUES_PATH],
  ['e2e/fixtures/landing.groups.yaml', env.GROUPS_PATH],
  // The proposal filename, not a confirmed one — the importer looks for exactly this.
  ['e2e/fixtures/landing.people-mapping.yaml', '/tmp/people-mapping-proposal.yaml'],
] as const) {
  await fs.copyFile(src, dest);
  await fs.rm(`${dest}.lock`, { force: true, recursive: true });
}
// The store derives its own path from the queues path, so a stale one from a previous run
// would keep the previous run's rows AND its "already seeded" marker.
for (const stale of [
  '/tmp/queues-shotrulespeople.queuepilot.sqlite',
  '/tmp/cache-shotrulespeople.sqlite',
]) {
  await fs.rm(stale, { force: true });
}

await fs.mkdir('__screenshots__', { recursive: true });

let server: ChildProcess | undefined;
const browser = await chromium.launch();

// The owner's UI is dark, and the scheme persists to localStorage — set it before first paint
// rather than clicking the toggle after it.
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

  const ctx = await browser.newContext({ viewport: { height: 1000, width: 1420 } });
  await ctx.addInitScript(darkInit);
  const page = await ctx.newPage();

  // ── 1. the landing ─────────────────────────────────────────────────────────────────── //

  await page.goto(`http://localhost:${PORT}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.playcard', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `__screenshots__/rulespeople-${TAG}-landing.png` });

  const onRules = await page.$$eval(
    '.playcard[data-kind="rules"] .qpeople',
    (nodes) => nodes.length,
  );
  console.log(
    onRules === 0
      ? 'no people row on any Rules card — the BEFORE state'
      : `${onRules} Rules card(s) carry a people row`,
  );

  // ── 2. the rules editor ────────────────────────────────────────────────────────────── //
  //
  // `shorts` is the fixture's `profiles[]` pool and it is the card the owner named. The
  // Younger Kids group claims it, so its trays are already populated — which is the whole
  // point: the rows existed and there was no screen to see them on.
  await page.goto(`http://localhost:${PORT}/channels/shorts`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#chconfigure', { timeout: 30000 });
  await page.click('#chconfigure');
  await page.waitForSelector('#dynmodal', { timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `__screenshots__/rulespeople-${TAG}-editor.png` });

  const trays = await page.$$eval('#dyn-people', (nodes) => nodes.length);
  console.log(
    trays === 0
      ? 'the rules editor has no people trays — the BEFORE state'
      : 'the rules editor draws the three trays',
  );

  await ctx.close();
} finally {
  await browser.close();
  killServer(server);
}
