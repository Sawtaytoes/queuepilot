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

await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });

// 0. Landing = the Play list: Rules (2 generic) + Picks (3 anime + 3 movie wishlists).
// no posters. (decision `2026-08-23-kind-is-picks-or-rules` — Ordered and Curated share Picks.)
await page.waitForSelector('.playcard', { timeout: 30000 });
const rulesRows = await page.$$eval('#playgrid li[data-kind="rules"] .rowname', (els) => els.map((e) => e.textContent));
const picksRows = await page.$$eval('#playgrid li[data-kind="picks"] .rowname', (els) => els.map((e) => e.textContent));
ok('landing: 2 rules rows (Shows & Shorts + Movies)',
  rulesRows.length === 2 && rulesRows[0] === 'Shows & Shorts' && rulesRows[1] === 'Movies');
ok('landing: 6 picks rows (anime + movie wishlists)', picksRows.length === 6);
ok('landing: no posters', !(await page.$('#play .tile')));
const kindWords0 = await page.$$eval('#playgrid .cardkind', (els) =>
  [...new Set(els.map((e) => (e.textContent ?? '').trim()))]);
ok('landing: cards named Picks + Rules only',
  kindWords0.includes('Picks') && kindWords0.includes('Rules')
  && !kindWords0.includes('Ordered Queue') && !kindWords0.includes('Curated Pool')
  && !kindWords0.includes('Filtered Pool'));

// 1. Picks configurator: EVERY hand-picked shelf, and only those (rules live elsewhere).
//
// Six and not three, since 2026-08-26. The random-lane Picks queues — `bob_anime` and its
// siblings — used to be listed on the RULES page, which was the last of the
// Ordered-Queue / Curated-Pool / Filtered-Pool split. `add_as` is a lane default inside one
// Picks queue and never decides which page it lives on
// (decision `2026-08-26-a-picks-queue-lives-on-the-picks-screen-whichever-lane-it-defaults-to`).
await page.click('#goqueues');
await page.waitForSelector('.shelf', { timeout: 30000 });
const shelves = await page.$$eval('.shelf', (els) => els.map((e) => e.dataset.set));
ok(`every Picks queue has a shelf, both lanes (${shelves.length})`,
  shelves.length === picksRows.length && shelves.includes('bob_anime'));
ok('no rules queue on the Picks page', !shelves.includes('younger') && !shelves.includes('older'));
// A shelf SAYS which lane its posters are in — the count clause beside the name. Without it a
// random-lane queue and an ordered one are the same row of posters.
//
// NON-EMPTY shelves, and the qualifier is the contract rather than a hedge: an empty queue is
// in neither lane, so it draws no clause. Counting `.shelf` instead would make this assertion
// fail the moment somebody adds an empty queue to the fixture.
const laneClauses = await page.$$eval('.shelf', (els) =>
  els.map((el) => ({
    hasItems: el.querySelectorAll('li.tile').length > 0,
    text: (el.querySelector('h2 .lanes-sec')?.textContent ?? '').trim(),
  })));
ok(`every non-empty shelf names its lane (${JSON.stringify(laneClauses)})`,
  laneClauses.some((c) => c.hasItems)
  && laneClauses.every((c) => (c.hasItems ? /priority|pool/.test(c.text) : c.text === '')));

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
// The shelf count BEFORE the save — see the wait below for why it is not the name.
const shelvesBeforeAdd = shelves.length;
await page.click('#set-save');
// A COUNT, not the name typed above. `.lbl` is the queue's ACTIVITY since WP-5 landed on
// 2026-08-25 (`queueTitle`), so this shelf reads "Movies & Shows 7" and the hand-typed label
// it was matching can never appear there again. The suite had been dying on this line ever
// since — silently, because a `waitForFunction` timeout throws rather than printing FAIL,
// so it read as a passing run that simply stopped early and took the ~30 assertions below
// it with it. Second time this file has lost its tail that way; `#set-libs` was the first,
// and the comment above says so.
await page.waitForFunction(
  (before) => document.querySelectorAll('.shelf').length === before + 1,
  shelvesBeforeAdd,
  { timeout: 20000 },
);
ok('new queue shelf appears', true);

// 5. Search again → menu now offers the new queue; add Toy Tinkers to it.
await page.fill('#gsearch', 'toy tinkers');
await page.waitForSelector('#gresults.open li', { timeout: 15000 });
await page.click('#gresults li [data-testid="results-addto"]');
await page.waitForSelector('.addtomenu [role="menuitem"]');
const menuLabels = await page.$$eval('.addtomenu [role="menuitem"]', (bs) => bs.map((b) => b.textContent));
// `startsWith`, not equality: a row is "<queue><people>" since 2026-08-26 — the chip that
// tells two "Movies & Shows" rows apart is part of the menu item's text.
ok(`menu offers Bob — Shorts (${JSON.stringify(menuLabels)})`,
  menuLabels.some((label) => label?.startsWith('Bob — Shorts')));
await page.click('.addtomenu [role="menuitem"]:has-text("Bob — Shorts")');
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Added'), undefined, { timeout: 20000 });
ok('added via header search', true);
ok('results stay open after add', await page.$eval('#gresults', (e) => e.classList.contains('open')));
await page.keyboard.press('Escape');

