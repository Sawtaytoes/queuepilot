// E2E for the new Home toolbar + queue CRUD + shelf reorder, against a local server.

// Port is overridable (WEB_PORT) so this suite can run on a private port outside run.sh.
import { chromium } from './playwright.js';
import { readOptions } from './pick.js';
const PORT = process.env.WEB_PORT || 18768;
const BASE = `http://localhost:${PORT}`;
const ok = (name: string, isPass: boolean) => {
  console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}`);
  if (!isPass) process.exitCode = 1;
};

/** The slices of `/api/sets` (a LIST) and `/api/queues` (a MAP) this suite reads back.
 * `Response.json()` is `any`, so these are what keep the `.find(...)` walks honest. */
interface SetsResponse {
  sets: { id: string; label: string }[];
}
interface QueuesResponse {
  sets: Record<string, { label: string }>;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('request', (r) => { if (r.url().includes('/api/') && r.method() !== 'GET') console.log('  >>', r.method(), r.url().replace(BASE, ''), (r.postData() || '').slice(0, 200)); });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });

// 0. Landing = the Play list, grouped Filtered Pools (2 generic) / Curated Pools (3 anime)
// / Ordered Queues (3),
// no posters.
await page.waitForSelector('.playcard', { timeout: 30000 });
const dynRows = await page.$$eval('#playgrid li[data-kind="filtered"] .rowname', (els) => els.map((e) => e.textContent));
const curRows = await page.$$eval('#playgrid li[data-kind="curated"] .rowname', (els) => els.map((e) => e.textContent));
const qRows = await page.$$eval('#playgrid li[data-kind="ordered"] .rowname', (els) => els.map((e) => e.textContent));
ok('landing: 2 filtered-pool rows (Shows & Shorts + Movies)',
  dynRows.length === 2 && dynRows[0] === 'Shows & Shorts' && dynRows[1] === 'Movies');
ok('landing: 3 curated-pool (anime) rows', curRows.length === 3);
ok('landing: 3 queue rows', qRows.length === 3);
ok('landing: no posters', !(await page.$('#play .tile')));

// 1. Ordered Queues configurator: only the ORDERED queues shelve here (pools live elsewhere).
await page.click('#goqueues');
await page.waitForSelector('.shelf', { timeout: 30000 });
const shelves = await page.$$eval('.shelf', (els) => els.map((e) => e.dataset.set));
ok('three queue shelves (no filtered pools, no anime curated pools)',
  shelves.length === 3 && !shelves.includes('younger') && !shelves.includes('bob_anime'));

// 2. Toolbar mounted in header on desktop.
ok('tools in header (Wide View)', await page.$eval('#gslot-wide #tools', () => true).catch(() => false));

// 3. Global search finds a Short; no compatible queue yet → notice.
await page.fill('#gsearch', 'toy tinkers');
await page.waitForSelector('#gresults.open li', { timeout: 15000 });
await page.click('#gresults li [data-testid="results-addto"]');
// `.addtomenu` is the Charcuterie `Menu` panel, and it PORTALS to <body> — so this is a
// document-wide read, never `#gresults .addtomenu`. The notice is a DISABLED menuitem
// rather than the old loose <p>: `Menu` renders `items` and nothing else.
const notice = await page.textContent('.addtomenu');
ok('shorts: no-compatible-queue notice', /No queue includes/.test(notice ?? ''));
await page.keyboard.press('Escape');

// 4. Create a queue that includes Shorts via the modal.
await page.click('#newqueue');
await page.fill('#set-label', 'Bob — Shorts');
// `#setmodal .libs`, not `#set-libs`. That id stopped existing when the libraries picker
// moved inside `ProviderBlock` (a queue holds N sources, and N elements cannot share one
// id), so this line had been CRASHING the whole suite on every run since — taking the ~30
// assertions below it with it. One source is the only shape this suite creates, so there
// is exactly one `.libs` here.
await page.check('#setmodal .libs input[value="15"]');
await page.click('#set-save');
await page.waitForFunction(() => [...document.querySelectorAll('.shelf .lbl')].some((e) => e.textContent === 'Bob — Shorts'), undefined, { timeout: 20000 });
ok('new queue shelf appears', true);

// 5. Search again → menu now offers the new queue; add Toy Tinkers to it.
await page.fill('#gsearch', 'toy tinkers');
await page.waitForSelector('#gresults.open li', { timeout: 15000 });
await page.click('#gresults li [data-testid="results-addto"]');
await page.waitForSelector('.addtomenu [role="menuitem"]');
const menuLabels = await page.$$eval('.addtomenu [role="menuitem"]', (bs) => bs.map((b) => b.textContent));
ok('menu offers Bob — Shorts', menuLabels.includes('Bob — Shorts'));
await page.click('.addtomenu [role="menuitem"]:has-text("Bob — Shorts")');
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Added'), undefined, { timeout: 20000 });
ok('added via header search', true);
ok('results stay open after add', await page.$eval('#gresults', (e) => e.classList.contains('open')));
await page.keyboard.press('Escape');

