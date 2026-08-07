// Drive a `SelectListbox` the way suites used to drive a native <select>.
//
// The app has no native <select> any more (2026-08-07-plex-channels-pickers-are-listbox-
// not-native-select): each picker is a Charcuterie `Listbox` behind a `Button` trigger.
// The trigger keeps the old id (as `data-testid`) and class, and every option's label
// carries `data-value`, so value-based picking still works — we click the trigger open and
// click the option instead of calling `selectOption`.

const esc = (v) => String(v).replace(/["\\]/g, '\\$&');

// A "target" is either a selector string or an already-resolved element handle/locator.
async function clickTarget(page, target, opts) {
  if (typeof target === 'string') await page.click(target, opts);
  else await target.click(opts);
}

async function waitOptions(page) {
  await page.waitForSelector('[role="listbox"] [role="option"]');
}

// Close by RE-CLICKING the trigger, never Escape: inside a native <dialog> (the app's
// modals) Escape closes the dialog itself, not just the portalled listbox.
async function closeVia(page, target) {
  await clickTarget(page, target);
  await page.waitForSelector('[role="listbox"]', { state: 'detached' }).catch(() => {});
}

/** Open `target` and choose the option whose value is `value`. */
export async function pickValue(page, target, value, { timeout = 15000 } = {}) {
  await clickTarget(page, target, { timeout });
  await waitOptions(page);
  await page.click(`[role="listbox"] [role="option"] [data-value="${esc(value)}"]`, { timeout });
}

/** Best-effort pick: choose `value` if that option exists, else close and move on. Replaces
 * the old `selectOption(sel, v).catch(() => {})` spots (a value only present in some states). */
export async function pickValueMaybe(page, target, value) {
  try {
    await pickValue(page, target, value, { timeout: 3000 });
  } catch {
    await closeVia(page, target);
  }
}

/** Same as `pickValue`, kept as a named export for the multi-control (handle) call sites. */
export async function pickHandle(page, triggerHandle, value) {
  await pickValue(page, triggerHandle, value);
}

/** Open `target` and choose the option at `index` (for lists picked positionally). */
export async function pickIndex(page, target, index) {
  await clickTarget(page, target);
  await waitOptions(page);
  await page.locator('[role="listbox"] [role="option"]').nth(index).click();
}

/** Open `target`, read the option LABELS (the selected one's ✓ stripped), close. */
export async function readOptions(page, target) {
  await clickTarget(page, target);
  await waitOptions(page);
  const labels = await page.$$eval('[role="listbox"] [role="option"]',
    (os) => os.map((o) => o.textContent.replace('✓', '').trim()));
  await closeVia(page, target);
  return labels;
}

/** Open `target`, read each option's VALUE (the `data-value`), close. */
export async function readOptionValues(page, target) {
  await clickTarget(page, target);
  await waitOptions(page);
  const values = await page.$$eval('[role="listbox"] [role="option"] [data-value]',
    (els) => els.map((e) => e.getAttribute('data-value')));
  await closeVia(page, target);
  return values;
}

/** Open `target`, read `[label, value]` pairs, close. */
export async function readOptionPairs(page, target) {
  await clickTarget(page, target);
  await waitOptions(page);
  const pairs = await page.$$eval('[role="listbox"] [role="option"]',
    (os) => os.map((o) => [o.textContent.replace('✓', '').trim(), o.querySelector('[data-value]')?.getAttribute('data-value')]));
  await closeVia(page, target);
  return pairs;
}

/** Open `target`, return the currently-selected option's VALUE (or null), close. The
 * replacement for reading a native `<select>`'s `.value` — options only exist while the
 * listbox is open, so this opens, reads `aria-selected`, and closes. */
export async function currentValue(page, target) {
  await clickTarget(page, target);
  await waitOptions(page);
  const value = await page.$eval('[role="listbox"] [role="option"][aria-selected="true"] [data-value]',
    (e) => e.getAttribute('data-value')).catch(() => null);
  await closeVia(page, target);
  return value;
}

/** Same as `readOptionValues`, from an already-resolved trigger handle (one of several
 * identical controls). */
export async function readOptionValuesFromHandle(page, triggerHandle) {
  return readOptionValues(page, triggerHandle);
}
