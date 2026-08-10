// The narrow view must not scroll sideways. Ever.
//
// Reported 2026-08-10: at phone width the whole page scrolled ~210px to the right into
// dead space — the title cut off mid-word, every card's text gone off the left edge, and
// the painted background ending partway across with black beyond it. Two independent
// causes, both in this app's own `web/src/styles/app.css` (neither in `@charcuterie/ui`):
//
//   1. `.hmenu-left` / `.hmenu-right` parked their CLOSED state at `translateX(±110%)`.
//      A transform does not remove a box from the document's scrollable overflow region,
//      and neither does `visibility: hidden`, so the 204px right-hand panel sat at
//      x 396→600 in a 390px viewport and `documentElement.scrollWidth` read 600.
//   2. `.playrow .rowmain` had no `overflow-wrap`, so a channel/queue name that is one
//      long unbroken token painted straight past `min-width: 0` (measured 797px).
//
// Both are invisible to every other suite — they assert behaviour, not geometry — and to
// typecheck and the build. Only a measured scrollWidth catches them, so: measure it.
//
// Runs against the shared e2e server (WEB_PORT, default 18768) like the other browser
// suites. Needs no Plex token: the Play landing renders from queues.yaml on the degraded
// no-Plex path, which is exactly the state the loop starts it in.
import { chromium } from './playwright.mjs';

const PORT = process.env.WEB_PORT || 18768;
const ok = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) process.exitCode = 1; };

// 390px is the reported width (iPhone 14/15 CSS width); 320px is the narrowest phone
// still in the wild and the one a fixed `min-width` breaks first.
const WIDTHS = [390, 320];

const browser = await chromium.launch();

/** documentElement scroll vs client width — the one number this suite exists to hold. */
const measure = (page) => page.evaluate(() => {
  const de = document.documentElement;
  return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth };
});

/** Names the boxes that stick out, so a failure says WHICH element regressed. */
const offenders = (page) => page.evaluate(() => {
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
  await page.waitForSelector('.playrow', { timeout: 30000 });
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
      const name = document.querySelector('.playrow .rowname');
      const meta = document.querySelector('.playrow .rowmeta');
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

  await page.close();
}

await browser.close();
console.log('done');
