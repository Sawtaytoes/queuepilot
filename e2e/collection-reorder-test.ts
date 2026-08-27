// A collection RE-ORDERED in Plex reaches the "What plays" panel.
//
// The gap this gates: a collection's member order is Plex's own (`collectionSort`), and
// re-ordering one moves NOTHING the derived cache can validate against. Plex's
// `/library/collections/<rk>/children` answers with a container carrying `size` and nothing
// else — no `updatedAt`, no `childCount` — so the stored validator is always 0 and the 24 h
// TTL is the only expiry there has ever been. A re-order changes no timestamp, no count and
// no member; only their positions. So the app served the OLD order for up to a day
// (decision `2026-08-26-a-collection-re-order-is-invisible-so-the-panel-re-reads`).
//
// Four claims:
//   1. the panel opens on the CACHED rows — it never sits empty waiting on Plex;
//   2. it then re-reads Plex, and the rows correct themselves to the new order;
//   3. it SAYS it is doing that, and says when it changed something. The owner asked for the
//      chip specifically: a list that re-orders itself under him with no warning is worse
//      than a slow one;
//   4. an existing SKIP survives the re-order, because a skip addresses a ratingKey and not
//      a position.
//
// Pre-fix this suite fails claim 2 — the rows stay in the cached order — and claim 3, which
// has no chip to find.
//
// Every byte on screen is fixture data (`stubs/plex-member-list.mjs`); the repo is public.
//
// Run:  server/node_modules/.bin/tsx e2e/collection-reorder-test.ts
import { promises as fs } from 'node:fs';
import { chromium, type Page } from './playwright.js';
import {
  MEMBERS, QUEUES_YAML, setMemberOrder, setsYamlWithSkips, startStubPlex,
} from './stubs/plex-member-list.mjs';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = parseInt(process.env.WEB_PORT_REORDER || '18898', 10);
const PLEX_PORT = parseInt(process.env.STUB_PLEX_PORT_REORDER || '18899', 10);
const BASE = `http://localhost:${PORT}`;
// Unique per run: /tmp is shared with every other agent and harness on this machine
// (decision `2026-08-25-a-concurrent-agent-owns-only-its-own-scratch-state`).
const TMP = `/tmp/qp-reorder-${process.pid}`;

const FAILS: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

