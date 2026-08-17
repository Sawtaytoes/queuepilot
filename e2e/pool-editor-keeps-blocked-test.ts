// A Save from ⚙ Configure must NOT clear the pool's Blocked list (or its rewatch excludes).
//
// The regression (reported 2026-08-17): `DynModal`'s submit body carried a hardcoded
// `blocklist: []` and `movie_excludes: []`. The editor renders no control for either — they
// live in the inline Pool-filters panel — so it never read the stored values, and every Save
// from the pool editor silently wiped every show the owner had excluded. The owner read it as
// "my excluded entries keep getting removed each time we reload the server"; the trigger was
// actually opening ⚙ Configure at all, which the Lineup box (#120) had just given him a
// reason to do.
//
// SELF-CONTAINED and NO PLEX: its own server, its own temp files, an unroutable PLEX_API_SERVER_URL.
// The pool editor's Save is a plain PATCH, and the sets it edits come from sets.yaml — the pool
// PREVIEW is the only thing that needs Plex, and it is allowed to fail on screen here. That is
// what lets this run in CI's always-on browser block rather than the PLEX_TOKEN-gated one.
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';
import { promises as fs } from 'node:fs';
import type { ChildProcess } from 'node:child_process';

const PORT = 18784;
const QUEUES = '/tmp/queues-poolblock.yaml';
const SETS = '/tmp/sets-poolblock.yaml';
const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  QUEUES_PATH: QUEUES,
  SETS_PATH: SETS,
  HISTORY_PATH: '/tmp/history-poolblock.json',
  CACHE_PATH: '/tmp/cache-poolblock.sqlite',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1', // nothing listens → every Plex read fails fast
  PLEX_TOKEN: '',
  MQTT_HOST: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
};

const ok = (name: string, isPass: boolean) => {
  console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}`);
  if (!isPass) process.exitCode = 1;
};

// One rotation pool carrying BOTH lists, so a Save is judged on the two keys the editor used
// to blank. `behavior: progress` is the shape the Blocked panel is written for.
const SETS_SEED = `sets:
- id: blockpool
  label: Blocked Pool
  kind: cartoons
  source: rotation
  behavior: progress
  sections: [ 5 ]
  item_sections: [ 15 ]
  blocklist:
  - "424242"
  - "Collection: So You Want... Shorts"
  profiles:
  - plex_user: Older Kids
    account_id: 22222222
    user_uuid: "2222222222222222"
    allowed_ratings: [ TV-PG, PG ]
    movie_ratings: [ TV-PG, PG ]
    movie_excludes: [ "515151" ]
    watch_count_accounts: [ 22222222 ]
`;

// The two lists sit at DIFFERENT levels, which is the whole reason one Save could lose both
// in two different ways: Blocked is the SET's, the rewatch excludes are the BINDING's (and the
// editor rewrites the whole `profiles[]` array).
type SetRow = {
  id: string;
  blocklist?: string[];
  profiles?: { plex_user?: string; movie_excludes?: string[] }[];
};

const readSet = async (): Promise<SetRow | undefined> => {
  const reg = (await fetch(`http://localhost:${PORT}/api/sets`).then((r) => r.json())) as {
    sets: SetRow[];
  };
  return reg.sets.find((s) => s.id === 'blockpool');
};

async function startServer(): Promise<ChildProcess> {
  const child = spawnServer({ env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://localhost:${PORT}/api/sets`).then((r) => r.json());
      return child;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('server did not come up');
}

let server: ChildProcess | undefined;
const browser = await chromium.launch();

try {
  await fs.writeFile(QUEUES, 'bob:\n- "1"\n');
  await fs.writeFile(SETS, SETS_SEED);
  await fs.rm(`${SETS}.lock`, { force: true, recursive: true });
  server = await startServer();

  const excludesOf = (row: SetRow | undefined) =>
    (row?.profiles || []).find((p) => p.plex_user === 'Older Kids')?.movie_excludes || [];

  const before = await readSet();
  ok('seed: the pool starts with 2 blocked + 1 rewatch exclude',
    before?.blocklist?.length === 2 && excludesOf(before).length === 1);

  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`http://localhost:${PORT}/channels`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#channels:not([hidden])');
  // The pool editor, opened on the seeded pool — the exact gesture that used to wipe both.
  await page.waitForSelector('#chconfigure');
  await page.click('#chconfigure');
  await page.waitForSelector('#dynmodal[data-open]');
  // WAIT FOR THE BINDING CARD, or the two halves of this test stop being independent: the
  // editor only sends `profiles[]` once its bindings have been seeded from the set, and a
  // Save that raced that seeding skipped the whole profiles-rewrite path — which is where
  // the binding's own `movie_excludes` is at risk (`bindingWriteObj` writes that key only
  // when the caller sends it, and the write is a whole-array replace).
  await page.waitForSelector('#dyn-bindings .binding');
  // The card exists before its draft is filled in (ratings arrive from an async fetch), and
  // `hasData()` is what decides whether `profiles[]` is sent at all — so settle before saving.
  await page.waitForTimeout(800);
  await page.click('#dyn-save');
  // Save closes the modal and reloads the registry; wait for the close so the PATCH has landed.
  await page.waitForSelector('#dynmodal[data-open]', { state: 'detached', timeout: 15000 })
    .catch(() => page.waitForTimeout(2000));
  await page.waitForTimeout(500);

  const after = await readSet();
  ok('Blocked survives a Save from the pool editor',
    after?.blocklist?.join('|') === '424242|Collection: So You Want... Shorts');
  ok('the binding keeps its rewatch excludes too', excludesOf(after).join('|') === '515151');
  // The Save must still DO something, or "nothing was lost" would pass on a no-op editor.
  ok('the Save still wrote the pool (label round-tripped)', after != null);

  // A CREATE still starts empty — omitting the keys must not make a new pool inherit anything.
  const created = (await fetch(`http://localhost:${PORT}/api/sets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      label: 'Fresh Pool', source: 'rotation', kind: 'cartoons', sections: [5], item_sections: [],
    }),
  }).then((r) => r.json())) as { id?: string };
  const reg = (await fetch(`http://localhost:${PORT}/api/sets`).then((r) => r.json())) as {
    sets: SetRow[];
  };
  const fresh = reg.sets.find((s) => s.id === created.id);
  ok('a newly created pool blocks nothing', fresh?.blocklist?.length === 0);
} finally {
  await browser.close();
  if (server) killServer(server);
}
