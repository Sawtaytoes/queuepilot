// The Narrow View must not scroll sideways. Ever.
//
// Reported 2026-08-10: in the Narrow View the whole page scrolled ~210px to the right into
// dead space — the title cut off mid-word, every card's text gone off the left edge, and
// the painted background ending partway across with black beyond it. Two independent
// causes, both in this app's own `web/src/styles/app.css` (neither in `@charcuterie/ui`):
//
//   1. `.hmenu-left` / `.hmenu-right` parked their CLOSED state at `translateX(±110%)`.
//      A transform does not remove a box from the document's scrollable overflow region,
//      and neither does `visibility: hidden`, so the 204px right-hand panel sat at
//      x 396→600 in a 390px viewport and `documentElement.scrollWidth` read 600.
//   2. the landing's name element had no `overflow-wrap`, so a channel/queue name that is one
//      long unbroken token painted straight past `min-width: 0` (measured 797px). It was
//      `.playrow .rowmain` then and is `.playcard .rowname` now — same bug, same fix, one
//      landing rewrite later.
//
// Both are invisible to every other suite — they assert behaviour, not geometry — and to
// typecheck and the build. Only a measured scrollWidth catches them, so: measure it.
//
// Reported again 2026-08-16, and the reason this suite did not catch it: it only ever
// visited `/`. The landing route was clean while `/queues` measured 485px in a 390px
// viewport, because `.gsearch-wrap` was an unwrapped flex row. The consequence was not a
// sideways scroll anyone would describe as one — Chrome widens the LAYOUT viewport
// to the overflowing content, so every `position: fixed` overlay then centres itself on
// 485 instead of 390, and all four modals rendered ~50px off the right edge of the
// screen. The modals were innocent; the page under them was not.
//
// So this suite now walks EVERY route and opens the modals, and it asserts two things
// that a document-level scrollWidth cannot say on its own:
//
//   * a modal's box lies inside the visual viewport (the displaced-overlay symptom), and
//   * no scroll container overflows on the inline axis (`#setmodal`'s fieldsets kept the
//     UA's `min-inline-size: min-content`, and `.chfilters-scroll`'s `overflow-y: auto`
//     silently computed `overflow-x` to `auto` as well — a horizontal scrollbar in the
//     filters panel at every width, desktop included).
//
// Runs against the shared e2e server (WEB_PORT, default 18768) like the other browser
// suites. Needs no Plex token: the Play landing renders from queues.yaml on the degraded
// no-Plex path, which is exactly the state the loop starts it in.
import { chromium, type Page } from './playwright.js';

const PORT = process.env.WEB_PORT || 18768;
const ok = (name: string, isPass: boolean) => { console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}`); if (!isPass) process.exitCode = 1; };

// 390px is the reported width (iPhone 14/15 CSS width); 320px is the narrowest screen
// still in the wild and the one a fixed `min-width` breaks first.
const WIDTHS = [390, 320];

const browser = await chromium.launch();

/** documentElement scroll vs client width — the one number this suite exists to hold. */
const measure = (page: Page) => page.evaluate(() => {
  const de = document.documentElement;
  return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth };
});

/**
 * Every element that scrolls on the INLINE axis it was not meant to. A document-level
 * `scrollWidth` says nothing about these: an inner `overflow: auto` box absorbs its own
 * overflow, so the page measures clean while the panel inside it is unusable — which is
 * how `.chfilters-scroll` shipped a horizontal scrollbar at every width. Reports the
 * offender's own scroll vs client width, the pair that names the bug.
 *
 * `root` scopes the search: pass a modal's id to ask only about that modal, or nothing to
 * sweep the page. Scoping matters — the Home shelves are still in the DOM behind an open
 * modal, and an unscoped sweep would report them as the modal's problem.
 *
 * `.strip` is the ONE deliberate horizontal scroller in this app: the Plex-style poster
 * shelf, which is a carousel and is supposed to run off the edge. Everything else that
 * scrolls sideways is a mistake.
 */
const inlineScrollers = (page: Page, root?: string) => page.evaluate((rootSelector) => {
  const scope = rootSelector ? document.querySelector(rootSelector) : document;
  if (!scope) return [`(missing scope ${rootSelector})`];
  return [...scope.querySelectorAll('*')]
    .filter((el) => {
      if (el.closest('.strip')) return false;
      // `visible`/`clip` never scroll. `clip` is the fix this suite is holding in place.
      if (!/auto|scroll/.test(getComputedStyle(el).overflowX)) return false;
      return el.scrollWidth > el.clientWidth + 1;
    })
    .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${
      typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''
    }@${el.scrollWidth}>${el.clientWidth}`)
    .slice(0, 6);
}, root);

/** An open modal's box, in viewport coordinates — `null` when it isn't on screen. */
const modalBox = (page: Page, id: string) => page.evaluate((boxId) => {
  const el = document.getElementById(boxId);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right), viewport: window.innerWidth };
}, id);

