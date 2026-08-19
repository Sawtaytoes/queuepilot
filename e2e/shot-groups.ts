// Before/after for QueuePilot Groups: the Play landing, and the in-app group editor.
//
// Runs against a server started the way e2e/run.sh starts one (real Plex, so the landing has
// the household's actual queues on it). `--tag=` names the output, so the same script shoots
// BEFORE on main and AFTER on the branch.
import { chromium } from './playwright.js';

const PORT = process.env.WEB_PORT || 18768;
const BASE = `http://localhost:${PORT}`;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.playcard', { timeout: 30000 });
// The group bar paints from `GET /api/groups`, one request after the landing itself.
await page.waitForTimeout(2500);
await page.screenshot({ path: `__screenshots__/groups-landing-${TAG}.png` });

// A group selected — the landing filters, and rows drop the group's own name.
const chip = await page.$('#groupchips li:nth-child(2) button, #groupchips li:nth-child(2) a');
if (chip) {
  await chip.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `__screenshots__/groups-filtered-${TAG}.png` });
}

// The editor (branch only — main has no such button, so this simply no-ops there).
const edit = await page.$('#groupsedit');
if (edit) {
  await edit.click();
  await page.waitForSelector('#groupsmodal[data-open]', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: `__screenshots__/groups-editor-${TAG}.png` });
}

await browser.close();
console.log(`shot: __screenshots__/groups-*-${TAG}.png`);
