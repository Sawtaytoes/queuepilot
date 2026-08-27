// THE ROSTER EDITOR GATE — add, rename and remove a person over a running app.
//
// Before this, the roster arrived only through the owner-confirmed mapping file in `/config`,
// so adding somebody meant editing YAML on the appliance and restarting. `PeopleModal` is the
// screen; these are the four rules underneath it, and each one is a thing somebody could undo
// without noticing:
//
//   1. **A wire id is generated once and never moves.** `queue_people` and `group_people` both
//      store a person id, and `PersonFace` hashes it into a hue — so a rename that moved the id
//      would silently empty a queue's tray AND repaint the person.
//   2. **A blank name is REFUSED, not stored.** `display_name` is NOT NULL with a `''` default,
//      so a blank one is a row that paints a "?" face nobody can identify on any screen.
//   3. **A delete takes the trays and rosters with it, and SAYS which.** Removing somebody
//      changes which queues come up, and that is invisible from the row being deleted.
//   4. **The mapping file is not touched.** It owns only the rows it names, which is what makes
//      a hand-added person safe beside it — and what stops the next restart re-importing over
//      an edit made in the app.
//
// Plex is unreachable on purpose (a closed port), so nothing here talks to the household.
//
// Run:  server/node_modules/.bin/tsx e2e/roster-editor-test.ts   (repo root; non-zero on failure)
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { killServer, spawnServer } from './stubs/server-process.mjs';

let failures = 0;
const ok = (name: string, condition: boolean, extra = ''): void => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!condition) failures += 1;
};
const same = (name: string, actual: unknown, expected: unknown): void =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);

const SETS = `sets:
- id: bob_movies
  label: Bob — Movies
  kind: picks
  source: queue
  sections: [1]
`;
const QUEUES = `bob_movies:
- {ratingKey: "1", title: "A Movie (2001)"}
`;
const GROUPS = `groups:
- id: kids
  label: Kids
  accounts:
    plex: [kids_plex]
  sets: [bob_movies]
`;
// Ada is on a queue tray AND in a group roster, so removing her exercises both halves of the
// cascade. Linus is on nothing, which is the other answer the confirmation has to give.
const MAPPING = `confirmed: true
version: 1
people:
- id: ada
  display_name: Ada
  accounts:
    plex: [ada_plex]
- id: linus
  display_name: Linus
  accounts: {}
groups:
- id: kids
  label: Kids
  min_present: 1
  people: [ada]
`;

const PORT = 18812;
const base = `http://localhost:${PORT}`;

type Answer = { status: number; body: Record<string, any> };

const call = async (method: string, url: string, body?: unknown): Promise<Answer> => {
  const res = await fetch(base + url, {
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    method,
  });
  return { body: (await res.json()) as Record<string, any>, status: res.status };
};
const get = async <T>(url: string): Promise<T> => (await (await fetch(base + url)).json()) as T;

type Roster = {
  people: { id: string; displayName: string; position: number }[];
  groups: { id: string; label: string; roster: { personId: string }[] }[];
};

