// THE CALENDAR VIEW — a second editor for the two date-based queue settings.
//
// `/calendar` lists every queue that has a season window or a reset date and lets the owner
// change those dates without opening each queue
// (decision `2026-09-08-a-calendar-view-is-a-second-editor-for-date-based-queue-settings`).
// Eight things it pins, and six of them are rules from that record rather than plumbing:
//
//   1. a queue with a date appears; a queue with NO date does not — this is a list of
//      scheduled queues, not a roster of every queue with two empty columns;
//   2. the list is ONE COLUMN at every width, which is the narrowed grid rule and not an
//      exception to it. Asserted as a computed `grid-template-columns` with one track at
//      1400px, because a class name is not a style and only the browser knows;
//   3. it EDITS: a date changed here reaches the SET, which is read back off `/api/sets` —
//      the same value the Set editor writes, with no calendar-only field anywhere;
//   4. a ROTATION pool gets the season window and NOT the reset date. The server refuses
//      `reset_watched_on` on a rotation set, and a control that offers a refused value is a
//      control that looks broken;
//   5. HALF a season window is refused before the request, with both ends named. Nothing is
//      sent, because `seasonDayValue` answers "" for a month with no day and a half-filled
//      pair would otherwise reach the API as two blanks and clear the window silently;
//   6. the Add control offers exactly the queues that are NOT on the calendar, and adding one
//      opens a row for it — otherwise a queue could only get its first date from the Set
//      editor;
//   7. the Narrow View does not scroll sideways with four pickers on a row;
//   8. NO TIMER, anywhere in the feature. Both settings are evaluated on a read and that is
//      the decision in both records, so the view is grepped the way
//      `seasonal-reset-test.ts` §6b greps the three server modules.
//
// Browser, but NO PLEX: every assertion is about the registry, the DOM and one PATCH, all of
// which render on the degraded no-Plex path. The Plex-gated suites are skipped on every PR, so
// a gate that lived there would never run.
//
// Usage: `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers server/node_modules/.bin/tsx
//         e2e/calendar-view-test.ts`   (spawns its own server)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pickValue } from './pick.js';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.env.WEB_PORT || '19300', 10);
const BASE = `http://localhost:${PORT}`;

let failed = 0;
const check = (name: string, isOk: boolean, detail = '') => {
  console.log(`  ${isOk ? 'ok  ' : 'FAIL'} ${name}${isOk ? '' : ` — ${detail}`}`);
  if (!isOk) failed += 1;
};

const waitReady = async (url: string, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`not ready: ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
};

// ── 8. No timer, and the grep is the gate ──────────────────────────────────────────────── //
// The view is a READER of two settings that are both evaluated on a read. A poll here would
// be a timer wearing a different hat, and it is the one regression nothing else could see: a
// `setInterval` that re-fetches looks exactly like a page that works.
{
  const source = await fs.readFile(`${ROOT}/web/src/views/CalendarView.tsx`, 'utf8');
  // The CALL, not the word: this file's own header says "there is no `setInterval`", and a
  // grep that cannot tell a ban from its explanation is a gate that fails on its own comment.
  for (const banned of ['setInterval(', 'setTimeout(', 'requestAnimationFrame(']) {
    check(`the calendar view has no ${banned})`, !source.includes(banned));
  }
}

await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-calendar.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/calendar.sets.yaml`, '/tmp/sets-calendar.yaml');
for (const lock of ['/tmp/queues-calendar.yaml.lock', '/tmp/sets-calendar.yaml.lock']) {
  await fs.rm(lock, { force: true });
}
await fs.rm('/tmp/queuepilot-calendar.sqlite', { force: true });

const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/.history-calendar.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: '/tmp/queues-calendar.yaml',
    SETS_PATH: '/tmp/sets-calendar.yaml',
    STORE_PATH: '/tmp/queuepilot-calendar.sqlite',
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

const setById = async (id: string): Promise<Record<string, unknown>> => {
  const body = (await (await fetch(`${BASE}/api/sets`)).json()) as {
    sets: Record<string, unknown>[];
  };

  return body.sets.find((set) => set.id === id) ?? {};
};

