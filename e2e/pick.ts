// Drive a `SelectListbox` the way suites used to drive a native <select>.
//
// The app has no native <select> any more (2026-08-07-plex-channels-pickers-are-listbox-
// not-native-select): each picker is a Charcuterie `Listbox` behind a `Button` trigger.
// The trigger keeps the old id (as `data-testid`) and class, and every option's label
// carries `data-value`, so value-based picking still works — we click the trigger open and
// click the option instead of calling `selectOption`.
import type { ClickOptions, ElementHandle, Locator, Page } from './playwright.js';

/**
 * A "target" is either a selector string or an already-resolved element handle/locator.
 * The handle form is what the multi-control call sites need (`verify-profile-bindings`
 * drives one of N identical `.b-profile` triggers), which is why this is a union rather
 * than "always a selector".
 */
export type PickTarget = string | ElementHandle | Locator;

const esc = (value: string): string => String(value).replace(/["\\]/g, '\\$&');

async function clickTarget(page: Page, target: PickTarget, opts?: ClickOptions): Promise<void> {
  if (typeof target === 'string') await page.click(target, opts);
  else await target.click(opts);
}

async function waitOptions(page: Page): Promise<void> {
  await page.waitForSelector('[role="listbox"] [role="option"]');
}

// Close by RE-CLICKING the trigger, never Escape: inside a native <dialog> (the app's
// modals) Escape closes the dialog itself, not just the portalled listbox.
async function closeVia(page: Page, target: PickTarget): Promise<void> {
  await clickTarget(page, target);
  await page.waitForSelector('[role="listbox"]', { state: 'detached' }).catch(() => null);
}

/** Open `target` and choose the option whose value is `value`. */
export async function pickValue(
  page: Page,
  target: PickTarget,
  value: string,
  { timeout = 15000 }: { timeout?: number } = {},
): Promise<void> {
  await clickTarget(page, target, { timeout });
  await waitOptions(page);
  await page.click(`[role="listbox"] [role="option"] [data-value="${esc(value)}"]`, { timeout });
}

/** Best-effort pick: choose `value` if that option exists, else close and move on. Replaces
 * the old `selectOption(sel, v).catch(() => {})` spots (a value only present in some states). */
export async function pickValueMaybe(page: Page, target: PickTarget, value: string): Promise<void> {
  try {
    await pickValue(page, target, value, { timeout: 3000 });
  } catch {
    await closeVia(page, target);
  }
}

/** Same as `pickValue`, kept as a named export for the multi-control (handle) call sites. */
export async function pickHandle(
  page: Page,
  triggerHandle: PickTarget,
  value: string,
): Promise<void> {
  await pickValue(page, triggerHandle, value);
}

/** Open `target` and choose the option at `index` (for lists picked positionally). */
export async function pickIndex(page: Page, target: PickTarget, index: number): Promise<void> {
  await clickTarget(page, target);
  await waitOptions(page);
  await page.locator('[role="listbox"] [role="option"]').nth(index).click();
}

/** Open `target`, read the option LABELS (the selected one's ✓ stripped), close. */
export async function readOptions(page: Page, target: PickTarget): Promise<string[]> {
  await clickTarget(page, target);
  await waitOptions(page);
  // `?? ''` and not `!`: `textContent` is `string | null` on every Element, and an option
  // that renders empty should read as "" here rather than crash the whole suite in the
  // browser — the assertion downstream is what should fail, and it will.
  const labels = await page.$$eval('[role="listbox"] [role="option"]',
    (os) => os.map((o) => (o.textContent ?? '').replace('✓', '').trim()));
  await closeVia(page, target);
  return labels;
}

/** Open `target`, read each option's VALUE (the `data-value`), close. */
export async function readOptionValues(page: Page, target: PickTarget): Promise<(string | null)[]> {
  await clickTarget(page, target);
  await waitOptions(page);
  const values = await page.$$eval('[role="listbox"] [role="option"] [data-value]',
    (els) => els.map((e) => e.getAttribute('data-value')));
  await closeVia(page, target);
  return values;
}

/** Open `target`, read `[label, value]` pairs, close. */
export async function readOptionPairs(
  page: Page,
  target: PickTarget,
): Promise<[string, string | null][]> {
  await clickTarget(page, target);
  await waitOptions(page);
  const pairs = await page.$$eval('[role="listbox"] [role="option"]',
    (os) => os.map((o): [string, string | null] => [
      (o.textContent ?? '').replace('✓', '').trim(),
      o.querySelector('[data-value]')?.getAttribute('data-value') ?? null,
    ]));
  await closeVia(page, target);
  return pairs;
}

/** Open `target`, return the currently-selected option's VALUE (or null), close. The
 * replacement for reading a native `<select>`'s `.value` — options only exist while the
 * listbox is open, so this opens, reads `aria-selected`, and closes. */
export async function currentValue(page: Page, target: PickTarget): Promise<string | null> {
  await clickTarget(page, target);
  await waitOptions(page);
  const value = await page.$eval('[role="listbox"] [role="option"][aria-selected="true"] [data-value]',
    (e) => e.getAttribute('data-value')).catch(() => null);
  await closeVia(page, target);
  return value;
}

/** Same as `readOptionValues`, from an already-resolved trigger handle (one of several
 * identical controls). */
export async function readOptionValuesFromHandle(
  page: Page,
  triggerHandle: PickTarget,
): Promise<(string | null)[]> {
  return readOptionValues(page, triggerHandle);
}
