// Verifier for the v3 PR 3 heterogeneous member grid on the Channels view. Boots a FAKE
// MQTT broker + THIS checkout's Node server against the rich fixture, then drives the
// grid end to end: members round-trip through PATCH /api/sets/:id + the resolved
// GET /api/sets/:id/members, the grid renders show/collection/movie/short tiles
// ALPHABETICALLY, the scoped add-search appends a member, the tile × removes one, and
// the movies sub-view hides the section. Screenshots land in __screenshots__/.
//
//   server/node_modules/.bin/tsx e2e/verify-members.ts
// Needs: root agentic .env (Plex token), e2e/broker deps (aedes), mux-magic playwright,
// PLAYWRIGHT_BROWSERS_PATH. Copies fixtures to /tmp — never touches real data.
import { chromium } from './playwright.js';
import { pickValue, pickValueMaybe } from './pick.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startFakeMqtt } from './fake-mqtt.js';

/**
 * A JSON body off the API. `Response.json()` is honestly `unknown`; every read below is of
 * a payload the server itself produced (the sets registry, the resolved members list), so
 * the cast lives here once instead of at each of them.
 */
type JsonBody = Record<string, any>;


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // THIS checkout
const PORT = parseInt(process.env.WEB_PORT || '18783', 10);
const FAKE_MQTT_PORT = parseInt(process.env.FAKE_MQTT_PORT || '11886', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;

// Real library items (live Plex, read-only): one of each member kind.
const MEMBERS: (string | { ratingKey: string; title: string })[] = [
  '104060', // show: Curious George
  'Collection: Looney Tunes Shorts', // collection (section 15)
  { ratingKey: '104933', title: 'Toy Story (1995)' }, // movie
  '269283', // short: 8 Ball Bunny
];

const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) process.exitCode = 1; };

