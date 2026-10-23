import path from 'node:path';

import { expectNoHorizontalOverflow } from '@charcuterie/playwright-config/responsive.js';
import { expect, type Page, test } from '@playwright/test';

import { REPO_ROOT } from '../stubs/server-process.mjs';
import { smokeServers } from './ports.js';

// A person's photo, set and removed through the people editor, in each of the fleet's four
// windows (decision 2026-10-22-a-person-photo-is-a-row-in-the-book-of-record).
//
// It runs against its OWN server (`smokeServers.photos`), because it writes and the route specs
// read the landing server in parallel. Each window adds its own person from the EXTENDED cast,
// so the four projects never touch the same row. The "photos" are the invented drawings in
// `e2e/fixtures/photos/` — never a real photograph.

const PERSON_FOR_WINDOW: Record<string, string> = {
  'chromium-narrow': 'Sven',
  'chromium-tall': 'Hedy',
  'chromium-ultrawide': 'Nadia',
  'chromium-wide': 'Alan',
};

const photo = (name: string) => path.join(REPO_ROOT, 'e2e', 'fixtures', 'photos', `${name}.jpg`);

/** True when the person's face in the editor row draws a decoded photo. */
const faceHasPhoto = (page: Page, id: string) =>
  page
    .locator(`#peoplename-${id}`)
    .locator('xpath=ancestor::li[1]')
    .locator('[data-person-face] img')
    .evaluateAll((images) =>
      images.some((image) => (image as HTMLImageElement).naturalWidth > 0),
    );

test('a person photo is chosen, previewed, saved, pasted and removed', async ({
  page,
  request,
}, testInfo) => {
  const name = PERSON_FOR_WINDOW[testInfo.project.name] ?? `Priya ${testInfo.project.name}`;
  const base = smokeServers.photos;

  const created = await request.post(`${base}/api/people`, { data: { displayName: name } });
  expect(created.status()).toBe(201);
  const { person } = (await created.json()) as { person: { id: string } };
  const id = person.id;

  try {
    await page.goto(`${base}/people`);
    await page.locator('#people').waitFor();
    await page.getByRole('button', { name: 'Edit people' }).click();
    await page.locator('#peoplemodal').waitFor();
    await expect(page.locator(`#peoplename-${id}`)).toBeVisible();
    expect(await faceHasPhoto(page, id)).toBe(false);

    // ── choose → preview → save ────────────────────────────────────────────────────────
    await page.getByRole('button', { name: `Photo for ${name}` }).click();
    const panel = page.getByTestId(`photopanel-${id}`);
    await expect(panel.getByText('No photo')).toBeVisible();
    await panel.locator('input[type="file"]').setInputFiles(photo('ada'));
    await expect(panel.getByRole('img', { name: /not saved yet/ })).toBeVisible();
    // Nothing is uploaded until Save.
    expect((await request.get(`${base}/api/people/${id}/photo`)).status()).toBe(404);
    await expectNoHorizontalOverflow(page);

    await panel.getByRole('button', { name: 'Save photo' }).click();
    await expect(panel.getByRole('img', { name: `Photo of ${name}` })).toBeVisible();
    await expect.poll(() => faceHasPhoto(page, id)).toBe(true);

    const served = await request.get(`${base}/api/people/${id}/photo`);
    expect(served.status()).toBe(200);
    expect(served.headers()['content-type']).toBe('image/webp');
    const avatar = await request.get(`${base}/api/native/people/${id}/avatar`);
    expect(avatar.headers()['etag']).toBe(served.headers()['etag']);

    // ── paste ───────────────────────────────────────────────────────────────────────────
    // An image on the clipboard lands in the same preview a picked file does.
    const pasted = (await import('node:fs')).readFileSync(photo('grace')).toString('base64');
    await page.evaluate((bytes) => {
      const binary = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([binary], 'pasted.jpg', { type: 'image/jpeg' }));
      document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data }));
    }, pasted);
    await expect(panel.getByRole('img', { name: /not saved yet/ })).toBeVisible();
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel.getByRole('img', { name: `Photo of ${name}` })).toBeVisible();

    // ── remove ──────────────────────────────────────────────────────────────────────────
    await panel.getByRole('button', { name: 'Remove photo' }).click();
    await expect(panel.getByText('No photo')).toBeVisible();
    await expect.poll(() => faceHasPhoto(page, id)).toBe(false);
    expect((await request.get(`${base}/api/people/${id}/photo`)).status()).toBe(404);
    await expectNoHorizontalOverflow(page);
  } finally {
    await request.delete(`${base}/api/people/${id}`);
  }
});