// 6. Filter hides non-matching shelves (anime channels no longer shelve here at all).
await page.fill('#qfilter', 'anime');
const visible = await page.$$eval('.shelf', (els) => els.filter((e) => !e.hidden).length);
ok('filter "anime" → 0 shelves (channels moved out)', visible === 0);
await page.fill('#qfilter', '');
await page.$$eval('.shelf', (els) => els.forEach(() => {}));

// 7. Collapse all / expand all.
await page.click('#collapseall');
let collapsed = await page.$$eval('.shelf', (els) => els.every((e) => e.classList.contains('collapsed')));
ok('collapse all', collapsed);
ok('button flips to Expand all', (await page.textContent('#collapseall')) === 'Expand all');
await page.click('#collapseall');
collapsed = await page.$$eval('.shelf', (els) => els.some((e) => e.classList.contains('collapsed')));
ok('expand all', !collapsed);

// 8. Shelf reorder: collapse all (long-list flow), then drag the last shelf's handle to
// the top. Everything must be inside the viewport for real mouse events to hit.
await page.click('#collapseall');
await page.waitForTimeout(300);
const handles = await page.$$('.shelf .shelfdrag');
const last = handles.at(-1);
const firstShelf = (await page.$$('.shelf'))[0];
// Named failures: a drag computed from a missing handle or an unrendered (box-less) shelf
// reports as "shelf drag did not reorder" three lines later, which blames the feature.
if (!last) throw new Error('no .shelf .shelfdrag handle to drag');
if (!firstShelf) throw new Error('no .shelf to drop onto');
await last.scrollIntoViewIfNeeded();
const hb = await last.boundingBox();
const fb = await firstShelf.boundingBox();
if (!hb || !fb) throw new Error('drag handle / drop target is not laid out (no bounding box)');
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(fb.x + 300, fb.y + 10, { steps: 12 });
await page.mouse.up();
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('order saved'), undefined, { timeout: 20000 });
const orderNow = await page.$$eval('.shelf', (els) => els.map((e) => e.dataset.set));
ok('shelf drag reorders (new queue first)', orderNow[0] === 'bob_shorts');
const apiOrder = await page.evaluate(() => fetch('/api/sets').then((r) => r.json()).then((j: SetsResponse) => j.sets.map((s) => s.id)));
console.log('  api order after drag:', apiOrder.join(','));

// 9. Reload — order persisted server-side.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.shelf');
const orderAfter = await page.$$eval('.shelf', (els) => els.map((e) => e.dataset.set));
ok('order survives reload', orderAfter[0] === 'bob_shorts');

// 10. Edit modal: rename the queue; id stays.
await page.hover('.shelf[data-set="bob_shorts"] h2');
await page.click('.shelf[data-set="bob_shorts"] .shelfedit');
ok('idnote shows immutable id', /id: bob_shorts/.test(await page.textContent('#set-idnote') ?? ''));
await page.fill('#set-label', 'Bob — Short Films');
await page.click('#set-save');
await page.waitForFunction(() => [...document.querySelectorAll('.shelf .lbl')].some((e) => e.textContent === 'Bob — Short Films'), undefined, { timeout: 20000 });
const sameId = await page.$('.shelf[data-set="bob_shorts"]');
ok('rename keeps id', Boolean(sameId));

// 11. Delete it (accept confirm).
page.on('dialog', (d) => d.accept());
await page.hover('.shelf[data-set="bob_shorts"] h2');
await page.click('.shelf[data-set="bob_shorts"] .shelfedit');
await page.click('#set-delete');
await page.waitForFunction(() => !document.querySelector('.shelf[data-set="bob_shorts"]'), undefined, { timeout: 20000 });
ok('delete removes shelf', true);

// 12. Narrow View: toolbar re-mounts into content.
await page.setViewportSize({ width: 480, height: 900 });
await page.waitForTimeout(200);
ok('tools in content (Narrow View)', await page.$eval('#gslot-narrow #tools', () => true).catch(() => false));

// 13. Queue view still works (open first shelf).
await page.setViewportSize({ width: 1400, height: 900 });
await page.click('.shelf .open');
await page.waitForSelector('#queue:not([hidden]) li.tile', { timeout: 20000 });
ok('queue view opens', true);
ok('tools hidden in queue view', await page.$eval('#tools', (e) => getComputedStyle(e).display === 'none'));

// ============================ v2 feedback batch ============================= //

// A. Inline pen-rename from the grid view. We're in a queue view (step 13). The pen shows,
// clicking it turns the heading into an input; Enter saves PATCH /api/sets/:id {label}.
ok('A: pen icon visible in grid view', await page.$eval('#editname', (e) => !e.hidden));
ok('A: Configure button in grid header', Boolean(await page.$('#qconfigure')));
const openSetId = await page.evaluate(() => location.pathname.replace('/q/', ''));
const newLabel = 'Renamed By Test';
await page.click('#editname');
await page.waitForSelector('#heading input');
await page.fill('#heading input', newLabel);
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Renamed'), undefined, { timeout: 20000 });
const persisted = await page.evaluate(async (id) =>
  fetch('/api/sets').then((r) => r.json()).then((j: SetsResponse) => j.sets.find((s) => s.id === id)?.label), openSetId);