const dir = await fs.mkdtemp(path.join(tmpdir(), 'qp-roster-editor-'));
await fs.writeFile(path.join(dir, 'sets.yaml'), SETS);
await fs.writeFile(path.join(dir, 'queues.yaml'), QUEUES);
await fs.writeFile(path.join(dir, 'groups.yaml'), GROUPS);
await fs.writeFile(path.join(dir, 'pending.yaml'), 'seen_through: 0\n');
await fs.writeFile(path.join(dir, 'people-mapping-proposal.yaml'), MAPPING);

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
    SETS_PATH: path.join(dir, 'sets.yaml'),
    STORE_BACKEND: 'sqlite',
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

  // File Ada on the queue's Must-be-here tray, so the delete below has a tray to clear.
  await call('PUT', '/api/sets/bob_movies/people', {
    members: [{ id: 'ada', kind: 'person', role: 'required' }],
  });

  // ── 1. add ──────────────────────────────────────────────────────────────────────────── //

  const added = await call('POST', '/api/people', { displayName: 'Grace Hopper' });
  ok('adding a person answers 201', added.status === 201, `status ${added.status}`);
  same('the id is slugified from the name', added.body.person?.id, 'grace-hopper');
  same('the name is stored verbatim', added.body.person?.displayName, 'Grace Hopper');
  // APPENDED. `listPeople()` answers in `position, id` order and that order is the contract the
  // trays and the checklist paint in, so a new person must not renumber the two already there.
  same('the new person is appended, not inserted', added.body.person?.position, 2);

  const dup = await call('POST', '/api/people', { displayName: 'Grace Hopper' });
  same('a second person with the same name gets a de-duplicated id', dup.body.person?.id, 'grace-hopper-2');

  const blankAdd = await call('POST', '/api/people', { displayName: '   ' });
  ok('a blank name is refused on add', blankAdd.status === 400, `status ${blankAdd.status}`);
  const symbolsOnly = await call('POST', '/api/people', { displayName: '???' });
  ok(
    'a name with nothing to make an id from is refused',
    symbolsOnly.status === 400,
    `status ${symbolsOnly.status}`,
  );

  // ── 2. rename, and the id does not move ─────────────────────────────────────────────── //

  const renamed = await call('PATCH', '/api/people/ada', { displayName: 'Ada Lovelace' });
  ok('renaming answers 200', renamed.status === 200, `status ${renamed.status}`);
  same('the id survives the rename', renamed.body.person?.id, 'ada');
  same('the name changed', renamed.body.person?.displayName, 'Ada Lovelace');

  // THE POINT OF RULE 1. The tray still names her, so the queue still comes up.
  const trays = await get<{ queues: Record<string, { id: string; kind: string }[]> }>(
    '/api/queue-people',
  );
  same(
    'the queue tray still names her by the same id',
    trays.queues.bob_movies,
    [{ id: 'ada', kind: 'person', position: 0, role: 'required' }],
  );

  const blankRename = await call('PATCH', '/api/people/ada', { displayName: '' });
  ok('a blank rename is refused', blankRename.status === 400, `status ${blankRename.status}`);
  const stillNamed = await get<Roster>('/api/people');
  same(
    'the refused rename changed nothing',
    stillNamed.people.find((p) => p.id === 'ada')?.displayName,
    'Ada Lovelace',
  );

  const missing = await call('PATCH', '/api/people/nobody', { displayName: 'X' });
  ok('renaming somebody who is not there is a 404', missing.status === 404, `status ${missing.status}`);

  // ── 3. rename a group, from the same editor ─────────────────────────────────────────── //

  const group = await call('PATCH', '/api/groups/kids', { label: 'Younger Kids' });
  ok('renaming a group answers 200', group.status === 200, `status ${group.status}`);
  const afterGroup = await get<Roster>('/api/people');
  same('the group label changed', afterGroup.groups.find((g) => g.id === 'kids')?.label, 'Younger Kids');
  // A group id is a URL (`/g/<id>`) and an MQTT payload, so a rename must not move it either.
  same(
    'the group keeps its roster and its id',
    afterGroup.groups.find((g) => g.id === 'kids')?.roster.map((m) => m.personId),
    ['ada'],
  );

  // ── 4. remove, and say what went with them ──────────────────────────────────────────── //

  const removedClean = await call('DELETE', '/api/people/linus');
  same('removing somebody filed on nothing reports nothing', removedClean.body.unfiled, {
    groups: [],
    queues: [],
  });

  const removed = await call('DELETE', '/api/people/ada');
  ok('removing answers 200', removed.status === 200, `status ${removed.status}`);
  same('it names the queue she was on', removed.body.unfiled?.queues, ['bob_movies']);
  same('it names the group she was in', removed.body.unfiled?.groups, ['kids']);

  const after = await get<Roster>('/api/people');
  same(
    'the roster is what is left, in position order',
    after.people.map((p) => p.id),
    ['grace-hopper', 'grace-hopper-2'],
  );
  same('the group roster no longer names her', after.groups.find((g) => g.id === 'kids')?.roster, []);

  const traysAfter = await get<{ queues: Record<string, unknown[]> }>('/api/queue-people');
  same('the queue tray no longer names her', traysAfter.queues.bob_movies ?? [], []);
  // The orphan report is what stands in for a foreign key `queue_people` cannot have. If the
  // cascade missed a row, this is where it shows up.
  const orphans = await get<{ orphans: unknown[] }>('/api/people');
  same('the delete left no orphaned member rows', orphans.orphans, []);

  const gone = await call('DELETE', '/api/people/ada');
  ok('removing her twice is a 404', gone.status === 404, `status ${gone.status}`);

  // ── 5. the mapping file is untouched ────────────────────────────────────────────────── //

  const mapping = await fs.readFile(path.join(dir, 'people-mapping-proposal.yaml'), 'utf8');
  ok('the mapping file is byte-identical', mapping === MAPPING);
} finally {
  killServer(child);
  await fs.rm(dir, { force: true, recursive: true });
}

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
