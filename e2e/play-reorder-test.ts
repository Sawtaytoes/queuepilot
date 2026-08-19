// Dragging a card on the Play landing reorders it, and the order STICKS.
//
// The landing had no reorder at all — drag existed only on the Queues configurator, for whole
// shelves, and Curated and Filtered Pools had none anywhere in the app (owner, 2026-08-17:
// "I also have no way to reorder these items").
//
// Since 2026-08-19 the landing is ONE wrapped grid rather than three per-kind shelves, so the
// gesture moves in two axes and this suite drives both: a SIDEWAYS drag on the wide viewport,
// where four cards share a grid row (the case the old midpoint-on-Y test could not tell apart
// — every card in a row has the same Y midpoint), and a vertical one in the Narrow View, where
// the grid collapses to a single column.
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

// Three ordered queues with a FILTERED POOL sitting between two of them in file order. The
// interleaving is still the point, though what it proves has changed shape: the grid holds all
// four in ONE list now, so the pool moves with everything else — what must not happen is
// `reorderSets` sweeping any set it was not told about to the end of the file, which is what a
// partial PATCH does and what `spliceOrder` sending the FULL order prevents.
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
  await page.waitForSelector('#playgrid li[data-set]', { timeout: 20000 });

  const gridOrder = () =>
    page.$$eval('#playgrid li[data-set]', (els) =>
      els.map((e) => (e as HTMLElement).dataset.set as string));

  ok('the grid renders every kind in file order',
    (await gridOrder()).join(',') === 'q_alpha,pool_mid,q_beta,q_gamma');
  ok('every card carries a drag handle', (await page.$$('#playgrid .rowdrag')).length === 4);
  ok('every card says which kind it is',
    (await page.$$eval('#playgrid li[data-set]', (els) =>
      els.map((e) => (e as HTMLElement).dataset.kind))).join(',') === 'ordered,filtered,ordered,ordered');

  // All four cards share one grid row at this width — so this is the SIDEWAYS drag, and the
  // one a Y-midpoint test cannot resolve: alpha, pool_mid, beta and gamma all have the same
  // Y midpoint, so the old hook would have swapped with whichever came first in the DOM.
  const rowTops = await page.$$eval('#playgrid li[data-set]', (els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().top)));
  ok('the four cards really are on one grid row (else this tests nothing)',
    new Set(rowTops).size === 1);

  const drag = async (setId: string, ontoId: string) => {
    const handle = page.locator(`#playgrid li[data-set="${setId}"] .rowdrag`);
    const onto = page.locator(`#playgrid li[data-set="${ontoId}"]`);
    await page.locator(`#playgrid li[data-set="${setId}"]`).hover(); // the handle reveals on hover
    const from = (await handle.boundingBox())!;
    const to = (await onto.boundingBox())!;
    const target = { x: to.x + to.width / 2, y: to.y + to.height / 2 };

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    // Several small steps, not one jump: the hook re-tests containment on every move, and a
    // single leap would prove nothing about the crossing.
    const startX = from.x + from.width / 2;
    const startY = from.y + from.height / 2;
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(
        startX + ((target.x - startX) * i) / 12,
        startY + ((target.y - startY) * i) / 12);
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    await page.waitForTimeout(1200);
  };

  await drag('q_gamma', 'q_alpha');

  ok('the dragged card moved to the head of the grid',
    (await gridOrder())[0] === 'q_gamma');

  const after = await fileOrder();
  ok('sets.yaml holds the new order', after[0] === 'q_gamma');
  // The regression a partial PATCH would cause: reorderSets appends anything it was not told
  // about, so sending a subset would push every other set to the END of the file.
  ok('nothing got swept to the end of the file',
    after.length === 4 && after.includes('pool_mid') && after.includes('q_beta'));

  // And it survives a reload — the write, not just the optimistic DOM.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#playgrid li[data-set]', { timeout: 20000 });
  ok('the order survives a reload', (await gridOrder())[0] === 'q_gamma');

  // ---- the Narrow View: one column, so the same gesture is vertical ----
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(400);
  const colTops = await page.$$eval('#playgrid li[data-set]', (els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().top)));
  ok('the Narrow View really is one column (else this tests nothing)',
    new Set(colTops).size === 4);

  const beforeNarrow = await gridOrder();
  await drag(beforeNarrow[3] as string, beforeNarrow[0] as string);
  ok('a vertical drag reorders in the Narrow View too',
    (await gridOrder())[0] === beforeNarrow[3]);

} finally {
  await browser.close();
  if (server) killServer(server);
}
