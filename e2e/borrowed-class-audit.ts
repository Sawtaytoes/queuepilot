// BORROWED CLASS NAMES — a class an element wears that no rule for that class matches.
//
// The defect this reports is invisible to every other tool in the repo. `className="addto"`
// on a Pending tile type-checks, lints, builds and reads in review as "this control is
// styled" — and `.addto` is only ever written `.results .addto`, so on a page with no
// `.results` ancestor the control painted as bare text. The owner found it by looking at
// the screen: *"Dismiss isn't a button… the edition is directly next to the text without a
// space."* Biome cannot see it (a class name is a string), tsc cannot see it (CSS is not in
// the program), and axe cannot see it (unstyled markup is perfectly accessible).
//
// So this asks the browser, which is the only thing that knows. For every element on the
// page, for every class token it carries, it collects every selector in the loaded
// stylesheets that mentions `.token` and checks the element matches AT LEAST ONE of them.
// Matching none means the name is decoration.
//
// ## It REPORTS, it does not gate
//
// Deliberately not wired into CI. A state class is a legitimate no-match — `body.play-view`
// and `ul.editable` exist to be an ANCESTOR in someone else's selector and match nothing
// themselves — and separating those from real findings needs a human. Five real cases were
// open on other pages when this was written (2026-08-21); they are listed in
// `docs/decisions/2026-08-21-a-class-name-is-not-a-style.md` rather than fixed here, and a
// gate that starts red teaches people to ignore it.
//
// ## Coverage
//
// The routes and the four editors reachable from the synthetic fixtures. NOT covered:
// `#groupsmodal` (its only trigger lives in `GroupBar`, which renders nothing when the
// fixture declares no groups), `#startmodal`, and the Narrow View. A finding there needs a
// fixture that reaches it — absence of a finding here is not evidence of absence.
//
// Usage: `server/node_modules/.bin/tsx e2e/borrowed-class-audit.ts`
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.env.WEB_PORT || '18824', 10);
const BASE = `http://localhost:${PORT}`;

type Finding = {
  classes: string;
  cls: string;
  id: string | null;
  selectors: string[];
  tag: string;
};

type Report = {
  classesKnown: number;
  elements: number;
  findings: Finding[];
};

/**
 * Runs IN THE PAGE — as a SOURCE STRING, not as a function.
 *
 * That is not a style choice. tsx's esbuild runs with `keepNames`, so a named inner helper
 * (`const walkRules = …`) compiles to `__name(…, "walkRules")`, and `__name` does not exist
 * in the browser: `page.evaluate(AUDIT)` throws `ReferenceError: __name is not defined`.
 * `e2e/playwright.ts` carries the string overload for exactly this. The cost is that the
 * compiler checks none of the code below, which is why the self-test in `visit()` exists.
 *
 * Two traps are load-bearing here, both of which produced a confident and completely wrong
 * "zero findings" on the first attempt:
 *
 *  1. **CSS nesting.** Every `CSSStyleRule` in current Chrome carries its own `cssRules`
 *     list, and an EMPTY `CSSRuleList` is truthy. An `if (rule.cssRules) { recurse;
 *     continue }` therefore skips every style rule in the sheet and finds nothing at all —
 *     indistinguishable from a clean report. Read the selector first, recurse second.
 *  2. **State pseudo-classes.** `element.matches('.tile:hover')` is false for an element
 *     nobody is hovering, so a rule that only ever appears with `:hover` would flag its own
 *     element. They are stripped before the match; structural ones (`:not`, `:is`, `:has`)
 *     are kept, because those really do decide whether the rule applies.
 */
const AUDIT = `(() => {
  const strippablePseudo =
    /::?(hover|focus-visible|focus-within|focus|active|visited|first-child|last-child|only-child|empty|before|after|placeholder|checked|disabled|target|nth-child\\([^)]*\\)|nth-of-type\\([^)]*\\))/g

  const byClass = new Map()

  const walkRules = (rules, parent) => {
    for (const rule of Array.from(rules)) {
      let here = parent
      const selectorText = rule.selectorText

      if (selectorText) {
        here = []

        for (const part of selectorText.split(',')) {
          const selector = parent
            ? part.trim().replace(/&/g, ':is(' + parent.join(',') + ')')
            : part.trim()

          here.push(selector)

          for (const match of selector.matchAll(/\\.([A-Za-z0-9_-]+)/g)) {
            const name = match[1]
            if (name === undefined) continue
            const set = byClass.get(name) || new Set()
            set.add(selector)
            byClass.set(name, set)
          }
        }
      }

      const nested = rule.cssRules
      if (nested && nested.length > 0) walkRules(nested, here)
    }
  }

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walkRules(sheet.cssRules, null)
    } catch (e) {
      // A cross-origin sheet refuses cssRules. Nothing this app owns is one.
    }
  }

  const findings = []
  let elements = 0

  for (const element of Array.from(document.querySelectorAll('*'))) {
    elements += 1

    for (const cls of Array.from(element.classList)) {
      const selectors = byClass.get(cls)
      if (!selectors) continue

      let isMatched = false

      for (const selector of selectors) {
        const bare = selector.replace(strippablePseudo, '').trim()
        if (!bare) continue
        try {
          if (element.matches(bare)) { isMatched = true; break }
        } catch (e) {
          // An unparseable remnant. No opinion rather than a finding.
        }
      }

      if (!isMatched) {
        findings.push({
          classes: element.getAttribute('class') || '',
          cls: cls,
          id: element.id || null,
          selectors: Array.from(selectors),
          tag: element.tagName.toLowerCase(),
        })
      }
    }
  }

  return { classesKnown: byClass.size, elements: elements, findings: findings }
})()`

