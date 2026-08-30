// Path routing: the client router and the server's SPA fallback, pinned TOGETHER.
//
// The app moved off `location.hash` on 2026-08-16 (fleet decision
// `2026-08-16-owned-web-apps-use-react-router-with-path-urls`). That change has two halves
// in two different packages, and each half is silently useless without the other:
//
//   * `web/` renders a react-router `<BrowserRouter>`, so the URL is now `/queues`, not
//     `#/queues`. Nothing in web/'s own gates can tell whether the SERVER will answer that.
//   * `server/src/buildServer.ts` runs `createStaticHandler({ hasSpaFallback: true })`, so
//     an unmatched extensionless path returns index.html. Nothing in server/'s gates can
//     tell whether the client would route it.
//
// Flip either back and the app still passes lint, typecheck, the unit tests, the build and
// every other browser suite — and then 404s the first time anyone reloads on a deep link,
// bookmarks one, or pastes one into chat. `hasSpaFallback` in particular reads like tidiness
// and was deliberately `false` for the whole hash era, with a comment saying so. This suite
// is what makes flipping it back fail loudly.
//
// Needs no Plex token: every assertion is about URLs, the router and the header chrome,
// all of which render on the degraded no-Plex path.
import { chromium } from './playwright.js';

const PORT = process.env.WEB_PORT || 18768;
const BASE = `http://localhost:${PORT}`;
const ok = (name: string, isPass: boolean) => { console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}`); if (!isPass) process.exitCode = 1; };

// --- 1. The SERVER half, before a browser is involved ------------------------------- //
// A cold GET of each route is exactly what a reload/bookmark/pasted link does.
for (const path of ['/', '/admin', '/overview', '/people', '/what-to-watch-play', '/what-to-watch-play/surprise', '/picks', '/queues', '/q/bob', '/channels/younger', '/channels', '/tonight', '/tonight/surprise', '/collection', '/collection/board-games', '/board-game-collection']) {
  const res = await fetch(BASE + path);
  const body = await res.text();
  ok(`GET ${path} serves the app (${res.status})`, res.ok && body.includes('<div id="root">'));
}

// The fallback must not have swallowed the API or the assets — those are the two ways
// `hasSpaFallback: true` goes wrong, and both fail as a 200 of the wrong thing.
{
  const api = await fetch(`${BASE}/api/sets`);
  const ctype = api.headers.get('content-type') ?? '';
  ok(`GET /api/sets is still JSON, not index.html (${ctype})`, ctype.includes('application/json'));

  const missing = await fetch(`${BASE}/assets/definitely-not-here.js`);
  ok(`a missing asset still 404s rather than returning index.html (${missing.status})`, missing.status === 404);
}

// --- 2. The CLIENT half ------------------------------------------------------------- //
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

/** The chrome lands a render AFTER the location commits — always wait for the heading. */
const heading = (want: string) =>
  page.waitForFunction(
    (w) => document.querySelector('#heading')?.textContent?.trim() === w,
    want,
    { timeout: 30000 },
  ).then(() => true, () => false);

// Each deep link boots straight into its own view — the router agreeing with the server.
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
const modeLanding = () =>
  page.waitForSelector('#mode-landing:not([hidden])', { timeout: 30000 });
await modeLanding();
const modeLinks = await page.$$eval('#mode-landing a', (els) =>
  els.map((el) => ({
    href: el.getAttribute('href'),
    text: el.textContent?.replace(/\s+/g, ' ').trim(),
  })),
);
ok(
  'the task home offers two starts and four management destinations',
  modeLinks.length === 6 &&
    modeLinks[0]?.href === '/what-to-watch-play' &&
    modeLinks[0].text?.startsWith('What to Watch/Play') === true &&
    modeLinks[1]?.href === '/queues' &&
    modeLinks[1].text?.startsWith('Open a queue') === true &&
    modeLinks.some((link) => link.href === '/people' && link.text?.startsWith('People')),
);

for (const [path, want] of [
  ['/overview', 'Overview'],
  ['/people', 'People'],
  ['/queues', 'Queues'],
  ['/q/bob', 'Bob — Movies'],
  // What to Watch/Play, and its Surprise Me STEP. The step is a second path on one view, so
  // it is the case a `startsWith` router gets wrong in the direction that never fails loudly.
  ['/what-to-watch-play', 'What to Watch/Play'],
  ['/what-to-watch-play/surprise', 'What to Watch/Play'],
  ['/collection', 'Collection'],
  ['/collection/board-games', 'Board Games'],
] as const) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  ok(`deep link ${path} renders "${want}"`, await heading(want));
  if (path === '/what-to-watch-play') {
    const text = await page.locator('body').innerText();
    ok('the activity picker does not use Tonight as its visible name', !/\bTonight\b/.test(text));
  }
}

await page.goto(`${BASE}/channels/younger`, { waitUntil: 'domcontentloaded' });
ok(
  'a Rules queue deep link renders one Rules detail',
  Boolean(
    await page
      .waitForSelector('#channels:not([hidden])', { timeout: 30000 })
      .catch(() => null),
  ),
);

await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
ok('the legacy /admin address renders the task home', Boolean(await modeLanding()));
ok(
  '…and its URL is rewritten to /',
  (await page.evaluate(() => location.pathname)) === '/',
);

await page.goto(`${BASE}/picks`, { waitUntil: 'domcontentloaded' });
ok('the legacy /picks address renders "Queues"', await heading('Queues'));
ok(
  '…and its URL is rewritten to /queues',
  (await page.evaluate(() => location.pathname)) === '/queues',
);

// The Surprise Me step really is the STEP and not the bare route — the heading is the same
// on both, so the heading alone cannot tell them apart.
{
  await page.goto(`${BASE}/what-to-watch-play/surprise`, { waitUntil: 'domcontentloaded' });
  const isStep = await page
    .waitForSelector('#tonight-surprise', { timeout: 30000 })
    .then(() => true, () => false);
  ok('/what-to-watch-play/surprise renders the narrowing step, not the bare form', isStep);

  await page.reload({ waitUntil: 'domcontentloaded' });
  const survives = await page
    .waitForSelector('#tonight-surprise', { timeout: 30000 })
    .then(() => true, () => false);
  ok('…and survives a reload, so the SPA fallback answers a nested path too', survives);
}

// `/tonight` was the old user-facing name. It remains a live address, but the app rewrites
// it to the new name instead of showing the old label.
{
  await page.goto(`${BASE}/tonight`, { waitUntil: 'domcontentloaded' });
  ok('the legacy /tonight address opens What to Watch/Play', await heading('What to Watch/Play'));
  ok(
    '…and its URL is rewritten to /what-to-watch-play',
    (await page.evaluate(() => location.pathname)) === '/what-to-watch-play',
  );
}

// The collection picker, its Board Games detail, and the legacy shelf address.
{
  await page.goto(`${BASE}/collection`, { waitUntil: 'domcontentloaded' });
  ok('deep link /collection renders the picker', await heading('Collection'));

  const isPicker = await page
    .waitForSelector('#collection-picker:not([hidden])', { timeout: 30000 })
    .then(() => true, () => false);
  ok('…the picker view itself, not just the chrome', isPicker);

  await page.goto(`${BASE}/collection/board-games`, { waitUntil: 'domcontentloaded' });
  ok('deep link /collection/board-games renders the shelf', await heading('Board Games'));

  const isShelf = await page
    .waitForSelector('#collection:not([hidden])', { timeout: 30000 })
    .then(() => true, () => false);
  ok('…the shelf view itself, not just the chrome', isShelf);

  await page.reload({ waitUntil: 'domcontentloaded' });
  ok('…and a RELOAD on it still renders the shelf', await heading('Board Games'));
  ok(
    '…still on the new path after the reload',
    (await page.evaluate(() => location.pathname)) === '/collection/board-games',
  );

  // The old specific address redirects to the new detail route.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await modeLanding();
  await page.goto(`${BASE}/board-game-collection`, { waitUntil: 'domcontentloaded' });
  ok('the legacy board-game address still renders the shelf', await heading('Board Games'));

  const redirected = await page
    .waitForFunction(() => location.pathname === '/collection/board-games', undefined, { timeout: 30000 })
    .then(() => true, () => false);
  ok(
    `…and the URL is rewritten to /collection/board-games (got ${await page.evaluate(() => location.pathname)})`,
    redirected,
  );

  // REPLACE, not push: a redirect that pushes makes Back land on the old path, which
  // redirects forward again and the button reads as dead.
  await page.goBack();
  ok('…Back from the redirect returns to the mode landing, not into a loop', Boolean(await modeLanding()));
}

// A reload has to survive, which is the entire point of the fallback.
await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
await heading('Bob — Movies');
await page.reload({ waitUntil: 'domcontentloaded' });
ok('reloading on /q/bob still renders the queue', await heading('Bob — Movies'));

// A left-click routes CLIENT-side: no document load, no `#` in the URL. A regression to
// bare `<a href="/picks">` still "works" for the user but refetches the whole app, so
// count real page loads rather than trusting the URL alone.
{
  await page.goto(`${BASE}/overview`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#goqueues');
  ok(
    'Admin no longer exposes the Groups editor',
    (await page.locator('#groupsedit').count()) === 0 &&
      !(await page.locator('body').innerText()).includes('Edit groups'),
  );

  let loads = 0;
  page.on('load', () => { loads += 1; });

  // Still a real anchor with a real href — decision 2026-08-15. `<Link>` renders one, so
  // middle-click / ⌘-click / "copy link address" survived the migration.
  //
  // READ BEFORE THE CLICK, since 2026-08-27: each view mounts only on its own route now, so
  // Admin's markup is gone the moment this link is followed. Reading it here is also the
  // honest order — the claim is about the control being clicked.
  const [tag, href] = await page.$eval('#goqueues', (e) => [e.tagName, e.getAttribute('href')]);
  ok(`…and is still <a href> (${tag} → ${href})`, tag === 'A' && href === '/picks');

  await page.click('#goqueues');
  ok('clicking "Configure ›" routes to the Queues index', await heading('Queues'));
  ok('…and the path is /queues', (await page.evaluate(() => location.pathname)) === '/queues');
  ok('…as a PATH with no "#"', !(await page.evaluate(() => location.href)).includes('#'));
  ok('…client-side, with no full page load', loads === 0);
  ok(
    'the page scrollbar uses Charcuterie styling',
    await page.evaluate(() => document.documentElement.classList.contains('charcuterie-scrollbar')),
  );
}

// The browser's own Back must work — it did not exist as a question under the hash router.
await page.goBack();
ok('browser Back returns to Overview', await heading('Overview'));

// A route change is a new page, so it must not inherit the scroll position of the page that
// led to it.
{
  await page.goto(`${BASE}/queues`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a.open');
  // Picks starts collapsed. Expand it so this ROUTING check has a long page to scroll.
  await page.click('#collapseall');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const scrollBeforeQueue = await page.evaluate(() => window.scrollY);
  ok('the Picks page can be scrolled before opening a queue', scrollBeforeQueue > 0);
  await page.locator('.shelf a.open').last().click();
  await page.waitForFunction(() => location.pathname.startsWith('/q/'));
  await page.waitForSelector('#queue:not([hidden])');
  ok(
    'opening a queue resets the page scroll to the top',
    await page.evaluate(() => window.scrollY === 0),
  );
}

// The in-app back control points at the ORIGIN — where navigation into this view STARTED,
// not a fixed parent (Bob's ask). That is tracked in web/src/state/route.ts, and it is the
// one piece of the old hash router react-router does NOT replace.
{
  await page.goto(`${BASE}/queues`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a.open');
  await page.click('a.open');
  await page.waitForFunction(() => location.pathname.startsWith('/q/'));
  await page.waitForFunction(() => document.querySelector('#back')?.getAttribute('href') === '/queues', undefined, { timeout: 30000 })
    .then(() => ok('in-app back targets the origin /queues, not a fixed parent', true),
      async () => ok(`in-app back targets the origin /queues, not a fixed parent (got ${await page.$eval('#back', (e) => e.getAttribute('href'))})`, false));
}

await browser.close();
console.log('done');