try {
  await waitReady(`${BASE}/api/queues`);

  // ⚠️ A PORT THAT ANSWERS IS NOT PROOF IT IS OUR SERVER. Sibling agents run these harnesses
  // from their own worktrees, and a port one of theirs already holds answers with a 200 — so
  // this suite would assert against somebody else's build and report their result as ours.
  // The fixture's own queue label is the identity check, and it is a hard stop.
  const registry = (await (await fetch(`${BASE}/api/sets`)).json()) as {
    sets: { label?: string }[];
  };
  if (!registry.sets.some((set) => set.label === 'Bob — Halloween')) {
    throw new Error(
      `port ${PORT} answers, but it is not this harness's server — another worktree holds it`,
    );
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  /** Every write the page makes, so "it sent nothing" is assertable rather than assumed. */
  const writes: { body: string; method: string; url: string }[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().includes('/api/sets/')) {
      writes.push({ body: request.postData() ?? '', method: request.method(), url: request.url() });
    }
  });

  /**
   * WAIT FOR THE FIRST LOAD TO SETTLE before touching anything.
   *
   * `store.load()` opens with a "Loading…" status and closes with "Ready", and on the
   * no-Plex path the `/api/queues` half of it takes about ten seconds to time out. A click
   * landing inside that window races the store's own re-render, and the save's toast then
   * queues up behind a load that has not finished — which reads as "the save said nothing".
   */
  const settle = async (target = page) =>
    target
      .waitForFunction(
        () => (document.querySelector('#status')?.textContent ?? '') === 'Ready',
        undefined,
        { timeout: 90000 },
      )
      .then(() => true, () => false);

  await page.goto(`${BASE}/calendar`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#calendar-rows', { timeout: 30000 });
  await settle();

  // ── 1. Which queues are listed ───────────────────────────────────────────────────────── //
  const listed = await page.$$eval('#calendar-rows [data-set]', (els) =>
    els.map((el) => el.getAttribute('data-set')),
  );
  check(
    'every queue with a date is listed',
    ['bob', 'bob_alice', 'bob_anime', 'younger'].every((id) => listed.includes(id)),
    listed.join(', '),
  );
  check(
    'a queue with NO date does not appear',
    !listed.includes('family') && !listed.includes('older'),
    listed.join(', '),
  );

  // Calendar order, on the earliest date each row carries: bob_anime 04-01, younger 06-01,
  // bob 10-01, bob_alice 12-01. It asks nothing about today, so the order is the same at
  // every hour and this assertion cannot flake at midnight.
  check(
    'the rows are in calendar order, January to December',
    listed.join(',') === 'bob_anime,younger,bob,bob_alice',
    listed.join(','),
  );

  // ── 2. ONE COLUMN at every width ─────────────────────────────────────────────────────── //
  const tracks = await page.$eval(
    '#calendar-rows',
    (ul) => getComputedStyle(ul).gridTemplateColumns.split(' ').length,
  );
  check('the list is one column at 1400px', tracks === 1, `${tracks} tracks`);

  // ── 4. A rotation pool has a season window and no reset date ─────────────────────────── //
  check(
    'a curated queue offers the reset date',
    (await page.locator('[data-testid="calendar-bob-reset-month"]').count()) === 1,
  );
  check(
    'a rotation pool offers the season window',
    (await page.locator('[data-testid="calendar-younger-season-start-month"]').count()) === 1,
  );
  check(
    'a rotation pool is NOT offered the reset date the server would refuse',
    (await page.locator('[data-testid="calendar-younger-reset-month"]').count()) === 0,
  );

  // ── 6. The Add control, and what it offers ───────────────────────────────────────────── //
  await page.click('[data-testid="calendar-add"]');
  await page.waitForSelector('[role="listbox"] [role="option"]');
  const addValues = await page.$$eval('[role="listbox"] [role="option"] [data-value]', (els) =>
    els.map((el) => el.getAttribute('data-value')),
  );
  check(
    'the Add picker offers exactly the queues that are not on the calendar',
    addValues.join(',') === ',family,older',
    addValues.join(','),
  );
  await page.click('[role="listbox"] [role="option"] [data-value="family"]');
  await page.click('#calendar-add-go');
  await page.waitForSelector('[data-set="family"]', { timeout: 30000 });
  check('adding a queue opens a row for it', true);
  check(
    '…and nothing was written by the add itself',
    writes.length === 0,
    JSON.stringify(writes),
  );

  // ── 5. Half a season window is refused, and nothing is sent ──────────────────────────── //
  await pickValue(page, '[data-testid="calendar-family-season-start-month"]', '3');
  await page.click('#calendar-family-save');
  const isRefused = await page
    .waitForFunction(
      () => (document.querySelector('#status')?.textContent ?? '').includes('BOTH'),
      undefined,
      { timeout: 10000 },
    )
    .then(() => true, () => false);
  check(
    'half a season window is refused, naming both ends',
    isRefused,
    await page.locator('#status').innerText().catch(() => ''),
  );
  check(
    '…and nothing reached the API',
    writes.length === 0,
    JSON.stringify(writes),
  );

  // ── 3. It EDITS: the value reaches the SET ───────────────────────────────────────────── //
  // The reset date on a curated queue. `bob_anime` carries 04-01; move it to 1 May.
  await pickValue(page, '[data-testid="calendar-bob_anime-reset-month"]', '5');
  await page.click('#calendar-bob_anime-save');
  const isSaved = await page
    .waitForFunction(
      () => (document.querySelector('#status')?.textContent ?? '').includes('dates saved'),
      undefined,
      { timeout: 90000 },
    )
    .then(() => true, () => false);
  check('a saved date reports itself', isSaved);

  const anime = await setById('bob_anime');
  check(
    'the reset date reached the SET, in the one spelling the server stores',
    anime.reset_watched_on === '05-01',
    String(anime.reset_watched_on),
  );
  check(
    'and the row re-reads it from the server',
    (await page.locator('[data-set="bob_anime"]').innerText()).includes('1 May'),
  );
  check(
    'a curated save patches only the date fields',
    writes.length === 1 &&
      Object.keys(JSON.parse(writes[0]?.body ?? '{}')).sort().join(',') ===
        'reset_watched_on,season_end,season_start',
    JSON.stringify(writes),
  );

  // A whole season window, on a rotation pool, which is the other kind of set and the other
  // setting. Moving `younger` to 1 Jun → 30 Sep.
  await pickValue(page, '[data-testid="calendar-younger-season-end-month"]', '9');
  await pickValue(page, '[data-testid="calendar-younger-season-end-day"]', '30');
  await page.click('#calendar-younger-save');
  await page
    .waitForFunction(
      () => (document.querySelector('#status')?.textContent ?? '').includes('dates saved'),
      undefined,
      { timeout: 90000 },
    )
    .catch(() => null);

  const younger = await setById('younger');
  check(
    'a rotation pool keeps its season window, both ends',
    younger.season_start === '06-01' && younger.season_end === '09-30',
    `${String(younger.season_start)} → ${String(younger.season_end)}`,
  );
  check(
    '…and no reset date was invented for it',
    younger.reset_watched_on == null,
    String(younger.reset_watched_on),
  );

  // The day picker is keyed on the MONTH, so a 31 chosen in a 31-day month cannot survive a
  // move to February. `bob` is 1 Oct → 5 Nov; take the window's end to 31 Dec, then to Feb.
  await pickValue(page, '[data-testid="calendar-bob-season-end-month"]', '12');
  await pickValue(page, '[data-testid="calendar-bob-season-end-day"]', '31');
  await pickValue(page, '[data-testid="calendar-bob-season-end-month"]', '2');
  await page.click('[data-testid="calendar-bob-season-end-day"]');
  await page.waitForSelector('[role="listbox"] [role="option"]');
  const febDays = await page.$$eval('[role="listbox"] [role="option"] [data-value]', (els) =>
    els.map((el) => el.getAttribute('data-value')),
  );
  check(
    'choosing February clamps 31 and offers 29 days, never 30 or 31',
    febDays.length === 29 && febDays.at(-1) === '29',
    `${febDays.length} days`,
  );
  // Close by RE-CLICKING the trigger, never Escape — the house rule `pick.ts` states.
  await page.click('[data-testid="calendar-bob-season-end-day"]');

  // ── 7. The Narrow View does not scroll sideways ──────────────────────────────────────── //
  const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } });
  narrow.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await narrow.goto(`${BASE}/calendar`, { waitUntil: 'domcontentloaded' });
  await narrow.waitForSelector('#calendar-rows', { timeout: 30000 });
  await settle(narrow);
  const overflow = await narrow.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  check(
    'the Narrow View does not scroll horizontally',
    overflow.scroll <= overflow.client,
    `${overflow.scroll} > ${overflow.client}`,
  );
  const narrowTracks = await narrow.$eval(
    '#calendar-rows',
    (ul) => getComputedStyle(ul).gridTemplateColumns.split(' ').length,
  );
  check('…and the list is still one column', narrowTracks === 1, `${narrowTracks} tracks`);

  await narrow.close();
  await browser.close();
} finally {
  killServer(srv);
}

console.log(failed === 0 ? 'PASS calendar-view-test' : `FAIL calendar-view-test (${failed})`);
process.exit(failed === 0 ? 0 : 1);