const waitReady = async (url: string, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`not ready: ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
};

await fs.copyFile(`${ROOT}/e2e/fixtures/queues.fixture.yaml`, '/tmp/queues-classaudit.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-classaudit.yaml');
for (const lock of ['/tmp/queues-classaudit.yaml.lock', '/tmp/sets-classaudit.yaml.lock']) {
  await fs.rm(lock, { force: true });
}

const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/.history-classaudit.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: '/tmp/queues-classaudit.yaml',
    SETS_PATH: '/tmp/sets-classaudit.yaml',
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

/** class + element identity, so one shared component is reported once and not per instance. */
const seen = new Map<string, Finding & { where: Set<string> }>();

try {
  await waitReady(`${BASE}/api/queues`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });

  const visit = async (route: string, open?: () => Promise<void>) => {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    if (open) {
      try {
        await open();
      } catch (e) {
        console.log(`  (${route}: could not open — ${(e as Error).message.split('\n')[0]})`);
      }
    }

    await page.waitForTimeout(600);

    // A self-test, because the failure mode of this harness is a SILENT zero (see the two
    // traps above). A probe wearing `.ptitle` with no `.pendingtile` ancestor must be
    // flagged, or the run is reporting its own breakage as cleanliness.
    await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'ptitle qp-audit-probe';
      document.body.appendChild(probe);
    });

    const report = (await page.evaluate(AUDIT)) as Report;
    const isProbeFlagged = report.findings.some((f) => f.classes.includes('qp-audit-probe'));

    await page.evaluate(() => {
      document.querySelector('.qp-audit-probe')?.remove();
    });

    if (!isProbeFlagged) throw new Error(`self-test failed on ${route} — the auditor is broken`);

    const real = report.findings.filter((f) => !f.classes.includes('qp-audit-probe'));

    for (const f of real) {
      const key = `${f.cls}|${f.tag}|${f.id ?? ''}|${f.classes}`;
      const row = seen.get(key) ?? { ...f, where: new Set<string>() };
      row.where.add(route);
      seen.set(key, row);
    }

    console.log(
      `${route.padEnd(16)} elements=${String(report.elements).padStart(5)}  classes=${report.classesKnown}  flagged=${real.length}`,
    );
  };

  await visit('/');
  await visit('/queues');
  await visit('/pending');
  await visit('/channels');
  await visit('/', async () => {
    await page.click('#playnewqueue');
    await page.waitForTimeout(900);
  });
  await visit('/queues', async () => {
    await page.click('#newqueue');
    await page.waitForTimeout(900);
  });
  await visit('/channels', async () => {
    await page.click('#newdyn');
    await page.waitForTimeout(1400);
  });

  const queueRoute = await page.evaluate(async () => {
    const registry = (await (await fetch('/api/sets')).json()) as {
      sets?: { id: string; source: string }[];
    };
    const queue = (registry.sets ?? []).find((s) => s.source === 'queue');
    return queue ? `/q/${queue.id}` : null;
  });

  if (queueRoute) {
    await visit(queueRoute);
    await visit(queueRoute, async () => {
      await page.click('.tile .thumb');
      await page.waitForTimeout(900);
    });
  }

  await browser.close();
} finally {
  killServer(srv);
}

const rows = Array.from(seen.values()).sort((a, b) => a.cls.localeCompare(b.cls));

console.log(`\n=== ${rows.length} class/element pairs match no rule for that class ===`);
console.log(
  'A state class on an ANCESTOR (body.play-view, ul.editable) is expected here and is not a\n' +
    'finding. Everything else is a class name doing nothing.\n',
);

for (const row of rows) {
  console.log(`.${row.cls}  <${row.tag}${row.id ? ` id="${row.id}"` : ''} class="${row.classes}">`);
  console.log(`    routes : ${Array.from(row.where).join(', ')}`);
  console.log(`    rules  : ${row.selectors.join(' | ')}`);
}

process.exit(0);
