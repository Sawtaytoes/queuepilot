// Verifier for v3 PR 4: the younger/older → function-channel migration + the /channels
// and Play-landing cutover. Runs migrateLegacyTiers against a /tmp COPY of the legacy
// fixture, then boots the fake broker + THIS checkout's server on the migrated file and
// drives the per-binding UI end to end. Screenshots land in __screenshots__/.
//
//   server/node_modules/.bin/tsx e2e/verify-pr4-cutover.ts
// Needs: root agentic .env (Plex token), e2e/broker deps (aedes), mux-magic playwright,
// PLAYWRIGHT_BROWSERS_PATH. Copies fixtures to /tmp — never touches real data.
import { chromium } from './playwright.js';
import { currentValue, pickValue, readOptionPairs, readOptionValues } from './pick.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startFakeMqtt } from './fake-mqtt.js';

/**
 * A JSON body off the API. `Response.json()` is honestly `unknown`; every read below is of
 * the sets registry the server itself wrote (`profiles[1].allowed_ratings`), so the cast
 * lives here once instead of at each of them.
 */
type JsonBody = Record<string, any>;


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // THIS checkout
const PORT = parseInt(process.env.WEB_PORT || '18785', 10);
const FAKE_MQTT_PORT = parseInt(process.env.FAKE_MQTT_PORT || '11888', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;
const SETS = '/tmp/sets-pr4.yaml';

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
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-pr4.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, SETS);
for (const p of [`${SETS}.lock`, '/tmp/queues-pr4.yaml.lock', '/tmp/.history-pr4.json']) {
  await fs.rm(p, { recursive: true, force: true });
}

// --- 1. The migration itself (same code path the deploy runbook runs) ---------- //
process.env.SETS_PATH = SETS;
const sets = await import('../server/src/sets.js');
const mig = await sets.migrateLegacyTiers();
ok('migration ran', mig.migrated === true);
const again = await sets.migrateLegacyTiers();
ok('migration is idempotent', again.migrated === false);
// The registry entries carry the migrated rotation fields (`behavior`, `profiles`,
// `superseded_by`) that `SetRegistryEntry` does not name; read loosely, like the API bodies.
const reg0 = await sets.getRegistry();
const ss = reg0.sets.find((s) => s.id === 'shows_shorts') as JsonBody | undefined;
const mv = reg0.sets.find((s) => s.id === 'movies') as JsonBody | undefined;
const younger = reg0.sets.find((s) => s.id === 'younger') as JsonBody | undefined;
ok('shows_shorts: progress channel with 2 explicit bindings',
  Boolean(ss && ss.behavior === 'progress' && ss.has_explicit_profiles && ss.profiles.length === 2
    && ss.profiles[0].plex_user === 'Younger Kids' && ss.profiles[1].plex_user === 'Older Kids'));
ok('movies: rewatch channel with the same 2 bindings',
  Boolean(mv && mv.behavior === 'rewatch' && mv.has_explicit_profiles && mv.profiles.length === 2));
ok('legacy tiers kept + marked superseded', Boolean(younger && younger.superseded_by));
const yamlText = await fs.readFile(SETS, 'utf8');
ok('legacy entries still on disk (soak)', yamlText.includes('id: younger') && yamlText.includes('id: older'));

