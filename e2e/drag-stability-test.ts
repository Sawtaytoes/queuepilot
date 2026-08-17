// A DRAG MUST NOT REVERSE DIRECTION.
//
// Reported from the sofa, 2026-08-17: "dragging 'n dropping in this mode is super jank. It
// flashes them around the screen a bunch. Hard to even tell where I'm dragging to."
//
// The cause was a feedback loop, not a rendering hiccup. The dragged tile stays IN FLOW (that
// is deliberate: `2026-07-21-ui-interaction-states-standard` keeps the drag transform-only so
// scroll anchoring never reflows the page), so wherever it is placed every sibling after it
// shifts by one slot — which moves the very tiles the next decision is measured against.
// Insert at 2, the neighbours slide, the nearest tile is now a different one, insert back at
// 0, they slide back, forever.
//
// WHY THIS IS A GATE AND NOT A SCREENSHOT. Every symptom is in the TIME domain. A still frame
// of a janky drag and a smooth one are identical; so are the final order, the saved YAML and
// every assertion the existing drag suites make — `homedrag-test` and `ui-test` both passed
// throughout. What separates them is the PATH the tile took to get there, which is why this
// records the index over time and counts reversals.
//
// Measured on a two-row Cards drag before the fix: 0-2-0-2-0-2-0-2-3-2-3, twenty-five
// direction reversals in twenty-seven steps, 20 re-inserts and 148 style writes. After: three
// steps, zero reversals, 2 re-inserts, 16 style writes.
//
// Browser, but NO PLEX — it drives the degraded path, where tiles render unresolved but
// render. That matters: the Plex-gated suites are skipped on every PR, so a gate that lived
// there would never run.
//
// Run against a server on WEB_PORT:
//   WEB_PORT=18777 server/node_modules/.bin/tsx e2e/drag-stability-test.ts
import assert from 'node:assert/strict';
import { chromium } from './playwright.js';

const PORT = process.env.WEB_PORT || 18777;
const BASE = `http://localhost:${PORT}`;
// The queue the fixture always has, in the density the report came from.
const QUEUE = process.env.DRAG_QUEUE || 'bob';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

await page.goto(`${BASE}/q/${QUEUE}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#grid li.tile', { timeout: 30000 });
await page.waitForTimeout(1800);

const tileCount = Number(
  await page.evaluate(`document.querySelectorAll('#grid li.tile').length`),
);
assert.ok(tileCount >= 8, `need a few tiles to drag between, got ${tileCount}`);

// Count what the drag actually does to the DOM, so a regression that re-introduces the churn
// without reversing direction is still caught.
await page.evaluate(`(() => {
  window.__m = { style: 0, insert: 0 };
  const g = document.querySelector('#grid');
  new MutationObserver((rs) => { for (const r of rs) if (r.attributeName === 'style') window.__m.style++; })
    .observe(g, { attributes: true, subtree: true, attributeFilter: ['style'] });
  const orig = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function (...a) { if (this === g) window.__m.insert++; return orig.apply(this, a); };
})()`);

const start = JSON.parse(String(await page.evaluate(
  `(() => { const el = document.querySelector('#grid li.tile .thumb'); const r = el.getBoundingClientRect();`
  + ` return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]); })()`,
))) as number[];

await page.mouse.move(start[0]!, start[1]!);
await page.mouse.down();

// A slow, deliberate drag down and to the right — what a person does, and the motion that
// makes the loop worst because it crosses rows.
const seen: number[] = [];
for (let i = 1; i <= 50; i += 1) {
  await page.mouse.move(start[0]! + i * 5, start[1]! + i * 4);
  await page.waitForTimeout(16);
  seen.push(Number(await page.evaluate(
    `[...document.querySelectorAll('#grid li.tile')].findIndex((x) => x.classList.contains('dragging'))`,
  )));
}

const counts = JSON.parse(String(await page.evaluate(`JSON.stringify(window.__m)`)));
await page.mouse.up();
await page.waitForTimeout(500);

// Collapse runs: what matters is the SHAPE of the movement, not how many frames held a value.
const path = seen.filter((v, i) => i === 0 || v !== seen[i - 1]);
let reversals = 0;
for (let i = 2; i < path.length; i += 1) {
  const a = path[i - 2]!;
  const m = path[i - 1]!;
  const c = path[i]!;
  if ((m > a && c < m) || (m < a && c > m)) reversals += 1;
}

console.log(`  path: ${path.join(' ')}`);
console.log(`  re-inserts: ${counts.insert}, style writes: ${counts.style}`);

// ONE reversal is allowed: a drag really can cross a slot boundary and come back if the
// pointer wanders. A loop produces one on almost every step.
check(
  'the dragged tile does not ping-pong',
  reversals <= 1,
  `${reversals} direction reversals across ${Math.max(0, path.length - 2)} steps — path ${path.join(' ')}`,
);

// A 50-step drag across two rows passes a handful of slots. Twenty means it is thrashing even
// if it happens to end up monotonic.
check(
  're-inserts stay proportional to the distance travelled',
  counts.insert <= 8,
  `${counts.insert} re-inserts for one drag`,
);

check(
  'sibling restyling stays bounded',
  counts.style <= 60,
  `${counts.style} style writes for one drag`,
);

// The gesture still has to WORK — a drag that never moves anything would pass everything above.
check(
  'the drag actually moved the tile',
  path.length > 1 && path[path.length - 1] !== path[0],
  `tile never left its slot (path ${path.join(' ')})`,
);

await browser.close();
console.log(failed ? `\ndrag-stability: ${failed} check(s) failed` : '\ndrag stability OK');
process.exit(failed ? 1 : 0);
