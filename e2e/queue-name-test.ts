// A QUEUE'S NAME IS OPTIONAL — the server half, over a running app.
//
// A queue used to need a name because its immutable id was slugged from one. The id is a WIRE
// ID an NFC card carries, so it still has to come from somewhere; the ACTIVITY is the seed
// now, which is also what the queue is CALLED on screen
// (decision 2026-08-26-a-queue-name-is-optional-and-the-activity-fills-in).
//
// Five things it pins, and each one is a way this could regress into a silently wrong file:
//
//   1. **A named create still writes `label:` and still slugs the id from the name.** Nothing
//      about the common path moved.
//   2. **A NAMELESS create is accepted**, writes NO `label:` line, and slugs its id from the
//      activity — `movies_shows`, then `movies_shows_2`.
//   3. **`has_explicit_label` tells the two apart.** `label` cannot: the registry makes it
//      printable by falling back to the id, which is exactly why the browser would otherwise
//      print a slug on the card.
//   4. **CLEARING a name is an edit, not a refusal.** `PATCH {label: ""}` deletes the line.
//   5. **A rotation pool behaves identically.** It is as much a `watching` thing as a curated
//      queue is, and its create path is a different function that had the same `String(label)`
//      in it.
//
// Plex is unreachable on purpose (a closed port), so nothing here talks to the household.
//
// Run:  server/node_modules/.bin/tsx e2e/queue-name-test.ts   (repo root; non-zero on failure)
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { killServer, spawnServer } from './stubs/server-process.mjs';

let failures = 0;
const ok = (name: string, condition: boolean, extra = ''): void => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!condition) failures += 1;
};
const same = (name: string, actual: unknown, expected: unknown): void =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);

const SETS = `sets:
- id: named
  label: Manga & Webtoons
  kind: picks
  source: queue
  sections: [1]
`;

const PORT = 18812;
const base = `http://localhost:${PORT}`;

const get = async <T>(url: string): Promise<T> => (await (await fetch(base + url)).json()) as T;

const send = async (
  method: string,
  url: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(base + url, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method,
  });
  return { body: (await res.json()) as Record<string, unknown>, status: res.status };
};

interface Registry {
  sets: { id: string; label: string; has_explicit_label: boolean; activity: string }[];
}
const setById = async (id: string) => (await get<Registry>('/api/sets')).sets.find((s) => s.id === id);

const dir = await fs.mkdtemp(path.join(tmpdir(), 'qp-queue-name-'));
const SETS_PATH = path.join(dir, 'sets.yaml');
await fs.writeFile(SETS_PATH, SETS);
await fs.writeFile(path.join(dir, 'queues.yaml'), 'named: []\n');
await fs.writeFile(path.join(dir, 'groups.yaml'), 'groups: []\n');
await fs.writeFile(path.join(dir, 'pending.yaml'), 'seen_through: 0\n');

const child: ChildProcess = spawnServer({
  env: {
    ...process.env,
    CACHE_PATH: path.join(dir, 'cache.sqlite'),
    GROUPS_PATH: path.join(dir, 'groups.yaml'),
    HISTORY_PATH: path.join(dir, '.history.json'),
    MQTT_HOST: '',
    MQTT_PASS: '',
    MQTT_PORT: '',
    MQTT_USER: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    PENDING_PATH: path.join(dir, 'pending.yaml'),
    PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
    PLEX_TOKEN: '',
    QUEUES_PATH: path.join(dir, 'queues.yaml'),
    SETS_PATH,
    WEB_PORT: String(PORT),
  },
  stdio: 'ignore',
});

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await fetch(`${base}/api/history`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  // ── 1. the named queue that was already there ───────────────────────────────────────── //

  const named = await setById('named');
  same('a stored name reads back verbatim', named?.label, 'Manga & Webtoons');
  ok('…and is reported as EXPLICIT', named?.has_explicit_label === true);

  // ── 2. a NAMELESS create ────────────────────────────────────────────────────────────── //

  const first = await send('POST', '/api/sets', {
    activity: 'watching',
    kind: 'picks',
    sections: [1],
    source: 'queue',
  });
  ok('a create with no name is accepted', first.status === 200, `status ${first.status}`);
  same('…and its id is slugged from the ACTIVITY', first.body.id, 'movies_shows');

  const madeFirst = await setById('movies_shows');
  ok('…and it is reported as having NO explicit label', madeFirst?.has_explicit_label === false);
  same(
    '…while `label` stays printable by falling back to the id',
    madeFirst?.label,
    'movies_shows',
  );
  ok(
    '…and NO `label:` line was written to sets.yaml',
    !/\n\s+label:.*\n(?:.*\n)*?\s+id: movies_shows/.test(await fs.readFile(SETS_PATH, 'utf8')) &&
      !(await fs.readFile(SETS_PATH, 'utf8')).includes('label: movies_shows'),
  );

  const second = await send('POST', '/api/sets', {
    activity: 'watching',
    kind: 'picks',
    sections: [1],
    source: 'queue',
  });
  same('a second nameless queue is NUMBERED, never a collision', second.body.id, 'movies_shows_2');

  const reading = await send('POST', '/api/sets', {
    activity: 'reading',
    kind: 'picks',
    source: 'queue',
  });
  same('…and a different activity gets its own seed', reading.body.id, 'reading');

  // ── 3. clearing a name ──────────────────────────────────────────────────────────────── //

  const cleared = await send('PATCH', '/api/sets/named', { label: '' });
  ok('clearing a name is accepted, not refused', cleared.status === 200, `status ${cleared.status}`);

  const afterClear = await setById('named');
  ok('…and the queue now reports NO explicit label', afterClear?.has_explicit_label === false);
  same('…with `label` back to the id', afterClear?.label, 'named');
  ok(
    '…and the `label:` line is GONE from the file, not blanked',
    !(await fs.readFile(SETS_PATH, 'utf8')).includes('Manga & Webtoons'),
  );

  // Re-naming it works the same way round.
  await send('PATCH', '/api/sets/named', { label: 'Manga & Webtoons' });
  const renamed = await setById('named');
  same('a name can be typed back on', renamed?.label, 'Manga & Webtoons');
  ok('…and reads as explicit again', renamed?.has_explicit_label === true);

  // ── 4. the WIRE ID never moved ──────────────────────────────────────────────────────── //

  ok(
    'the id survived being named, cleared and named again',
    (await setById('named'))?.id === 'named',
  );

  // ── 5. a ROTATION pool behaves identically ──────────────────────────────────────────── //

  const pool = await send('POST', '/api/sets', {
    activity: 'watching',
    item_sections: [15],
    kind: 'rules',
    sections: [15],
    source: 'rotation',
  });
  ok('a nameless RULES pool is accepted too', pool.status === 200, `status ${pool.status}`);
  const madePool = await setById(String(pool.body.id));
  ok('…and reports no explicit label', madePool?.has_explicit_label === false);
} finally {
  killServer(child);
  await fs.rm(dir, { force: true, recursive: true });
}

console.log(failures ? `\n${failures} queue-name check(s) failed` : '\nall queue-name checks passed');
process.exit(failures ? 1 : 0);
