// Verifier for the v3 PR 2b per-profile bindings sub-editor in the dyn (dynamic-channel)
// form. Boots a FAKE MQTT broker + THIS checkout's Node server against the rich fixture,
// then drives the modal end to end: behavior select, add/remove profile cards, per-binding
// profile fill + ratings scoping, submit → profiles[] persisted, and edit-load of a legacy
// single-binding set. Screenshots land in __screenshots__/ for visual review.
//
//   server/node_modules/.bin/tsx e2e/verify-profile-bindings.ts
// Needs: root agentic .env (Plex token), e2e/broker deps (aedes), mux-magic playwright,
// PLAYWRIGHT_BROWSERS_PATH. Copies fixtures to /tmp — never touches real data.
import { chromium } from './playwright.js';
import { pickHandle, pickValueMaybe, readOptionValues, readOptionValuesFromHandle } from './pick.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startFakeMqtt } from './fake-mqtt.js';


/** The slice of `GET /api/sets` this suite reads back — `Response.json()` is `any`. */
interface SetRecord {
  id: string;
  label: string;
  behavior?: string;
  profiles?: unknown[];
}
interface SetsResponse {
  sets: SetRecord[];
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // THIS checkout
const PORT = parseInt(process.env.WEB_PORT || '18782', 10);
const FAKE_MQTT_PORT = parseInt(process.env.FAKE_MQTT_PORT || '11885', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;

const ok = (name: string, isPass: boolean) => { console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}`); if (!isPass) process.exitCode = 1; };

async function waitReady(url: string, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server not ready: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

await fs.mkdir(OUT, { recursive: true });
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-2b.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-2b.yaml');
for (const p of ['/tmp/queues-2b.yaml.lock', '/tmp/sets-2b.yaml.lock', '/tmp/.history-2b.json']) {
  await fs.rm(p, { recursive: true, force: true });
}

const fake = await startFakeMqtt({ port: FAKE_MQTT_PORT });
const srv = spawnServer({
  env: {
    ...process.env,
    QUEUES_PATH: '/tmp/queues-2b.yaml',
    SETS_PATH: '/tmp/sets-2b.yaml',
    HISTORY_PATH: '/tmp/.history-2b.json',
    WEB_PORT: String(PORT),
    MQTT_HOST: '127.0.0.1',
    MQTT_PORT: String(FAKE_MQTT_PORT),
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function shutdown(code: number) {
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
  const cards = () => page.$$eval('#dyn-bindings .binding', (els) => els.length);

  // --- 1. NEW channel modal: behavior select + one empty binding card -------- //
  await page.goto(`${BASE}/channels`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#newdyn', { timeout: 30000 });
  await page.click('#newdyn');
  await page.waitForSelector('#dynmodal[data-open]');
  await page.waitForTimeout(400);

  const behaviorOpts = await readOptionValues(page, '[data-testid="dyn-behavior"]');
  ok('behavior select replaces mode (progress+rewatch)', behaviorOpts.join(',') === 'progress,rewatch');
  ok('no legacy #dyn-mode / #dyn-ratings left', !(await page.$('#dyn-mode')) && !(await page.$('#dyn-ratings')));
  ok('new channel opens with exactly one binding card', (await cards()) === 1);
  ok('single binding hides its Remove button', await page.$eval('#dyn-bindings .binding .b-remove', (b) => Boolean(b.hidden)));
  await shot('pr2b-dyn-new.png');

  // --- 2. Add a second profile → two cards, Remove now shown ----------------- //
  await page.click('#dyn-addprofile');
  await page.waitForTimeout(150);
  ok('Add profile appends a second binding card', (await cards()) === 2);
  ok('with two bindings, Remove is shown', !(await page.$eval('#dyn-bindings .binding .b-remove', (b) => b.hidden)));

  // Pick a distinct profile in each card; assert it fills the advanced Plex-user field.
  const [firstSel, secondSel] = await page.$$('#dyn-bindings .binding .b-profile');
  // Step 2 just asserted there are two cards, so two triggers is a hard expectation —
  // name it rather than letting `undefined.click()` surface as a Playwright TypeError.
  if (!firstSel || !secondSel) throw new Error('expected two .b-profile pickers after Add profile');
  // Every binding card shares the same profile option list — read it from the first.
  // The predicate (not a bare `Boolean`) is what drops the `null`s from the TYPE too.
  const profVals = (await readOptionValuesFromHandle(page, firstSel))
    .filter((value): value is string => Boolean(value));
  const [profA, profB] = profVals;
  if (profA && profB) {
    await pickHandle(page, firstSel, profA);
    await pickHandle(page, secondSel, profB);
    await page.waitForTimeout(400);
    const users = await page.$$eval<string[], HTMLInputElement>('#dyn-bindings .binding .b-plexuser', (is) => is.map((i) => i.value));
    ok('picking a profile fills that card\'s Plex user', Boolean(users[0] && users[1] && users[0] !== users[1]));
  } else {
    ok('picking a profile fills that card\'s Plex user (skipped: <2 Plex profiles live)', true);
  }
  await shot('pr2b-dyn-two-bindings.png');

  // --- 3. Submit → the new channel persists profiles[] ----------------------- //
  await page.fill('#dyn-label', 'Verify Fn Channel');
  // Checking a show library re-scopes every binding's ratings (async, replaces the checkbox
  // DOM), so do it FIRST and let it settle before touching ratings — then use auto-retrying
  // locators so a re-render mid-check re-resolves rather than detaching.
  await page.locator('#dyn-showlibs input').first().check();
  await page.waitForTimeout(700);
  const nBindings = await cards();
  for (let i = 0; i < nBindings; i++) {
    const firstRating = page.locator('#dyn-bindings .binding').nth(i).locator('.b-ratings input').first();
    await firstRating.waitFor({ timeout: 5000 });
    await firstRating.check();
  }
  await page.click('#dyn-save');
  // Save closes the modal; it's a body-portalled overlay now (not a native <dialog>), so
  // "closed" = the element is detached, not `.open === false`.
  await page.waitForSelector('#dynmodal', { state: 'detached', timeout: 15000 });
  const created = await page.evaluate(async () => {
    const r: SetsResponse = await fetch('/api/sets').then((x) => x.json());
    return r.sets.find((set) => set.label === 'Verify Fn Channel') ?? null;
  });
  ok('created channel stored', Boolean(created));
  ok('created channel has behavior', created?.behavior === 'progress');
  ok('created channel persisted profiles[]', Array.isArray(created?.profiles) && created.profiles.length >= 1);

  // --- 4. Edit-load a LEGACY single-binding set → one prefilled card ---------- //
  await page.goto(`${BASE}/channels/shows`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#channels:not([hidden])', { timeout: 30000 });
  await pickValueMaybe(page, '[data-testid="chprofile"]', 'younger');
  await page.waitForTimeout(300);
  await page.click('#chconfigure');
  await page.waitForSelector('#dynmodal[data-open]');
  await page.waitForTimeout(500);
  ok('legacy set edits as one binding card', (await cards()) === 1);
  const legUser = await page.$eval<string, HTMLInputElement>('#dyn-bindings .binding .b-plexuser', (i) => i.value);
  ok('legacy binding prefilled (Younger Kids)', legUser === 'Younger Kids');
  const legRatings = await page.$$eval<string[], HTMLInputElement>('#dyn-bindings .binding .b-ratings input',
    (is) => is.filter((i) => i.checked).map((i) => i.value));
  ok('legacy binding ratings prefilled (G, no PG)', legRatings.includes('G') && !legRatings.includes('PG'));
  await shot('pr2b-dyn-edit-legacy.png');

  // --- 5. Edit-load a TWO-binding channel → each card keeps ITS OWN ratings --- //
  // Regression: the shared `known` ratings list is scoped to the ACTIVE profile; a second
  // binding for a different profile must still render + check its own saved ratings (the
  // Older card came up blank because Younger's scoped list omitted PG/TV-PG). Create the
  // channel via API with disjoint per-profile ratings so the test doesn't depend on live
  // Plex data — the bug reproduces whenever the two bindings' ratings differ.
  await page.click('#dynmodal .modalx'); // step 4 left it open — close via the ✕ (no native dialog.close() now)
  await page.waitForTimeout(150);
  await page.evaluate(() => fetch('/api/sets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'rotation', label: 'Verify Rewatch', kind: 'movies', behavior: 'rewatch',
      sections: [], item_sections: [1], blocklist: [], movie_excludes: [],
      profiles: [
        { plex_user: 'Younger Kids', account_id: 11111111, user_uuid: '1111111111111111',
          allowed_ratings: ['G', 'TV-Y'], movie_ratings: ['G', 'TV-Y'], watch_count_accounts: [11111111] },
        { plex_user: 'Older Kids', account_id: 22222222, user_uuid: '2222222222222222',
          allowed_ratings: ['PG', 'TV-PG'], movie_ratings: ['PG', 'TV-PG'], watch_count_accounts: [22222222] },
      ],
    }),
  }).then((r) => r.json()));
  const newId = await page.evaluate(async () => {
    const r: SetsResponse = await fetch('/api/sets').then((x) => x.json());
    return r.sets.find((set) => set.label === 'Verify Rewatch')?.id;
  });
  await page.goto(`${BASE}/channels/${newId}`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' }); // REG was loaded before the POST — refetch it
  await page.waitForSelector('#channels:not([hidden])', { timeout: 30000 });
  await page.waitForTimeout(300);
  await page.click('#chconfigure');
  await page.waitForSelector('#dynmodal[data-open]');
  await page.waitForTimeout(2500); // let every card's scopeBindingRatings settle
  ok('two-binding channel edits as two cards', (await cards()) === 2);
  const perCard = await page.$$eval('#dyn-bindings .binding', (els) => els.map((c) => ({
    user: c.querySelector<HTMLInputElement>('.b-plexuser')?.value ?? '',
    mr: [...c.querySelectorAll<HTMLInputElement>('.b-mratings input:checked')].map((i) => i.value),
  })));
  const younger = perCard.find((c) => c.user === 'Younger Kids');
  const older = perCard.find((c) => c.user === 'Older Kids');
  ok('Younger card keeps its own movie ratings (G, not PG)',
    younger !== undefined && younger.mr.includes('G') && !younger.mr.includes('PG'));
  ok('Older card keeps its own movie ratings (PG+TV-PG, not blank)',
    older !== undefined && older.mr.includes('PG') && older.mr.includes('TV-PG'));
  await shot('pr2b-dyn-two-binding-edit.png');

  await browser.close();
  console.log('done');
  await shutdown(Number(process.exitCode ?? 0));
} catch (e) {
  console.error('verify-profile-bindings FAILED:', e);
  await shutdown(1);
}