/** Names the boxes that stick out, so a failure says WHICH element regressed. */
const offenders = (page: Page) => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  return [...document.querySelectorAll('*')]
    .filter((el) => {
      // `position: fixed` boxes never extend the document's scrollable area.
      if (getComputedStyle(el).position === 'fixed') return false;
      return el.getBoundingClientRect().right > vw + 0.5;
    })
    .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${
      typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : ''
    }@${Math.round(el.getBoundingClientRect().right)}`)
    .slice(0, 6);
});

for (const width of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.playcard', { timeout: 30000 });
  await page.waitForTimeout(400); // let the header's ResizeObserver settle --header-h

  // 1. As rendered, menus closed. This is the reported bug.
  {
    const { scrollWidth, clientWidth } = await measure(page);
    ok(
      `${width}px: no horizontal scroll at rest (scrollWidth ${scrollWidth} <= clientWidth ${clientWidth})`,
      scrollWidth <= clientWidth,
    );
    if (scrollWidth > clientWidth) console.log('   overflowing:', (await offenders(page)).join(', '));
  }

  // 2. With the ⋮ actions popover OPEN — an anchored panel must fit, not push the page.
  {
    await page.click('#menu-actions');
    await page.waitForSelector('.hmenu-right.open');
    await page.waitForTimeout(300); // transition
    const { scrollWidth, clientWidth } = await measure(page);
    ok(`${width}px: no horizontal scroll with the actions menu open (${scrollWidth} <= ${clientWidth})`,
      scrollWidth <= clientWidth);
    if (scrollWidth > clientWidth) console.log('   overflowing:', (await offenders(page)).join(', '));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // 3. Closed again, after having been open — catches a closed state that only parks
  //    off-canvas once it has something to transition FROM.
  {
    const { scrollWidth, clientWidth } = await measure(page);
    ok(`${width}px: no horizontal scroll after closing the menu (${scrollWidth} <= ${clientWidth})`,
      scrollWidth <= clientWidth);
  }

  // 4. The min-content case: a name with no break opportunity anywhere in it. Set on the
  //    live DOM rather than through a fixture so this suite stays independent of the
  //    shared queues.yaml the other suites in the loop assert against — the CSS under
  //    test is identical either way.
  {
    const applied = await page.evaluate(() => {
      const LONG = 'Supercalifragilisticexpialidocious'.repeat(3); // 99 chars, zero break opportunities
      const name = document.querySelector('.playcard .rowname');
      const meta = document.querySelector('.playcard .rowmeta');
      if (!name) return false;
      name.textContent = LONG;
      if (meta) meta.textContent = `${LONG}-meta`;
      return true;
    });
    ok(`${width}px: found a .rowname to stress`, applied);
    await page.waitForTimeout(200);
    const { scrollWidth, clientWidth } = await measure(page);
    ok(`${width}px: a long unbroken channel name does not widen the page (${scrollWidth} <= ${clientWidth})`,
      scrollWidth <= clientWidth);
    if (scrollWidth > clientWidth) console.log('   overflowing:', (await offenders(page)).join(', '));
  }

  // 5. EVERY route, not just the landing one. This is the check that was missing on
  //    2026-08-16: `/` was clean and `/queues` was 95px over.
  //
  //    The queue id is read from the rendered landing rather than hard-coded, so this
  //    suite keeps working against whatever `queues.fixture.yaml` holds. A route that
  //    yields no id is SKIPPED loudly rather than silently passing.
  const queueId = await page.evaluate(() => {
    const link = document.querySelector<HTMLAnchorElement>('.playcard a[href^="/q/"]');
    return link?.getAttribute('href')?.replace(/^\/q\//, '') ?? null;
  });
  ok(`${width}px: found a queue id on the landing to visit`, Boolean(queueId));

  const routes = [
    ['/queues', '.playcard, #newqueue, .shelf'],
    ['/channels/shows', '#chbody'],
    ...(queueId ? [[`/q/${queueId}`, '#queue:not([hidden]) .add']] : []),
  ] as const;

  for (const [hash, ready] of routes) {
    // `goto`, not a `location.hash` write: routing is react-router PATHS since
    // 2026-08-16, so there is no hash left to poke and the server has an SPA fallback.
    await page.goto(`http://localhost:${PORT}${hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(ready, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(500); // the view swap + the header's ResizeObserver

    const { scrollWidth, clientWidth } = await measure(page);
    ok(`${width}px ${hash}: no horizontal scroll (${scrollWidth} <= ${clientWidth})`,
      scrollWidth <= clientWidth);
    if (scrollWidth > clientWidth) console.log('   overflowing:', (await offenders(page)).join(', '));

    const scrollers = await inlineScrollers(page);
    ok(`${width}px ${hash}: nothing scrolls sideways inside its own box`, scrollers.length === 0);
    if (scrollers.length) console.log('   inline scrollers:', scrollers.join(', '));
  }

  // 6. The modals. A modal that renders half off the right edge of the screen is the
  //    symptom the 2026-08-16 report actually described, and it is invisible to every
  //    measurement above — `position: fixed` boxes are excluded from `scrollWidth` by
  //    definition, which is exactly why they get to be wrong on their own.
  const modals = [
    // The LANDING's own create button. It is in this list rather than in a suite of its own
    // because this is the always-on browser gate: the Plex-gated suites are skipped on every
    // PR, so a landing that quietly loses its only create affordance again — which is how it
    // shipped for a month — would reach main unchallenged. The assertion is both halves at
    // once: the trigger exists on `/`, and the modal it opens lands inside the screen.
    ['/', '#playnewqueue', 'setmodal', 'New queue (landing)'],
    ['/queues', '#newqueue', 'setmodal', 'New queue'],
    ['/channels/shows', '#newcurated', 'setmodal', 'New curated pool'],
    ['/channels/shows', '#chconfigure', 'dynmodal', 'Configure a filtered pool'],
  ] as const;

  for (const [hash, trigger, boxId, label] of modals) {
    await page.goto(`http://localhost:${PORT}${hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);
    // `waitForSelector`, not a bare `$` after a fixed sleep. The channels view renders its
    // action buttons once the registry lands, and on a cold CI runner that took longer than
    // the 700ms wait above — `#newcurated` was reported missing at 320px while passing at
    // 390px in the SAME run, which is the signature of a race and not of a real absence.
    const isTriggerThere = await page
      .waitForSelector(trigger, { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    ok(`${width}px: ${label} — its trigger (${trigger}) exists`, isTriggerThere);
    if (!isTriggerThere) continue;

    await page.click(trigger);
    await page.waitForSelector(`#${boxId}`, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(400); // the overlay's own mount + position

    const box = await modalBox(page, boxId);
    ok(`${width}px: ${label} — the box is on screen`, Boolean(box));

    if (box) {
      ok(
        `${width}px: ${label} — inside the viewport (${box.left}→${box.right} within 0→${box.viewport})`,
        box.left >= 0 && box.right <= box.viewport,
      );
    }

    const scrollers = await inlineScrollers(page, `#${boxId}`);
    ok(`${width}px: ${label} — nothing scrolls sideways inside it`, scrollers.length === 0);
    if (scrollers.length) console.log('   inline scrollers:', scrollers.join(', '));

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  await page.close();
}

// 7. The same routes under REAL device emulation, which is a different test and not a
//    redundant one.
//
//    Everything above runs a desktop-shaped Chromium at a narrow viewport, where
//    `innerWidth` is fixed and overflow simply scrolls. An emulated device does something
//    else: when content overflows, Chrome widens the LAYOUT viewport to fit it. That is why the
//    2026-08-16 report was about modals rather than about scrolling — `scrollWidth` and
//    `clientWidth` both read 485 and agreed with each other, so the checks above would
//    have called it clean, while every `position: fixed` overlay centred on 485 in a
//    390px-wide screen and hung ~50px off the right edge.
//
//    The tell is one number: under `width=device-width, initial-scale=1` the layout
//    viewport must equal the device width. If it doesn't, something overflowed, and the
//    modal geometry that follows says how badly it landed.
for (const width of WIDTHS) {
  const page = await browser.newPage({
    deviceScaleFactor: 2,
    // Playwright's own option names, which are NOT renamed — they are third-party API
    // surface. What they are FOR here is the Narrow View: only under `isMobile` does
    // Chromium honour `<meta name="viewport">` and widen the layout viewport.
    hasTouch: true,
    isMobile: true,
    viewport: { width, height: 844 },
  });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.playcard', { timeout: 30000 });
  await page.waitForTimeout(400);

  for (const hash of ['/', '/queues', '/channels/shows'] as const) {
    await page.goto(`http://localhost:${PORT}${hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);

    // `window.innerWidth`, NOT `documentElement.clientWidth`. Only the first one moves:
    // when the page overflowed, `innerWidth` went to 485 in a 390px screen while
    // `clientWidth` stayed at 390 and reported everything as fine. Measured both ways
    // against the real regression before picking this one.
    const layout = await page.evaluate(() => window.innerWidth);
    ok(
      `${width}px (emulated) ${hash}: the layout viewport is ${layout}, and the screen is ${width}`,
      layout === width,
    );
    if (layout !== width) console.log('   overflowing:', (await offenders(page)).join(', '));
  }

  // And the modal that the widened viewport actually displaced.
  await page.goto(`http://localhost:${PORT}/queues`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await page.click('#newqueue');
  await page.waitForSelector('#setmodal', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);

  const box = await modalBox(page, 'setmodal');
  ok(`${width}px (emulated): New queue — the box is on screen`, Boolean(box));
  if (box) {
    ok(
      `${width}px (emulated): New queue — inside the screen (${box.left}→${box.right} within 0→${width})`,
      box.left >= 0 && box.right <= width,
    );
  }

  await page.close();
}

await browser.close();
console.log('done');