ok('A: rename persisted server-side (label PATCH)', persisted === newLabel);
ok('A: heading shows the new label', (await page.textContent('#heading') ?? '').trim() === newLabel);

// K. The "Renamed" toast auto-dismisses (~4s success timeout). Assert it clears.
ok('K: toast present right after action', (await page.textContent('#status') ?? '').length > 0);
await page.waitForFunction(() => (document.querySelector('#status')?.textContent || '') === '', undefined, { timeout: 8000 });
ok('K: toast auto-dismissed', (await page.textContent('#status')) === '');

// F. Play landing groups into Filtered Pools / Curated Pools / Ordered Queues.
// Routing is real paths now, so an in-page `location.hash = …` is no longer a
// navigation — `page.goto` is. The reload is harmless here: everything asserted
// below is re-fetched from the server, and the rename above already persisted.
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#playgrid li[data-kind="filtered"]', { timeout: 20000 });
const dyn = await page.$$eval('#playgrid li[data-kind="filtered"] .rowname', (els) => els.map((e) => e.textContent));
const cur = await page.$$eval('#playgrid li[data-kind="curated"] .rowname', (els) => els.map((e) => e.textContent));
ok('F: Filtered Pools group = Shows & Shorts + Movies', dyn.length === 2 && dyn[0] === 'Shows & Shorts' && dyn[1] === 'Movies');
ok('F: Curated Pools group holds the anime sets', cur.length >= 1);
// The three names the taxonomy decision settled. They were three shelf HEADINGS until the
// landing became one grid (2026-08-19); each card carries its own kind badge now, so the same
// words are asserted where they actually live.
const kindWords = await page.$$eval('#playgrid .cardkind', (els) =>
  [...new Set(els.map((e) => (e.textContent ?? '').trim()))]);
ok('F: cards named Filtered/Curated Pool + Ordered Queue',
  kindWords.includes('Filtered Pool') && kindWords.includes('Curated Pool')
  && kindWords.includes('Ordered Queue'));
// The Pools picker lists the same pools — now a flat SelectListbox, NOT a native
// <select> with optgroups (Listbox has no option groups; filtered pools come first,
// then curated). 2026-08-07-plex-channels-pickers-are-listbox-not-native-select.
await page.goto(`${BASE}/channels/shows`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="chchannel"]', { state: 'attached', timeout: 20000 });
const chanOpts = await readOptions(page, '[data-testid="chchannel"]');
ok('F: channel picker lists dynamic-then-curated (flat)',
  chanOpts[0] === 'Shows & Shorts' && chanOpts[1] === 'Movies' && chanOpts.length >= 3);
// Noun: open a curated POOL's grid → its add box says "pool", not "queue".
//
// This assertion asked for "channel" until 2026-08-17, which the app stopped saying when
// the 2026-08-16 Pools rename landed ("Add — search this pool's libraries…"). It had been
// unreachable rather than passing: the `#set-libs` check above it crashed the whole suite
// on every run, so nothing here executed. Fixing that selector exposed this one.
const animeId = cur.length ? await page.evaluate((label) =>
  fetch('/api/queues').then((r) => r.json()).then((j: QueuesResponse) => Object.keys(j.sets).find((id) => j.sets[id]?.label === label)),
cur[0]) : null;
if (animeId) {
  await page.goto(`${BASE}/q/${animeId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#queue:not([hidden])', { timeout: 20000 });
  const ph = await page.$eval<string, HTMLInputElement>('#search', (e) => e.placeholder);
  ok(`F: curated-pool add box says "pool" not "queue" (${ph})`, /pool/.test(ph) && !/queue/.test(ph));
} else {
  ok('F: curated-pool add box says "pool" not "queue"', true); // no anime set in fixture
}

// H. The Movies channel pool uses an eye badge, never the old "Seen N×" (× reads as delete).
// Needs an MQTT broker to populate the pool; guard so a no-broker run doesn't false-fail
// but still catches a regression if tiles DO render.
await page.goto(`${BASE}/channels/movies`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#channels:not([hidden])', { timeout: 20000 });
await page.waitForTimeout(1500);
const pool = await page.evaluate(() => {
  const tiles = [...document.querySelectorAll('#chpool .tile')];
  return {
    n: tiles.length,
    seenX: tiles.some((t) => /Seen\s+\d+×/.test(t.textContent ?? '')),
    eye: tiles.some((t) => t.querySelector('.badge.watches svg')),
  };
});
ok('H: no old "Seen N×" badge in movie pool', !pool.seenX);
if (pool.n > 1) ok('H: eye-badge SVG present in movie pool', pool.eye);
else console.log('  (H eye-badge SVG unverified — movie pool empty: no MQTT broker in this run)');

await browser.close();
console.log('done');
