// Before/after for "the people filter answers in two tiers" and "the filter bar is quick picks
// plus a dropdown".
//
// Five frames, and each one is a claim the PR makes:
//
//   1. `bar`        `/queues` unfiltered at 1500px. On main the header is THREE rows — two of
//                   wrapped people chips and a third holding the provider pills. On the branch
//                   it is one: Anyone, four quick picks, `+N more`, Edit people, and the
//                   provider pills hugging the right edge.
//   2. `partner`    `/queues?people=sven`. Sven is on four queues and has none of her own, so
//                   on main this is one card and her chip reads `1` — the owner's "very
//                   strange" report. On the branch it is one exact match, a rule, and the four
//                   queues she is on, which also want Ada.
//   3. `twokids`    `/queues?people=grace,linus`. The "Halloween" shape: a queue that names
//                   exactly those two is an EXACT match, and the family queue that also wants
//                   the adults is under the rule.
//   4. `deadend`    `/queues?people=omar` with the `+N more` panel open. Omar and Priya share
//                   no queue, so Priya's row is DISABLED and the chips of everybody else he
//                   shares nothing with are gone.
//   5. `narrow`     the bar at 390px. It must wrap, not pan.
//
// **Fixture data, never live.** The cast is the landing fixture's Ada, Grace and Linus plus
// the six extended people this file invents — Sven, Hedy, Alan, Nadia, Omar and Priya
// (AGENTS.md, "A fixture is invented, never captured"). The nine exist because the defect
// being fixed is a filter that does not scale, and three people cannot show that.
//
// The trays are written over the API rather than seeded from group claims, because what the
// frames have to show is a SHAPE the group claims cannot express: one adult with queues of
// her own, a partner with none, and a queue that names two specific children and nobody else.
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers-queuepilot \
//     server/node_modules/.bin/tsx e2e/shot-queue-filter.ts --tag=before
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18797;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';
const API = `http://localhost:${PORT}/api`;

const env = {
  ...process.env,
  CACHE_PATH: '/tmp/cache-shotqueuefilter.sqlite',
  GROUPS_PATH: '/tmp/groups-shotqueuefilter.yaml',
  HISTORY_PATH: '/tmp/history-shotqueuefilter.json',
  // TWO providers, so the provider pills render at all — the bar hides them when only one
  // backend is reachable, and half of this PR is about where those pills sit. Neither host
  // resolves; the registry only needs the definition to exist.
  KAVITA_API_KEY: 'fixture',
  KAVITA_API_SERVER_URL: 'http://127.0.0.1:2',
  // The shell in this workspace carries real MQTT_* values, and a harness that does not blank
  // them dials the household broker and retries forever.
  MQTT_HOST: '',
  MQTT_PASS: '',
  MQTT_PORT: '',
  MQTT_USER: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  QUEUES_PATH: '/tmp/queues-shotqueuefilter.yaml',
  SETS_PATH: '/tmp/sets-shotqueuefilter.yaml',
  WEB_PORT: String(PORT),
};

for (const [src, dest] of [
  ['e2e/fixtures/landing.sets.yaml', env.SETS_PATH],
  ['e2e/fixtures/landing.queues.yaml', env.QUEUES_PATH],
  ['e2e/fixtures/landing.groups.yaml', env.GROUPS_PATH],
  // The proposal filename, not a confirmed one — the importer looks for exactly this.
  ['e2e/fixtures/landing.people-mapping.yaml', '/tmp/people-mapping-proposal.yaml'],
] as const) {
  await fs.copyFile(src, dest);
  await fs.rm(`${dest}.lock`, { force: true, recursive: true });
}
for (const stale of [
  '/tmp/queues-shotqueuefilter.queuepilot.sqlite',
  '/tmp/cache-shotqueuefilter.sqlite',
]) {
  await fs.rm(stale, { force: true });
}

await fs.mkdir('__screenshots__', { recursive: true });

/** The six people the landing fixture does not carry. INVENTED, never captured. */
const EXTENDED_CAST = ['Sven', 'Hedy', 'Alan', 'Nadia', 'Omar', 'Priya'];

const send = async (method: string, path: string, body: unknown) =>
  fetch(API + path, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method,
  }).then((r) => r.json() as Promise<Record<string, unknown>>);

let server: ChildProcess | undefined;
const browser = await chromium.launch();

const darkInit = () => {
  try {
    localStorage.setItem('charcuterie-scheme', 'dark');
  } catch {
    /* private mode — the shot is light then, and says so */
  }
};