// --- 2. Boot the harness on the migrated registry ------------------------------ //
const fake = await startFakeMqtt({ port: FAKE_MQTT_PORT });
const srv = spawnServer({
  env: {
    ...process.env,
    QUEUES_PATH: '/tmp/queues-pr4.yaml',
    SETS_PATH: SETS,
    HISTORY_PATH: '/tmp/.history-pr4.json',
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
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  const shot = async (name: string) => { await page.screenshot({ path: `${OUT}/${name}`, fullPage: true }); console.log('wrote', name); };

  // --- 3. /channels/shows: binding selector on the ONE function channel ------- //
  await page.goto(`${BASE}/channels/shows`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#channels:not([hidden])');
  await page.waitForSelector('#chpool li.tile', { timeout: 30000 });
  const profOpts = await readOptionPairs(page, '[data-testid="chprofile"]');
  ok('profile picker = the two bindings of shows_shorts',
    profOpts.map((o) => o[0]).join(',') === 'Younger Kids,Older Kids'
    && profOpts.every((o) => String(o[1]).startsWith('shows_shorts::')));
  ok('preview request carried the Younger binding',
    fake.received.previews.some((p) => p.set === 'shows_shorts' && p.profile === 'Younger Kids'));
  const yRatings = await page.$$eval<string[], HTMLInputElement>('#ch-ratings input',
    (is) => is.filter((i) => i.checked).map((i) => i.value));
  ok('ratings prefilled from the Younger binding', yRatings.includes('TV-Y') && !yRatings.includes('PG'));
  await shot('pr4-channels-shows-younger.png');

  // --- 4. Switch binding → Older: filters + preview follow ---------------------- //
  await pickValue(page, '[data-testid="chprofile"]', 'shows_shorts::Older Kids');
  await page.waitForFunction(
    () => [...document.querySelectorAll<HTMLInputElement>('#ch-ratings input')]
      .some((i) => i.checked && i.value === 'PG'),
    undefined, { timeout: 15000 },
  );
  const oRatings = await page.$$eval<string[], HTMLInputElement>('#ch-ratings input',
    (is) => is.filter((i) => i.checked).map((i) => i.value));
  ok('Older binding ratings shown (PG, no TV-Y)', oRatings.includes('PG') && !oRatings.includes('TV-Y'));
  await page.waitForFunction(() => document.querySelectorAll('#chpool li.tile').length > 0, undefined, { timeout: 15000 });
  ok('preview re-requested for the Older binding',
    fake.received.previews.some((p) => p.set === 'shows_shorts' && p.profile === 'Older Kids'));
  await shot('pr4-channels-shows-older.png');

  // --- 5. Save writes INSIDE profiles[], not the top level ---------------------- //
  await page.check('#ch-ratings input[value="TV-14"]').catch(() => {});
  const hasTV14 = await page.$('#ch-ratings input[value="TV-14"]');
  if (hasTV14) {
    await page.click('#ch-save');
    await page.waitForFunction(async () => {
      const r = await fetch('/api/sets').then((x) => x.json()) as JsonBody;
      const s = r.sets.find((x: JsonBody) => x.id === 'shows_shorts');
      return s.profiles[1].allowed_ratings.includes('TV-14') as boolean;
    }, undefined, { timeout: 15000 });
    ok('save landed on the Older binding inside profiles[]', true);
    const regNow = await fetch(`${BASE}/api/sets`).then((x) => x.json()) as JsonBody;
    const ssNow = regNow.sets.find((s: JsonBody) => s.id === 'shows_shorts');
    ok('Younger binding untouched by the Older save', !ssNow.profiles[0].allowed_ratings.includes('TV-14'));
    const rawNow = await fs.readFile(SETS, 'utf8');
    const ssBlock = rawNow.slice(rawNow.indexOf('id: shows_shorts'), rawNow.indexOf('id: movies'));  // one channel's block
    ok('no top-level allowed_ratings on the function channel', !/^\s{2}allowed_ratings:/m.test(ssBlock));
  } else {
    ok('save-into-binding check skipped (TV-14 not offered)', false);
  }

  // --- 6. Movies view: bindings of the movies channel; excludes are per-binding - //
  await pickValue(page, '[data-testid="chchannel"]', 'movies');
  await page.waitForFunction(() => document.body.classList.contains('movies-channel'), undefined, { timeout: 15000 });
  const mProfOpts = await readOptionValues(page, '[data-testid="chprofile"]');
  ok('movies view lists the movies channel bindings', mProfOpts.every((v) => String(v).startsWith('movies::')));
  // Movie-pool tiles carry the watches badge — waiting on it avoids clicking a stale
  // shows-pool tile while the switched view is still loading.
  // The active binding on the movies view carries over from step 5 (Older Kids), so the
  // exclude must land on THAT binding only — the other stays empty.
  const activeProf = await currentValue(page, '[data-testid="chprofile"]'); // `movies::<plex_user>`
  const activeUser = (activeProf ?? '').split('::')[1];
  await page.waitForSelector('#chpool .watches + .exclude', { timeout: 30000 });
  await page.click('#chpool .watches + .exclude'); // first excludable pool tile
  await page.waitForFunction(async () => {
    const r = await fetch('/api/sets').then((x) => x.json()) as JsonBody;
    const s = r.sets.find((x: JsonBody) => x.id === 'movies');
    return s.profiles.reduce((n: number, p: JsonBody) => n + ((p.movie_excludes || []).length ? 1 : 0), 0) === 1;
  }, undefined, { timeout: 15000 });
  const regEx = await fetch(`${BASE}/api/sets`).then((x) => x.json()) as JsonBody;
  const mvEx = regEx.sets.find((s: JsonBody) => s.id === 'movies');
  const withEx = (mvEx.profiles as JsonBody[]).filter((p) => (p.movie_excludes || []).length);
  ok('movie exclude written into exactly the ACTIVE binding',
    withEx.length === 1 && withEx[0]?.plex_user === activeUser);
  await shot('pr4-channels-movies.png');

  // --- 7. Play landing: profile options mirror the bindings; play carries profile //
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#play:not([hidden]) .playcard');
  // The tier picker is a themed Listbox now, not a native <select>
  // (2026-08-07-plex-channels-pickers-are-listbox-not-native-select): open it, read the portalled
  // options, then dismiss. The selected option carries a decorative ✓ — strip it.
  await page.locator('#playgrid li[data-kind="filtered"]:first-child .rowtier').click();
  await page.waitForSelector('[role="listbox"] [role="option"]');
  const tierOpts = await page.$$eval('[role="listbox"] [role="option"]',
    (os) => os.map((o) => (o.textContent ?? '').replace('✓', '').trim()));
  await page.keyboard.press('Escape');
  // "Shield pick" (set:auto) was dropped from the UI 2026-07-29 — every play is explicit,
  // so the tier picker is just the channel's own bindings.
  ok('landing profile picker = both bindings (no Shield pick)',
    tierOpts.join(',') === 'Younger Kids,Older Kids');
  // The two migrated function channels are the ONLY rows; the superseded legacy tiers
  // never surface as their own rows.
  const rowNames = await page.$$eval('#playgrid li[data-kind="filtered"] .rowname', (els) => els.map((e) => e.textContent ?? ''));
  ok('landing dynamic rows = the two function channels', rowNames.join(',') === 'Shows & Shorts,Movies');
  // Locators (auto-retrying) instead of stale element handles — the list can re-render.
  const movieRow = page.locator('#playgrid li[data-kind="filtered"]').nth(1);
  await movieRow.locator('.rowtier').click();
  await page.getByRole('option', { name: 'Older Kids', exact: true }).click();
  await movieRow.locator('.playbtn').click();
  await page.locator('.playmenu button').first().click(); // the default Shield
  await page.waitForFunction(
    () => (document.querySelector('#status')?.textContent || '').length > 0, undefined, { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 500));
  ok('play publish carries set=movies kind=movie profile=Older Kids',
    fake.received.starts.some((p) => p.set === 'movies' && p.kind === 'movie' && p.profile === 'Older Kids'));
  await shot('pr4-play-landing.png');

  await browser.close();
  console.log('done');
  await shutdown(Number(process.exitCode) || 0);
} catch (e) {
  console.error('verify-pr4-cutover FAILED:', e);
  await shutdown(1);
}