const waitReady = async (url: string, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`not ready: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

/** The member titles in the order the open panel lists them, edition included. */
const listedOrder = async (page: Page): Promise<string[]> => (
  page.$$eval('#memberlist li', (nodes) => nodes
    .map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim())
    .filter((t) => /^\d+\./.test(t)))
);

/** The skipped member's ratingKey in the fixture — the "Extended Cut" of the duplicate film. */
const SKIPPED = ['9602'];

// The re-order: the LAST member is moved to the front. That is the exact shape the owner hit
// — a newly-added cut lands at the end of a collection, and he drags it to position 1.
const AFTER_ORDER = ['9605', '9601', '9602', '9603', '9604'];

await fs.mkdir(TMP, { recursive: true });
await fs.writeFile(`${TMP}/queues.yaml`, QUEUES_YAML);
await fs.writeFile(`${TMP}/sets.yaml`, setsYamlWithSkips(SKIPPED));

const plex = startStubPlex(PLEX_PORT);
await plex.ready;

const srv = spawnServer({
  env: {
    ...process.env,
    ADB_ENABLED: 'false',
    CACHE_PATH: `${TMP}/cache.sqlite`,
    HISTORY_PATH: `${TMP}/.history.json`,
    MQTT_HOST: '',
    PLEX_API_SERVER_URL: `http://127.0.0.1:${PLEX_PORT}`,
    PLEX_TOKEN: 'stub',
    QUEUES_PATH: `${TMP}/queues.yaml`,
    SETS_PATH: `${TMP}/sets.yaml`,
    STORE_PATH: `${TMP}/store.sqlite`,
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

try {
  await waitReady(`${BASE}/api/shelves`);

  // --- claim 0: the cache holds the ORIGINAL order --------------------------------- //
  // A plain read warms `collection_children`. Everything after this asks whether a re-order
  // can get past that row.
  const warm = await (await fetch(`${BASE}/api/collection/9600/children`)).json();
  ok(
    'cache warms in the collection\'s declared order',
    (warm.children || []).map((c: { ratingKey: string }) => c.ratingKey).join(',')
      === MEMBERS.map((m) => m.ratingKey).join(','),
    JSON.stringify((warm.children || []).map((c: { ratingKey: string }) => c.ratingKey)),
  );

  // The owner re-orders the collection in Plex. Nothing tells the app.
  setMemberOrder(AFTER_ORDER);

  const stale = await (await fetch(`${BASE}/api/collection/9600/children`)).json();
  ok(
    'a re-order is INVISIBLE to the cached read — the gap this fix exists for',
    (stale.children || []).map((c: { ratingKey: string }) => c.ratingKey).join(',')
      === MEMBERS.map((m) => m.ratingKey).join(','),
    'the cached read changed on its own, so this suite is no longer testing what it says',
  );

  // --- claims 1-4: the panel ---------------------------------------------------------- //
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.route('**/api/thumb/**', (route) => route.fulfill({ body: '', status: 404 }));

  await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#queue:not([hidden])', { timeout: 30000 });
  await page.waitForFunction(
    () => document.body.innerText.includes('Great Train Robbery'),
    undefined,
    { timeout: 60000 },
  );

  const card = page.locator('text=The Frontier Trilogy').first();
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  if (!box) throw new Error('the collection tile never rendered');
  await page.mouse.click(box.x + 30, box.y + 5, { button: 'right' });
  await page.waitForSelector('#tilemenu:not([hidden])', { timeout: 10000 });
  await page.getByRole('button', { name: /Choose what plays/ }).click();
  await page.waitForSelector('#memberlist', { timeout: 30000 });

  // Claim 1 — the FIRST paint is the cached order. Read before the re-read can land, which is
  // the whole reason the panel opens instantly instead of waiting on Plex.
  const first = await listedOrder(page);
  ok(
    'the panel paints the cached rows at once',
    first.length === MEMBERS.length,
    `${first.length} rows: ${first.join(' | ')}`,
  );

  // Claim 3 — it says it is checking. Raced deliberately: the chip is allowed to have already
  // become "Updated from Plex" by the time this reads, and either wording proves the point.
  const chipDuring = await page.locator('.memberscount').innerText();
  ok(
    'the panel SAYS it is re-reading Plex',
    /Checking Plex|Updated from Plex/.test(chipDuring),
    chipDuring.replace(/\s+/g, ' '),
  );

  // Claim 2 — the rows correct themselves.
  await page.waitForFunction(
    () => /^1\.\s/.test(
      (document.querySelector('#memberlist li')?.textContent || '').trim(),
    ) && (document.querySelector('#memberlist li')?.textContent || '').includes('The General'),
    undefined,
    { timeout: 20000 },
  ).catch(() => { /* asserted below, with the actual order in the message */ });

  const corrected = await listedOrder(page);
  ok(
    'the re-ordered collection reaches the panel',
    corrected[0]?.includes('The General') === true,
    corrected.join(' | '),
  );
  ok(
    'the whole order matches Plex, not just the head',
    corrected.length === AFTER_ORDER.length
      && corrected[1]?.includes('Theatrical Cut') === true
      && corrected[4]?.includes('The Gold Rush') === true,
    corrected.join(' | '),
  );

  // Claim 3b — and it says it CHANGED something.
  ok(
    'the chip reports the correction',
    (await page.locator('.memberscount').innerText()).includes('Updated from Plex'),
    (await page.locator('.memberscount').innerText()).replace(/\s+/g, ' '),
  );

  // Claim 4 — the skip rode along. It addresses ratingKey 9602 (the Extended Cut), which the
  // re-order moved from row 2 to row 3.
  const rowStates = await page.$$eval('#memberlist li', (nodes) => nodes
    .map((n) => ({
      text: (n.textContent || '').replace(/\s+/g, ' ').trim(),
      isTicked: (n.querySelector('input[type=checkbox]') as HTMLInputElement | null)?.checked ?? null,
    }))
    .filter((r) => /^\d+\./.test(r.text)));
  const extended = rowStates.find((r) => r.text.includes('Extended Cut'));
  ok(
    'the skip follows its member across the re-order',
    extended?.isTicked === false,
    JSON.stringify(rowStates),
  );
  ok(
    'nothing else was skipped by the re-order',
    rowStates.filter((r) => r.isTicked === false).length === 1,
    JSON.stringify(rowStates.map((r) => [r.text.slice(0, 28), r.isTicked])),
  );

  await browser.close();
} finally {
  killServer(srv);
  await plex.close();
  await fs.rm(TMP, { recursive: true, force: true });
}

console.log(FAILS.length ? `\n${FAILS.length} FAILED: ${FAILS.join(', ')}` : '\nall passed');
process.exit(FAILS.length ? 1 : 0);
