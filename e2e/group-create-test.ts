// A queue created while a GROUP is on screen joins that group — and one created where no
// group is on screen still joins nothing.
//
// The owner, 2026-08-21, on a queue made from `/g/<id>` landing in `All` instead:
// *"It should join wherever I added it."*
//
// `groups-test.ts` pins the WRITE (`fileSetIntoGroup` appends to the stored `sets:`). It
// cannot pin the half that was actually broken: which group the browser NAMES when it POSTs.
// That answer is derived from the URL inside `SetModal`, so nothing short of a real browser
// on a real route can hold it — and the two failures that matter are opposite, so both are
// here. Filing nothing from `/g/bob` is the bug. Filing SOMETHING from `/queues`, where no
// group is on screen, would be a new one: it would sweep every queue made from the
// configurator into whichever group the device happened to look at last.
//
// SELF-CONTAINED and NO PLEX: its own server, its own temp files, an unroutable
// PLEX_API_SERVER_URL. Every assertion is a `GET /api/groups` read of groups.yaml plus what
// the landing grid renders, and neither needs a library. That is what lets this sit in CI's
// always-on browser block rather than the PLEX_TOKEN-gated one, which is skipped on every PR
// — the same reason `pool-editor-keeps-blocked-test` lives there.
//
//   server/node_modules/.bin/tsx e2e/group-create-test.ts
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18795;
const SETS = '/tmp/sets-groupcreate.yaml';
const GROUPS = '/tmp/groups-groupcreate.yaml';
const QUEUES = '/tmp/queues-groupcreate.yaml';

const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  SETS_PATH: SETS,
  GROUPS_PATH: GROUPS,
  QUEUES_PATH: QUEUES,
  HISTORY_PATH: '/tmp/history-groupcreate.json',
  CACHE_PATH: '/tmp/cache-groupcreate.sqlite',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1', // nothing listens → every Plex read fails fast
  PLEX_TOKEN: '',
  MQTT_HOST: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
};

const ok = (name: string, isPass: boolean) => {
  console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}`);
  if (!isPass) process.exitCode = 1;
};

// The repo's anonymized cast, not the household's. Two groups with DIFFERENT membership
// styles, because the answer differs for them in the data and must not differ in the UI:
// `Bob` names a set outright, `Kids` is accounts-only and names nothing at all.
const SETS_SEED = `sets:
- id: bob_anime
  label: Bob — Anime
  kind: anime
  source: queue
  requires_profile: sawtaytoes
  sections: [11]
- id: kid_shows
  label: Shows
  kind: cartoons
  source: rotation
  sections: [5]
  profiles:
  - plex_user: Younger Kids
    account_id: 11111111
`;

const GROUPS_SEED = `# hand-written header nobody should lose
groups:
- id: bob
  label: Bob
  accounts:
    plex: [sawtaytoes]
  sets: [bob_anime]
- id: kids
  label: Kids
  accounts:
    plex: [Younger Kids]
`;

type GroupRow = { id: string; label: string; sets: string[]; setIds: string[]; isAll?: boolean };
type GroupsPayload = { groups: GroupRow[]; unassigned: string[] };

const readGroups = async (): Promise<GroupsPayload> =>
  (await fetch(`http://localhost:${PORT}/api/groups`).then((r) => r.json())) as GroupsPayload;

const idsOf = async (): Promise<string[]> => {
  const reg = (await fetch(`http://localhost:${PORT}/api/sets`).then((r) => r.json())) as {
    sets: { id: string; label: string }[];
  };
  return reg.sets.map((s) => s.id);
};

await fs.writeFile(SETS, SETS_SEED, 'utf8');
await fs.writeFile(GROUPS, GROUPS_SEED, 'utf8');
await fs.writeFile(QUEUES, 'queues: {}\n', 'utf8');
for (const p of [SETS, GROUPS, QUEUES]) await fs.rm(`${p}.lock`, { force: true, recursive: true });

let server: ChildProcess | undefined;
const browser = await chromium.launch();