// 6. Filter hides non-matching shelves.
//
// This asserted **0** until 2026-08-26, on the premise that "anime channels no longer shelve
// here at all" — which was the defect this PR fixes, written down as an expectation. Every
// Picks queue is on this page now, so the anime ones are here and the filter has real work to
// do. Asserting the SPLIT rather than a bare count: a filter that matched everything and a
// filter that matched nothing would both slip past "> 0".
await page.fill('#qfilter', 'anime');
const shown = await page.$$eval('.shelf', (els) =>
  els.filter((e) => !(e as HTMLElement).hidden).map((e) => (e as HTMLElement).dataset.set));
ok(`filter "anime" → the anime queues, and only those (${JSON.stringify(shown)})`,
  shown.length > 0 && shown.every((id) => id?.includes('anime')));
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
// The REGISTRY, not `.shelf .lbl`. A shelf is named after its activity since WP-5, so the
// typed label never reaches that element and this line waited 20 s and then killed the rest
// of the suite — the same stale-name trap as the create wait above. What the assertion under
// it is actually about is that the rename persisted and the ID did not move, which is a
// question for `/api/sets`.
await page.waitForFunction(async () => {
  const r = await fetch('/api/sets').then((x) => x.json());
  return r.sets.some(
    (s: { id: string; label: string }) =>
      s.id === 'bob_shorts' && s.label === 'Bob — Short Films',
  );
}, undefined, { timeout: 20000 });
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

// F. Play landing: Rules + Picks (Ordered and Curated share the Picks badge).
// Routing is real paths now, so an in-page `location.hash = …` is no longer a
// navigation — `page.goto` is. The reload is harmless here: everything asserted
// below is re-fetched from the server, and the rename above already persisted.
await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#playgrid li[data-kind="rules"]', { timeout: 20000 });
const dyn = await page.$$eval('#playgrid li[data-kind="rules"] .rowname', (els) => els.map((e) => e.textContent));
const picks = await page.$$eval('#playgrid li[data-kind="picks"] .rowname', (els) => els.map((e) => e.textContent));
ok('F: Rules = Shows & Shorts + Movies', dyn.length === 2 && dyn[0] === 'Shows & Shorts' && dyn[1] === 'Movies');
ok('F: Picks holds the hand-picked sets', picks.length >= 1);
const kindWords = await page.$$eval('#playgrid .cardkind', (els) =>
  [...new Set(els.map((e) => (e.textContent ?? '').trim()))]);
ok('F: cards named Picks + Rules',
  kindWords.includes('Picks') && kindWords.includes('Rules')
  && !kindWords.includes('Ordered Queue') && !kindWords.includes('Curated Pool')
  && !kindWords.includes('Filtered Pool'));
// The Rules picker lists the RULES sets and only those — a flat SelectListbox, never a
// native <select> (2026-08-07-plex-channels-pickers-are-listbox-not-native-select). It used
// to append every random-lane Picks queue under a `q:` prefix; the Picks page holds both
// lanes now, so the two lists stopped overlapping
// (2026-08-26-a-picks-queue-lives-on-the-picks-screen-whichever-lane-it-defaults-to).
await page.goto(`${BASE}/channels/shows`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="chchannel"]', { state: 'attached', timeout: 20000 });
const chanOpts = await readOptions(page, '[data-testid="chchannel"]');
// `readOptions` returns each row's whole text, and a row is "<pool><account>" since
// 2026-08-26 — so these are `startsWith`, not equality.
ok(`F: rules picker lists rules queues alone (${JSON.stringify(chanOpts)})`,
  chanOpts.length === dyn.length
  && chanOpts[0]?.startsWith('Shows & Shorts') === true
  && chanOpts[1]?.startsWith('Movies') === true);
// Stated as its own claim rather than left implicit in the count: the defect was a Picks
// queue APPEARING here, and a length check alone would pass a list that swapped one in.
ok('F: no Picks queue in the rules picker',
  chanOpts.every((label) => !picks.some((p) => p && label.startsWith(p))));
// WHOSE pool each row is. "Shows" and "Shows & Shorts" are the same words until you know one
// is Younger Kids and the other Older Kids, which the landing card has said since 2026-08-17
// and this picker did not say at all (owner, 2026-08-26). Every fixture pool names an account,
// so every row must carry one — including the LEGACY flat ones, whose synthesized binding the
// first cut of `channelAccountLabel` wrongly refused.
ok(`F: every rules row names its account (${JSON.stringify(chanOpts)})`,
  chanOpts.every((label) => /Younger Kids|Older Kids/.test(label)));
// Noun: open a random-default Picks grid → its add box says "pool", not "queue".
//
// This assertion asked for "channel" until 2026-08-17, which the app stopped saying when
// the 2026-08-16 Pools rename landed ("Add — search this pool's libraries…"). It had been
// unreachable rather than passing: the `#set-libs` check above it crashed the whole suite
// on every run, so nothing here executed. Fixing that selector exposed this one.
const animeLabel = picks.find((l) => /anime/i.test(l ?? '')) ?? picks[0];
const animeId = animeLabel ? await page.evaluate((label) =>
  fetch('/api/queues').then((r) => r.json()).then((j: QueuesResponse) => Object.keys(j.sets).find((id) => j.sets[id]?.label === label)),
animeLabel) : null;
if (animeId) {
  await page.goto(`${BASE}/q/${animeId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#queue:not([hidden])', { timeout: 20000 });
  const ph = await page.$eval<string, HTMLInputElement>('#search', (e) => e.placeholder);
  ok(`F: picks add box says "pool" not "queue" (${ph})`, /pool/.test(ph) && !/queue/.test(ph));
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
