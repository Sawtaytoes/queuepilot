// Dragging a row on the Play landing reorders it, and the order STICKS.
//
// The landing had no reorder at all — drag existed only on the Queues configurator, for whole
// shelves, and Curated and Filtered Pools had none anywhere in the app (owner, 2026-08-17:
// "I also have no way to reorder these items").
//
// Self-contained and NO PLEX: its own server, its own temp files, an unroutable Plex. The
// landing renders from sets.yaml + a queues payload that degrades gracefully, and the claim
// under test is "the dragged order is what `sets.yaml` ends up holding".
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';
import { promises as fs } from 'node:fs';
import type { ChildProcess } from 'node:child_process';

const PORT = 18787;
const SETS = '/tmp/sets-playreorder.yaml';
const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  QUEUES_PATH: '/tmp/queues-playreorder.yaml',
  SETS_PATH: SETS,
  GROUPS_PATH: '/tmp/groups-playreorder.yaml',
  HISTORY_PATH: '/tmp/history-playreorder.json',
  CACHE_PATH: '/tmp/cache-playreorder.sqlite',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  MQTT_HOST: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
};

const ok = (name: string, isPass: boolean) => {
  console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}`);
  if (!isPass) process.exitCode = 1;
};

// Three ordered queues with a FILTERED POOL sitting between two of them in file order. That
// interleaving is the point: reordering the queues must not disturb the pool's slot, which is
// what `spliceOrder` exists for and what a naive partial PATCH would break.
const SETS_SEED = `sets:
- id: q_alpha
  label: Alpha
  kind: movies
  source: queue
  sections: [ 1 ]
- id: pool_mid
  label: Middle Pool
  kind: cartoons
  source: rotation
  behavior: progress
  sections: [ 5 ]
  item_sections: []
  profiles:
  - plex_user: Older Kids
    account_id: 22222222
    allowed_ratings: [ TV-PG ]
- id: q_beta
  label: Beta
  kind: movies
  source: queue
  sections: [ 1 ]
- id: q_gamma
  label: Gamma
  kind: movies
  source: queue
  sections: [ 1 ]
`;

const fileOrder = async (): Promise<string[]> =>
  [...(await fs.readFile(SETS, 'utf8')).matchAll(/^- id: (\S+)$/gm)].map((m) => m[1] as string);

let server: ChildProcess | undefined;
const browser = await chromium.launch();

try {
  await fs.writeFile(env.QUEUES_PATH, 'q_alpha:\n- "1"\nq_beta:\n- "2"\nq_gamma:\n- "3"\n');
  await fs.writeFile(SETS, SETS_SEED);
  await fs.rm(`${SETS}.lock`, { force: true, recursive: true });
  server = spawnServer({ env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://localhost:${PORT}/api/sets`).then((r) => r.json()); break; } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  ok('seed: the pool sits between Alpha and Beta on disk',
    (await fileOrder()).join(',') === 'q_alpha,pool_mid,q_beta,q_gamma');

  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#playqueues li[data-set]', { timeout: 20000 });

  const shelfOrder = () =>
    page.$$eval('#playqueues li[data-set]', (els) =>
      els.map((e) => (e as HTMLElement).dataset.set as string));

  ok('the Ordered Queues shelf renders in file order',
    (await shelfOrder()).join(',') === 'q_alpha,q_beta,q_gamma');
  ok('every row carries a drag handle', (await page.$$('#playqueues .rowdrag')).length === 3);

  // Drag Gamma (3rd) up above Alpha (1st).
  const handle = page.locator('#playqueues li[data-set="q_gamma"] .rowdrag');
  const alpha = page.locator('#playqueues li[data-set="q_alpha"]');
  const from = (await handle.boundingBox())!;
  const to = (await alpha.boundingBox())!;

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Several small steps, not one jump: the hook swaps on crossing a neighbour's MIDPOINT, so
  // a single move would test nothing about the crossing logic.
  for (let i = 1; i <= 12; i++) {
    const y = from.y + ((to.y - 4 - from.y) * i) / 12;
    await page.mouse.move(from.x + from.width / 2, y);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(1500);

  ok('the dragged row moved to the top of its shelf',
    (await shelfOrder()).join(',') === 'q_gamma,q_alpha,q_beta');

  const after = await fileOrder();
  ok('sets.yaml holds the new order', after.join(',').includes('q_gamma'));
  ok('…with the queues in the dragged order',
    after.filter((id) => id.startsWith('q_')).join(',') === 'q_gamma,q_alpha,q_beta');
  // The regression a partial PATCH would cause: reorderSets appends anything it was not told
  // about, so a shelf-only list would push the pool to the END of the file.
  ok('the untouched pool did NOT get swept to the end of the file',
    after.indexOf('pool_mid') !== after.length - 1);

  // And it survives a reload — the write, not just the optimistic DOM.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#playqueues li[data-set]', { timeout: 20000 });
  ok('the order survives a reload',
    (await shelfOrder()).join(',') === 'q_gamma,q_alpha,q_beta');
} finally {
  await browser.close();
  if (server) killServer(server);
}
