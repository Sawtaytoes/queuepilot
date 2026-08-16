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
for (const path of ['/', '/queues', '/q/bob', '/channels/shows', '/channels']) {
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
for (const [path, want] of [
  ['/', 'QueuePilot'],
  ['/queues', 'Ordered Queues'],
  ['/q/bob', 'Bob — Movies'],
  ['/channels/shows', 'Pools'],
] as const) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  ok(`deep link ${path} renders "${want}"`, await heading(want));
}

// A reload has to survive, which is the entire point of the fallback.
await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
await heading('Bob — Movies');
await page.reload({ waitUntil: 'domcontentloaded' });
ok('reloading on /q/bob still renders the queue', await heading('Bob — Movies'));

// A left-click routes CLIENT-side: no document load, no `#` in the URL. A regression to
// bare `<a href="/queues">` still "works" for the user but refetches the whole app, so
// count real page loads rather than trusting the URL alone.
{
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#goqueues');

  let loads = 0;
  page.on('load', () => { loads += 1; });

  await page.click('#goqueues');
  ok('clicking "Configure ›" routes to /queues', await heading('Ordered Queues'));
  ok('…as a PATH with no "#"', !(await page.evaluate(() => location.href)).includes('#'));
  ok('…client-side, with no full page load', loads === 0);

  // Still a real anchor with a real href — decision 2026-08-15. `<Link>` renders one, so
  // middle-click / ⌘-click / "copy link address" survived the migration.
  const [tag, href] = await page.$eval('#goqueues', (e) => [e.tagName, e.getAttribute('href')]);
  ok(`…and is still <a href> (${tag} → ${href})`, tag === 'A' && href === '/queues');
}

// The browser's own Back must work — it did not exist as a question under the hash router.
await page.goBack();
ok('browser Back returns to the landing', await heading('QueuePilot'));

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
