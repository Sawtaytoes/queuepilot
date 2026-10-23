// Before/after for "a person has a QueuePilot photo".
//
// Five frames, each a claim the PR makes:
//
//   1. `overview`  the Overview at 1420 px — the people filter chips and the cards' faces. On the
//                  branch Ada and Grace show their photos and Linus keeps his initials, which is
//                  the fallback for somebody with no photo.
//   2. `queues`    the Queues page, where every shelf heading draws its audience.
//   3. `editor`    the people editor with Ada's photo panel open — the current photo, the drop
//                  zone, and Remove photo.
//   4. `pending`   Linus's panel with a chosen-but-unsaved picture: the preview a person approves
//                  before anything is uploaded.
//   5. `narrow`    the editor and the panel in the Narrow View (384 px), which must not scroll
//                  sideways.
//
// The BEFORE run (on `main`) has no photo routes: its PUTs answer 404 and it has no Photo
// button, and it says so on stdout rather than failing — that is the state it documents.
//
// **Fixture data, never live.** This repo is public and a PNG is opaque to every grep. The cast
// is the landing fixture's Ada, Grace and Linus, and the "photos" are the invented drawings in
// `e2e/fixtures/photos/` (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers-queuepilot \
//     server/node_modules/.bin/tsx e2e/shot-person-photos.ts --tag=after
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { startFixtureServer } from './fixture-server.js';
import { chromium } from './playwright.js';
import { killServer, REPO_ROOT } from './stubs/server-process.mjs';

const PORT = Number(process.env.SHOT_PORT ?? 18795);
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';
const OUT = path.join(REPO_ROOT, '__screenshots__');
const photo = (name: string) => path.join(REPO_ROOT, 'e2e', 'fixtures', 'photos', `${name}.jpg`);

const darkInit = () => {
  try {
    localStorage.setItem('charcuterie-scheme', 'dark');
  } catch {
    /* light then */
  }
};

await fs.mkdir(OUT, { recursive: true });

const server = await startFixtureServer(PORT, {
  groups: 'landing.groups.yaml',
  people: 'landing.people-mapping.yaml',
  queues: 'landing.queues.yaml',
  sets: 'landing.sets.yaml',
});
const browser = await chromium.launch();

try {
  for (const id of ['ada', 'grace']) {
    const res = await fetch(`${server.base}/api/people/${id}/photo`, {
      body: await fs.readFile(photo(id)),
      headers: { 'content-type': 'image/jpeg' },
      method: 'PUT',
    });
    console.log(`PUT ${id}'s photo → ${res.status}`);
  }

  const ctx = await browser.newContext({ viewport: { height: 1000, width: 1420 } });
  await ctx.addInitScript(darkInit);
  const page = await ctx.newPage();

  await page.goto(`${server.base}/overview`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#play .playcard', { timeout: 60_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, `personphotos-${TAG}-overview.png`) });
  const photoFaces = await page.$$eval('[data-person-face] img', (nodes) =>
    nodes.filter((n) => (n as HTMLImageElement).naturalWidth > 0).length,
  );
  console.log(`${photoFaces} faces on the Overview drew a photo`);

  await page.goto(`${server.base}/queues`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shelf', { timeout: 60_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, `personphotos-${TAG}-queues.png`) });

  await page.goto(`${server.base}/people`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#people', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Edit people' }).click();
  await page.waitForSelector('#peoplemodal', { timeout: 15_000 });
  await page.waitForTimeout(800);

  const adaPhoto = page.getByRole('button', { name: 'Photo for Ada' });
  if ((await adaPhoto.count()) === 0) {
    await page.screenshot({ path: path.join(OUT, `personphotos-${TAG}-editor.png`) });
    console.log('no Photo button — the BEFORE state');
  } else {
    await adaPhoto.click();
    await page.waitForSelector('[data-testid="photopanel-ada"] .photopreview img');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `personphotos-${TAG}-editor.png`) });
    await page.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('button', { name: 'Photo for Linus' }).click();
    await page
      .locator('[data-testid="photopanel-linus"] input[type="file"]')
      .setInputFiles(photo('grace'));
    await page.waitForSelector('[data-testid="photopanel-linus"] .photopreview img');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `personphotos-${TAG}-pending.png`) });
    console.log('a chosen picture previews before it is saved');
  }
  await ctx.close();

  const narrowCtx = await browser.newContext({
    deviceScaleFactor: 3.75,
    hasTouch: true,
    isMobile: true,
    viewport: { height: 824, width: 384 },
  });
  await narrowCtx.addInitScript(darkInit);
  const narrow = await narrowCtx.newPage();
  await narrow.goto(`${server.base}/people`, { waitUntil: 'domcontentloaded' });
  await narrow.waitForSelector('#people', { timeout: 60_000 });
  await narrow.getByRole('button', { name: 'Edit people' }).click();
  await narrow.waitForSelector('#peoplemodal', { timeout: 15_000 });
  const narrowPhoto = narrow.getByRole('button', { name: 'Photo for Ada' });
  if ((await narrowPhoto.count()) > 0) {
    await narrowPhoto.click();
    await narrow.waitForSelector('[data-testid="photopanel-ada"] .photopreview img');
  }
  await narrow.waitForTimeout(800);
  await narrow.screenshot({ path: path.join(OUT, `personphotos-${TAG}-narrow.png`) });
  const overflow = await narrow.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(
    overflow > 1
      ? `⚠️ the Narrow View scrolls horizontally by ${overflow}px`
      : 'the Narrow View does not scroll horizontally',
  );
  await narrowCtx.close();
} finally {
  await browser.close();
  killServer(server.child);
  await fs.rm(server.dir, { force: true, recursive: true });
}