try {
  server = spawnServer({ env, stdio: 'ignore' });

  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`${API}/sets`).then((r) => r.json());
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // ── the household ──────────────────────────────────────────────────────────────────── //

  for (const displayName of EXTENDED_CAST) await send('POST', '/people', { displayName });

  const roster = (await fetch(`${API}/people`).then((r) => r.json())) as {
    people: { displayName: string; id: string }[];
  };
  const idOf = new Map(roster.people.map((p) => [p.displayName, p.id]));
  /**
   * THROWS on a name the roster does not carry, rather than writing an `undefined` id.
   *
   * `PUT /sets/:id/people` would take that member and file the queue against a person who
   * does not exist, and the frames would come out looking almost right — one queue quietly
   * missing from one tier, which is precisely the kind of difference these shots exist to
   * make visible.
   */
  const member = (role: 'optional' | 'required') =>
    (...names: string[]) =>
      names.map((name) => {
        const id = idOf.get(name);
        if (!id) throw new Error(`no person called '${name}' — the fixture cast changed`);
        return { id, kind: 'person', role };
      });
  const req = member('required');
  const opt = member('optional');

  // Ada has queues of her own; Sven has NONE, and every queue she is on also wants Ada. That
  // asymmetry is the whole defect, so it is the fixture's whole point.
  const TRAYS: Record<string, { id: string; kind: string; role: string }[]> = {
    bob: req('Ada'),
    bob_alice: req('Ada', 'Sven'),
    bob_alice_anime: req('Ada', 'Sven'),
    bob_anime: req('Ada'),
    bob_carol_anime: [...req('Ada'), ...opt('Sven')],
    bob_dave: req('Ada', 'Omar'),
    bob_docs: req('Ada'),
    bob_erin: req('Ada', 'Priya'),
    bob_reading: req('Ada'),
    demo_reel: req('Ada'),
    family: [...req('Ada', 'Sven'), ...opt('Grace', 'Linus', 'Hedy', 'Alan', 'Nadia')],
    // The "Halloween" shape: two specific children, nobody else required.
    family_anime: req('Grace', 'Linus'),
    movies: [...req('Alan'), ...opt('Priya')],
    movies_rewatch: [...req('Hedy', 'Alan'), ...opt('Nadia')],
    older: [...req('Grace'), ...opt('Hedy')],
    shorts: [...req('Nadia'), ...opt('Omar')],
    younger: [...req('Linus'), ...opt('Nadia')],
  };

  for (const [setId, members] of Object.entries(TRAYS)) {
    const result = await send('PUT', `/sets/${setId}/people`, { members });
    if (!result.ok) console.log(`⚠️ ${setId}: ${String(result.error)}`);
  }

  // ── the frames ─────────────────────────────────────────────────────────────────────── //

  const ctx = await browser.newContext({ viewport: { height: 1100, width: 1500 } });
  await ctx.addInitScript(darkInit);
  const page = await ctx.newPage();

  const shelves = () => page.$$eval('#shelves > *', (nodes) => nodes.length);
  const open = async (query: string) => {
    await page.goto(`http://localhost:${PORT}/queues${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#peoplechips', { timeout: 30000 });
    await page.waitForTimeout(1800);
  };

  await open('');
  await page.screenshot({ path: `__screenshots__/queuefilter-${TAG}-bar.png` });
  const barRows = await page.evaluate(() => {
    const bar = document.querySelector('.filterbar');
    if (!bar) return 0;
    const tops = new Set<number>();
    for (const chip of bar.querySelectorAll('.filterchip, button'))
      tops.add(Math.round(chip.getBoundingClientRect().top));
    return tops.size;
  });
  console.log(`the bar is ${barRows} row(s) tall at 1500px with nine people`);

  await open('?people=sven');
  await page.screenshot({ path: `__screenshots__/queuefilter-${TAG}-partner.png` });
  const divider = await page.$('.alsodivide');
  console.log(
    divider
      ? `?people=sven — ${await shelves()} rows, and a rule: "${(await divider.innerText()).trim()}"`
      : `?people=sven — ${await shelves()} shelves and NO rule, the BEFORE state`,
  );

  await open('?people=grace,linus');
  await page.screenshot({ path: `__screenshots__/queuefilter-${TAG}-twokids.png` });

  await open('?people=omar');
  const more = await page.$('#peoplemore');
  if (more) {
    await more.click();
    await page.waitForSelector('[role="option"]', { timeout: 10000 });
    await page.waitForTimeout(600);
    const rows = await page.$$eval('[role="option"]', (nodes) =>
      nodes.map((n) => `${n.textContent?.replace('✓', '').trim()}${(n as HTMLButtonElement).disabled ? ' [disabled]' : ''}`),
    );
    console.log(`?people=omar — the +N more panel: ${rows.join(', ')}`);
  } else {
    console.log('?people=omar — there is no +N more control, the BEFORE state');
  }
  await page.screenshot({ path: `__screenshots__/queuefilter-${TAG}-deadend.png` });
  await ctx.close();

  // ── the Narrow View ────────────────────────────────────────────────────────────────── //
  //
  // NARROW VIEW, named for the WIDTH. `isMobile` is Playwright's own name and is kept as-is —
  // third-party API surface is not renamed to match the house vocabulary — and it is what
  // makes Chromium honour the viewport meta and widen the LAYOUT viewport on overflow, which
  // a bare 390px `viewport` does not.
  const narrowCtx = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { height: 844, width: 390 },
  });
  await narrowCtx.addInitScript(darkInit);
  const narrow = await narrowCtx.newPage();
  await narrow.goto(`http://localhost:${PORT}/queues?people=grace`, {
    waitUntil: 'domcontentloaded',
  });
  await narrow.waitForSelector('#peoplechips', { timeout: 30000 });
  await narrow.waitForTimeout(1500);
  await narrow.screenshot({ path: `__screenshots__/queuefilter-${TAG}-narrow.png` });

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
  killServer(server);
}
