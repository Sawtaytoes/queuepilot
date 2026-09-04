// Screenshots of a FILTERED QUEUE — the shelf nested under the queue it views, and its own
// page — booted OFFLINE against `e2e/fake-kavita.ts`.
//
//   server/node_modules/.bin/tsx e2e/shot-filtered-queue.ts
//
// Writes `__screenshots__/filtered-queue-{shelves,page}-<tag>.png` (`SHOT_TAG`, default
// `after`). Self-contained: it starts the fake Kavita, writes its own fixtures to a scratch
// directory, boots the server, drives the page and stops everything.
//
// FIXTURE DATA, and that is the point rather than convenience. A PR screenshot of the real
// instance would carry the household's library into a public repo, and a PNG is opaque to
// every grep that would otherwise catch it (AGENTS.md). The cast here is invented: a
// "Comics & Strips" queue over two libraries, and a "Strips" view of it.
//
// The "before" half of a before/after pair is the same script run against a build of `main`,
// where `filtered_from` means nothing — the view resolves to a queue with no provider and no
// entries, which is exactly what the change is for.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from './playwright.js';

const TAG = process.env.SHOT_TAG || 'after';
const PORT = process.env.WEB_PORT || '18796';
const KAVITA_PORT = process.env.FAKE_KAVITA_PORT || '18795';
const OUT = '__screenshots__';
const TSX = 'server/node_modules/.bin/tsx';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'shot-filtered-'));
mkdirSync(OUT, { recursive: true });

// Series 101/103/105/107/108 are in library 5 (Strips); 102/104/106 are in library 2
// (Volumes). The view keeps 5, so it shows five of the eight.
writeFileSync(
  path.join(SCRATCH, 'sets.yaml'),
  'sets:\n'
  + '  - id: reading\n'
  + '    label: Comics & Strips\n'
  + '    kind: picks\n'
  + '    source: queue\n'
  + '    add_as: priority\n'
  + '    episodes: 2\n'
  + '    providers:\n'
  + '      - provider: kavita\n'
  + '        libraries: [2, 5]\n'
  + '  - id: strips\n'
  + '    label: Strips\n'
  + '    filtered_from: reading\n'
  + '    filter:\n'
  + '      libraries: ["5"]\n',
);
writeFileSync(
  path.join(SCRATCH, 'queues.yaml'),
  'reading:\n'
  + '  - ratingKey: "101"\n    title: A Flame Reborn\n'
  + '  - ratingKey: "102"\n    title: The Bound Cartographer\n'
  + '  - ratingKey: "103"\n    title: Nine Lanterns\n'
  + '  - ratingKey: "104"\n    title: Salt and the Long Road\n'
  + '  - ratingKey: "105"\n    title: A Hero Who Knows His Stuff\n'
  + '  - ratingKey: "106"\n    title: Winter Court Records\n'
  + '  - ratingKey: "107"\n    title: Second Sun Rising\n'
  + '  - ratingKey: "108"\n    title: The Quiet Tenant\n'
  + 'strips: []\n',
);

const children: ChildProcess[] = [];
const start = (script: string, env: NodeJS.ProcessEnv) => {
  const child = spawn(TSX, [script], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(child);
  return child;
};

/** Wait for a URL to answer at all. A fixed sleep is the flake this exists to avoid. */
const waitFor = async (url: string, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
      await new Promise((r) => { setTimeout(r, 200); });
    }
  }
};

start('e2e/fake-kavita.ts', { FAKE_KAVITA_PORT: KAVITA_PORT });
await waitFor(`http://127.0.0.1:${KAVITA_PORT}/api/Library/libraries`);

start('server/src/index.ts', {
  CACHE_PATH: path.join(SCRATCH, 'cache.sqlite'),
  // Any non-empty key: the fake authenticates every one of them.
  KAVITA_API_KEY: 'fake-key',
  KAVITA_API_SERVER_URL: `http://127.0.0.1:${KAVITA_PORT}`,
  // No broker. The suites that assert the degraded path do the same.
  MQTT_HOST: '',
  PROVIDERS_PATH: path.join(SCRATCH, 'providers.yaml'),
  PROVIDERS_SECRETS_PATH: path.join(SCRATCH, 'providers.secrets.yaml'),
  QUEUES_PATH: path.join(SCRATCH, 'queues.yaml'),
  SETS_PATH: path.join(SCRATCH, 'sets.yaml'),
  STORE_PATH: path.join(SCRATCH, 'store.sqlite'),
  WEB_PORT: PORT,
});
await waitFor(`http://127.0.0.1:${PORT}/api/sets`);

const browser = await chromium.launch();
const page = await browser.newPage({
  colorScheme: 'dark',
  viewport: { height: 1000, width: 1200 },
});
// With no stored preference every Picks shelf starts COLLAPSED (`state/ui.ts`), and a
// collapsed shelf hides its strip. An empty saved list is the "I have expanded everything"
// state, which is the one worth photographing.
await page.addInitScript(() => {
  localStorage.setItem('pc.collapsedQueues', '[]');
});

// --- the Queues page: the view nested under the queue it views ---------------- //
await page.goto(`http://127.0.0.1:${PORT}/queues`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => document.documentElement.setAttribute('data-scheme', 'dark'));
// Wait on the PARENT's tiles, which exist in both halves of the pair: on `main` the view has
// no provider and no entries, so waiting for ITS tiles would hang the "before" run forever.
// The settle after it is what keeps the shot honest — `/api/queues` replaces the skeleton's
// unfiltered superset, and a shot taken mid-flight would show the opposite of the change.
await page.waitForSelector('.shelf[data-set="reading"] .strip .tile .thumb img', { timeout: 60000 });
await page.waitForTimeout(2500);
await page.locator('#shelves').screenshot({
  path: `${OUT}/filtered-queue-shelves-${TAG}.png`,
});
console.log('wrote', `${OUT}/filtered-queue-shelves-${TAG}.png`);

// --- the view's own page: the banner, and five of the eight entries ----------- //
await page.goto(`http://127.0.0.1:${PORT}/q/strips`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => document.documentElement.setAttribute('data-scheme', 'dark'));
// `#grid` itself, not a tile in it: on `main` this page is an EMPTY queue, and that empty
// state is exactly what the "before" shot is of.
await page.waitForSelector('#grid', { timeout: 60000 });
await page.waitForTimeout(2500);
await page.screenshot({
  clip: { height: 900, width: 1200, x: 0, y: 0 },
  path: `${OUT}/filtered-queue-page-${TAG}.png`,
});
console.log('wrote', `${OUT}/filtered-queue-page-${TAG}.png`);

await browser.close();
for (const child of children) child.kill();
process.exit(0);
