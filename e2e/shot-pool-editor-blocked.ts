// Before/after for the ⚙ Configure data-loss fix: the Pool-filters **Blocked** panel, shot
// AFTER a Save from the pool editor. On the pre-fix bundle it reads "Nothing blocked."; on the
// fix the two entries are still there.
//
// Same server shape as e2e/pool-editor-keeps-blocked-test.ts (own port, own temp files,
// unroutable Plex) so it needs no secrets. `--tag=` names the output.
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';
import { promises as fs } from 'node:fs';
import type { ChildProcess } from 'node:child_process';

const PORT = 18785;
const SETS = '/tmp/sets-poolblock-shot.yaml';
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';
const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  QUEUES_PATH: '/tmp/queues-poolblock-shot.yaml',
  SETS_PATH: SETS,
  HISTORY_PATH: '/tmp/history-poolblock-shot.json',
  CACHE_PATH: '/tmp/cache-poolblock-shot.sqlite',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  MQTT_HOST: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
};

const SETS_SEED = `sets:
- id: blockpool
  label: Older Kids — Shorts & Shows
  kind: cartoons
  source: rotation
  behavior: progress
  sections: [ 5 ]
  item_sections: [ 15 ]
  blocklist:
  - "424242"
  - "Collection: So You Want... Shorts"
  profiles:
  - plex_user: Older Kids
    account_id: 22222222
    user_uuid: "2222222222222222"
    allowed_ratings: [ TV-PG, PG ]
    movie_ratings: [ TV-PG, PG ]
    movie_excludes: [ "515151" ]
    watch_count_accounts: [ 22222222 ]
`;

let server: ChildProcess | undefined;
const browser = await chromium.launch();

try {
  await fs.writeFile(env.QUEUES_PATH, 'bob:\n- "1"\n');
  await fs.writeFile(SETS, SETS_SEED);
  await fs.rm(`${SETS}.lock`, { force: true, recursive: true });
  server = spawnServer({ env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://localhost:${PORT}/api/sets`).then((r) => r.json()); break; } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  await page.goto(`http://localhost:${PORT}/channels`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#channels:not([hidden])');
  await page.waitForSelector('#chconfigure');
  await page.click('#chconfigure');
  await page.waitForSelector('#dynmodal[data-open]');
  await page.waitForSelector('#dyn-bindings .binding');
  await page.waitForTimeout(800);
  await page.click('#dyn-save');
  await page.waitForSelector('#dynmodal[data-open]', { state: 'detached', timeout: 15000 })
    .catch(() => page.waitForTimeout(2000));
  await page.waitForTimeout(1200);
  // Scroll the Blocked fieldset into view inside the filters aside, then shoot the aside.
  await page.evaluate(() => {
    document.querySelector('#ch-blocksearch')?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(300);
  // A LOCATOR, not `page.$()`: this repo's playwright types hand back
  // `ElementHandle<Element>`, and `screenshot()` lives on the HTMLElement/SVGElement
  // narrowing of that handle — so the handle form does not typecheck. Locators carry it
  // unconditionally.
  await page.locator('#chfilters').screenshot({
    path: `__screenshots__/pool-blocked-after-save-${TAG}.png`,
  });
  console.log(`shot: __screenshots__/pool-blocked-after-save-${TAG}.png`);
} finally {
  await browser.close();
  if (server) killServer(server);
}
