// Ad-hoc screenshot of the Start-from picker's WATCHED marks, for the owner to eyeball:
// the trailing "— watched" words became "Watched" chips, so a long run of episode titles
// can be skimmed. Same offline harness as shot-dropdowns.ts (fixtures + fake broker +
// the real Plex for episode lists).
import { killServer, spawnServer } from './stubs/server-process.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeMqtt } from './fake-mqtt.js';
import { chromium } from './playwright.js';

/** The slice of `GET /api/queues` this harness reads. `r.json()` is `any`, so without a
 * shape here every `.items`/`.nextEp` walk below silently degrades to `unknown`. */
interface QueueItem {
  key: string;
  type: string;
  resolved: boolean;
  nextEp?: { episode?: number } | null;
}
interface QueuesResponse {
  sets: Record<string, { items: QueueItem[] }>;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.env.WEB_PORT || '18813', 10);
const FAKE = parseInt(process.env.FAKE_MQTT_PORT || '11913', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;

async function waitReady(url: string, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* */ }
    if (Date.now() > end) throw new Error('not ready');
    await new Promise((r) => setTimeout(r, 300));
  }
}

await fs.mkdir(OUT, { recursive: true });
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-chip.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-chip.yaml');
for (const p of ['/tmp/sets-chip.yaml.lock', '/tmp/queues-chip.yaml.lock']) await fs.rm(p, { force: true });

const fake = await startFakeMqtt({ port: FAKE });
const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/.history-chip.json',
    MQTT_HOST: '127.0.0.1',
    MQTT_PORT: String(FAKE),
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: '/tmp/queues-chip.yaml',
    SETS_PATH: '/tmp/sets-chip.yaml',
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

try {
  await waitReady(`${BASE}/api/queues`);
  const browser = await chromium.launch();
  // Dark, because that is the scheme the picker is skimmed in.
  const page = await browser.newPage({
    colorScheme: 'dark',
    viewport: { width: 1400, height: 950 },
  });

  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
  // Only a SHOW/collection entry can carry a start point, so hunt across the sets for
  // one — the first queue in the fixture is all movies.
  // …and specifically the one deepest into its run, so the list actually HAS watched
  // rows to mark (a show sitting on E1 shows nothing worth screenshotting).
  const sets = await page.evaluate(() =>
    fetch('/api/queues').then((r) => r.json()).then((j: QueuesResponse) =>
      Object.entries(j.sets)
        .flatMap(([id, set]) => set.items
          .filter((i) => i.resolved && i.type === 'show' && i.nextEp)
          .map((i) => ({ id, show: i.key, at: i.nextEp?.episode || 0 })))
        .sort((a, b) => b.at - a.at)));
  // Read the head BEFORE asserting on it: `sets.length` does not narrow `sets[0]` under
  // noUncheckedIndexedAccess, and the throw is the same either way.
  const deepest = sets[0];
  if (!deepest) throw new Error('no show entry in the fixtures to start from');
  const { id: setId, show } = deepest;
  console.log('using set', setId, 'entry', show);

  await page.goto(`${BASE}/#/q/${setId}`, { waitUntil: 'domcontentloaded' });
  const tile = page.locator(`#queue .tile[data-key="${show}"]`);
  await tile.waitFor({ timeout: 20000 });

  // The tile menu's "Start from an episode…" opens the modal; then open the Episode
  // picker so its rows (and their watched chips) are on screen.
  await tile.click({ button: 'right' });
  await page.waitForSelector('#tilemenu button');
  await page.locator('#tilemenu button', { hasText: 'Start from' }).click();
  await page.waitForSelector('[data-testid="start-episode"]', { timeout: 20000 });
  await page.waitForTimeout(1200); // episode list lands
  await page.locator('[data-testid="start-episode"]').click();
  await page.waitForSelector('[role="listbox"] [role="option"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/chip-start-episodes.png` });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // A COLLECTION's Series row carries the other chip shape: "<seen>/<total> watched",
  // success-green only when the member is finished.
  const coll = await page.evaluate((id: string) =>
    fetch('/api/queues').then((r) => r.json()).then((j: QueuesResponse) =>
      j.sets[id]?.items.find((i) => i.resolved && i.type === 'collection')?.key ?? null), setId);
  if (coll) {
    const cTile = page.locator(`#queue .tile[data-key="${coll}"]`);
    await cTile.click({ button: 'right' });
    await page.waitForSelector('#tilemenu button');
    await page.locator('#tilemenu button', { hasText: 'Start from' }).click();
    await page.waitForSelector('[data-testid="start-series"]', { timeout: 20000 });
    await page.waitForTimeout(1200);
    await page.locator('[data-testid="start-series"]').click();
    await page.waitForSelector('[role="listbox"] [role="option"]');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/chip-start-series.png` });
  } else {
    console.log('no collection entry in this set — skipped the series-chip shot');
  }

  await browser.close();
  console.log('screenshots written to', OUT);
} finally {
  killServer(srv);
  try { fake.client.end(true); } catch { /* */ }
  try { fake.server.close(); fake.aedes.close(); } catch { /* */ }
}
process.exit(0);