async function waitReady(url: string, ms = 30000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server not ready: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

await fs.mkdir(OUT, { recursive: true });
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-pr3ui.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-pr3ui.yaml');
for (const p of ['/tmp/queues-pr3ui.yaml.lock', '/tmp/sets-pr3ui.yaml.lock', '/tmp/.history-pr3ui.json']) {
  await fs.rm(p, { recursive: true, force: true });
}

const fake = await startFakeMqtt({ port: FAKE_MQTT_PORT });
const srv = spawnServer({
  env: {
    ...process.env,
    QUEUES_PATH: '/tmp/queues-pr3ui.yaml',
    SETS_PATH: '/tmp/sets-pr3ui.yaml',
    HISTORY_PATH: '/tmp/.history-pr3ui.json',
    WEB_PORT: String(PORT),
    MQTT_HOST: '127.0.0.1',
    MQTT_PORT: String(FAKE_MQTT_PORT),
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function shutdown(code: number): Promise<void> {
  killServer(srv);
  try { fake.client.end(true); } catch { /* */ }
  try { fake.server.close(); } catch { /* */ }
  try { fake.aedes.close(); } catch { /* */ }
  process.exit(code);
}

try {
  await waitReady(`${BASE}/api/queues`);

  // --- 1. API round-trip: PATCH members[] → registry + resolved endpoint ------ //
  let r = await fetch(`${BASE}/api/sets/younger`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ members: MEMBERS }),
  });
  ok('PATCH members accepted', r.ok);
  const reg = await fetch(`${BASE}/api/sets`).then((x) => x.json()) as JsonBody;
  const younger = reg.sets.find((s: JsonBody) => s.id === 'younger');
  ok('registry round-trips members (4)', Boolean(younger) && Array.isArray(younger.members) && younger.members.length === 4);
  const resolved = await fetch(`${BASE}/api/sets/younger/members`).then((x) => x.json()) as JsonBody;
  const types = ((resolved.members || []) as JsonBody[]).map((m) => m.type).sort().join(',');
  ok('members resolve heterogeneously (collection+movie x2+show)', types === 'collection,movie,movie,show');
  ok('every member resolved', ((resolved.members || []) as JsonBody[]).every((m) => m.resolved));
  const show = ((resolved.members || []) as JsonBody[]).find((m) => m.type === 'show');
  ok('show member carries next-episode', Boolean(show && show.nextEp));

  // --- 2. The grid renders alphabetically with typed badges ------------------- //
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1400 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  const shot = async (name: string) => { await page.screenshot({ path: `${OUT}/${name}`, fullPage: true }); console.log('wrote', name); };

  await page.goto(`${BASE}/channels/shows`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#channels:not([hidden])', { timeout: 30000 });
  await pickValueMaybe(page, '[data-testid="chprofile"]', 'younger');
  await page.waitForSelector('#chmembers li.tile', { timeout: 30000 });
  ok('members box visible on the shows view', await page.$eval('#chmembers-box', (el) => !el.hidden));
  const titles = await page.$$eval('#chmembers li.tile .title', (els) => els.map((e) => e.textContent ?? ''));
  ok('grid shows all 4 members', titles.length === 4);
  const sorted = [...titles].sort((a, b) => a.localeCompare(b));
  ok('members listed alphabetically', JSON.stringify(titles) === JSON.stringify(sorted));
  // A collection badge is two-part ("Collection" + the collection's NAME) since the tile's
  // title line shows the member that plays next — decision
  // 2026-07-31-collection-tiles-are-member-first. Compare the kind, not the whole label.
  const badges = await page.$$eval('#chmembers li.tile .badge', (els) => els
    .map((e) => e.querySelector('.badgekind')?.textContent || e.textContent).sort().join(','));
  ok('typed badges (Collection/Movie x2/Series)', badges === 'Collection,Movie,Movie,Series');
  const collTile = await page.$$eval('#chmembers li.tile', (els) => {
    const li = els.find((e) => e.querySelector('.badge.collection'));
    return li
      ? { name: li.querySelector('.badgename')?.textContent, title: li.querySelector('.title')?.textContent }
      : null;
  });
  ok('collection tile names its collection in the badge, a member in the title',
    Boolean(collTile && collTile.name === 'Looney Tunes Shorts' && collTile.title !== 'Looney Tunes Shorts'));
  ok('title says curated (4)', ((await page.$eval('#chmembers-title', (el) => el.textContent)) ?? '').includes('4'));
  await shot('pr3-members-grid.png');

  // --- 3. Add a member via the scoped search ---------------------------------- //
  await page.fill('#chmsearch', 'bananya');
  await page.waitForSelector('#chmresults.open li', { timeout: 30000 });
  await page.click('#chmresults li');
  await page.waitForFunction(
    () => document.querySelectorAll('#chmembers li.tile').length === 5,
    undefined, { timeout: 30000 },
  );
  ok('search-add appends a 5th member', true);
  // Optimistic add too: the tile is up immediately, the PATCH lands a moment later.
  const addedOnServer = async (ms = 15000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const reg = await fetch(`${BASE}/api/sets`).then((x) => x.json()) as JsonBody;
      if (reg.sets.find((s: JsonBody) => s.id === 'younger').members
        .some((m: unknown) => m && typeof m === 'object' && (m as JsonBody).ratingKey === '360420')) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 300));
    }
  };
  ok('added member persisted by ratingKey', await addedOnServer());
  await shot('pr3-members-added.png');

  // --- 4. Remove via the tile × ----------------------------------------------- //
  await page.hover('#chmembers li.tile');
  await page.click('#chmembers li.tile .remove');
  await page.waitForFunction(
    () => document.querySelectorAll('#chmembers li.tile').length === 4,
    undefined, { timeout: 30000 },
  );
  ok('tile × removes a member', true);
  // The grid removes OPTIMISTICALLY (the PATCH runs in the background), so poll the server
  // rather than assuming it already agrees the instant the tile is gone.
  const persisted = async (n: number, ms = 15000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const reg = await fetch(`${BASE}/api/sets`).then((x) => x.json()) as JsonBody;
      if (reg.sets.find((s: JsonBody) => s.id === 'younger').members.length === n) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 300));
    }
  };
  ok('remove persisted (4 on disk)', await persisted(4));

  // --- 5. A memberless channel collapses to the slim hint ---------------------- //
  // Switching channels goes through the CHANNEL dropdown — since "every dynamic channel is a
  // first-class entry" (decision 2026-07-29) the profile dropdown lists only the current
  // channel's bindings, so the old `selectOption('#chprofile', 'older')` could never work.
  // (The rewatch/movies sub-view is covered by channels-test; this fixture has no rewatch
  // channel, and adding one would break that suite's channel-count assertions.)
  await pickValue(page, '[data-testid="chchannel"]', 'older');
  await page.waitForSelector('#chmembers-box.no-members', { timeout: 30000 });
  // Empty channel: the member GRID is hidden (no poster-sized empty tile) and a slim
  // one-line hint shows instead.
  ok('memberless channel hides the grid (no poster-sized empty tile)',
    await page.$eval('#chmembers', (el) => Boolean(el.hidden)));
  ok('memberless channel shows the slim rule hint',
    await page.$eval('#chmembers-box .chmhint', (el) => getComputedStyle(el).display !== 'none'
      && (el.textContent ?? '').includes('play purely by the rule')));
  await shot('pr3-members-empty.png');

  // --- 6. Clearing members drops the key (back to the pure dynamic rule) ------- //
  r = await fetch(`${BASE}/api/sets/younger`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ members: [] }),
  });
  ok('PATCH members: [] accepted', r.ok);
  const cleared = await fetch(`${BASE}/api/sets`).then((x) => x.json()) as JsonBody;
  ok('cleared members leave an empty list', cleared.sets.find((s: JsonBody) => s.id === 'younger').members.length === 0);
  const raw = await fs.readFile('/tmp/sets-pr3ui.yaml', 'utf8');
  ok('members key dropped from sets.yaml', !raw.includes('members:'));

  await browser.close();
  console.log('done');
  await shutdown(Number(process.exitCode) || 0);
} catch (e) {
  console.error('verify-members FAILED:', e);
  await shutdown(1);
}