try {
  server = spawnServer({ env, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`http://localhost:${PORT}/api/sets`).then((r) => r.json());
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const page = await browser.newPage({ viewport: { width: 1420, height: 940 } });

  /** Drive the landing's create button to a saved set, and answer with its new id. */
  const createFrom = async (path: string, name: string, trigger: string) => {
    const before = new Set(await idsOf());
    await page.goto(`http://localhost:${PORT}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(trigger, { timeout: 30000 });
    await page.click(trigger);
    await page.waitForSelector('#setmodal', { timeout: 15000 });
    await page.waitForTimeout(500);
    const note = await page.$('#set-groupnote');
    const noteText = note ? ((await note.textContent()) ?? '') : '';
    await page.fill('#set-label', name);
    await page.click('#set-save');
    // The modal closes on a successful save; the POST has landed by then.
    await page
      .waitForSelector('#setmodal', { state: 'detached', timeout: 15000 })
      .catch(() => page.waitForTimeout(2500));
    await page.waitForTimeout(600);
    const made = (await idsOf()).find((id) => !before.has(id)) ?? '';
    return { id: made, noteText };
  };

  // 1. THE ASK. Created from `/g/bob`, so it is Bob's.
  const fromBob = await createFrom('/g/bob', 'Made From Bob', '#playnewqueue');
  ok('a queue created on a group page is created at all', Boolean(fromBob.id));

  const afterBob = await readGroups();
  const bob = afterBob.groups.find((g) => g.id === 'bob');
  ok('it is NAMED by that group (the stored sets:, the explicit half)',
    Boolean(fromBob.id) && bob?.sets.includes(fromBob.id) === true);
  ok('so it is in that group\'s resolved membership',
    Boolean(fromBob.id) && bob?.setIds.includes(fromBob.id) === true);
  ok('and it is no longer unfiled', !afterBob.unassigned.includes(fromBob.id));
  ok('no other group picked it up',
    afterBob.groups.filter((g) => !g.isAll && g.setIds.includes(fromBob.id)).length === 1);

  // 2. The modal SAID so, before the save. The owner should not have to find out afterwards.
  ok('the create modal names the group it will join', /Joins/.test(fromBob.noteText)
    && /Bob/.test(fromBob.noteText));

  // 3. It is on screen UNDER THAT FILTER, which is the thing that was actually reported.
  await page.goto(`http://localhost:${PORT}/g/bob`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.playcard', { timeout: 30000 });
  await page.waitForTimeout(800);
  const labelsInBob = await page.$$eval('.playcard', (cards) =>
    cards.map((c) => c.textContent ?? ''));
  ok('the new queue is visible on the group page it was made from',
    labelsInBob.some((t) => t.includes('Made From Bob')));

  // 4. An ACCOUNTS-ONLY group is a real destination too. `Kids` names no set ids at all; its
  //    membership is derived from `accounts:`. Filing still appends to `sets:`, and the
  //    settled rule (explicit beats derived) then keeps the queue there.
  const fromKids = await createFrom('/g/kids', 'Made From Kids', '#playnewqueue');
  const afterKids = await readGroups();
  const kids = afterKids.groups.find((g) => g.id === 'kids');
  ok('an accounts-only group takes a new queue by name',
    Boolean(fromKids.id) && kids?.sets.includes(fromKids.id) === true);
  ok('and it resolves into that group, not somewhere else',
    afterKids.groups.filter((g) => !g.isAll && g.setIds.includes(fromKids.id))
      .map((g) => g.id).join(',') === 'kids');

  // 5. `/g/all` is the ABSENCE of a filter, not a group. It must not be written to — it is
  //    synthesized and is in no file — and the modal must not claim a destination there.
  const fromAll = await createFrom('/g/all', 'Made From All', '#playnewqueue');
  const afterAll = await readGroups();
  ok('a queue created on the everything view is unfiled',
    afterAll.unassigned.includes(fromAll.id));
  ok('and the modal claims no destination there', fromAll.noteText === '');

  // 6. THE OTHER DIRECTION. `/queues` has no group on screen, so nothing is filed — the
  //    behaviour this change must leave exactly as it found it.
  const fromQueues = await createFrom('/queues', 'Made From Queues', '#newqueue');
  const afterQueues = await readGroups();
  ok('a queue created from the Ordered Queues toolbar is still unfiled',
    Boolean(fromQueues.id) && afterQueues.unassigned.includes(fromQueues.id));
  ok('and that modal shows no group line either', fromQueues.noteText === '');

  // 7. The file survives the write. This one is hand-edited over SMB as often as it is saved
  //    from the app, and an append that reserialises the document loses the header.
  const text = await fs.readFile(GROUPS, 'utf8');
  ok('the hand-written groups.yaml header survives the filing write',
    text.startsWith('# hand-written header nobody should lose'));

  await page.close();
} finally {
  await browser.close();
  if (server) killServer(server);
}
