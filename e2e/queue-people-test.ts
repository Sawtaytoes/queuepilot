// THE WP-5 GATE — a queue is people plus an activity, and no wire id moved.
//
// One server, over one fixture, with a CONFIRMED people mapping so the trays have a house to
// show. Everything the package claims is asserted here against a running app, and the ids are
// compared as EXACT STRINGS: a count of four sets passes even when all four were replaced, and
// a set id is what a physical NFC card carries.
//
// Four things it pins, and each one is a rule somebody could undo without noticing:
//
//   1. **Wire ids never change.** A rename is display-side. `{"set": "<id>"}` still routes.
//   2. **Migration day recovers people from the group CLAIM, and parses no label.** A queue no
//      group claims comes up with NOBODY, which is the honest answer and one drag to fix.
//   3. **A group resolves to exactly ONE provider profile, or the write is REFUSED.** This is
//      the constraint the whole group model protects — a queue keyed on a group signs in as
//      one account no matter which of its people turned up.
//   4. **The activity is derived from the provider**, so migrating sixteen queues writes no
//      bytes, and a stored override is dropped again when it equals the derivation.
//   5. **A RULES queue carries people the same way a Picks queue does.** `queue_people` is
//      keyed on the set id and has never known a set's kind, so `kids_shorts` (a
//      `source: rotation` pool) is seeded by the same group claim and written by the same
//      endpoint. The UI refused to draw either half until 2026-08-26
//      (decision `2026-08-26-a-rules-queue-carries-people-too`); nothing on the server
//      changed, which is exactly what this section is here to keep true.
//
// Plex is unreachable on purpose (a closed port), so nothing here talks to the household.
//
// Run:  server/node_modules/.bin/tsx e2e/queue-people-test.ts   (repo root; non-zero on failure)
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

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : item,
  );

const same = (name: string, actual: unknown, expected: unknown): void =>
  ok(name, stable(actual) === stable(expected), `got ${JSON.stringify(actual)}`);

// ── the fixture ───────────────────────────────────────────────────────────────────────── //
//
// PEOPLE are Ada, Grace and Linus. The queues and groups keep the existing e2e cast.
//
// `carol_shows` is deliberately claimed by NO group — it is the "everybody in Everyone else"
// case, and it is the one a label-parsing migration would have guessed at.

const SET_IDS = [
  'bob_movies',
  'bob_alice_anime',
  'carol_shows',
  'dave_reading',
  'kids_shorts',
] as const;

const SETS = `sets:
- id: bob_movies
  label: Bob — Movies
  kind: picks
  source: queue
  sections: [1]
- id: bob_alice_anime
  label: Bob & Alice — Anime
  kind: anime
  source: queue
  sections: [11]
- id: carol_shows
  label: Carol — Shows
  kind: cartoons
  source: queue
  sections: [5]
- id: dave_reading
  label: Manga & Webtoons
  kind: manga
  source: queue
  sections: []
  providers:
  - provider: kavita
    libraries: [2]
- id: kids_shorts
  label: Shorts
  kind: cartoons
  source: rotation
  sections: [15]
  item_sections: [15]
  allowed_ratings: [TV-Y, TV-G, G]
  plex_user: Kids
  account_id: 11111111
  user_uuid: "1111111111111111"
`;

const QUEUES = `bob_movies:
- {ratingKey: "1", title: "A Movie (2001)"}
bob_alice_anime: []
carol_shows: []
dave_reading: []
`;

// `kids` is the group with the WP-5 rule; `two-profiles` is the one that must be refused —
// two Plex accounts of its own, so a queue keyed on it could not say which one it signs in as.
const GROUPS = `groups:
- id: bob
  label: Bob
  accounts:
    plex: [bob_plex]
  sets: [bob_movies]
- id: kids
  label: Kids
  accounts:
    plex: [kids_plex]
  sets: [bob_alice_anime, kids_shorts]
- id: dave
  label: Dave
  sets: [dave_reading]
- id: two-profiles
  label: Two Profiles
  accounts:
    plex: [one_plex, other_plex]
`;

/** Ada and Grace are the required half of Kids; Linus may join. "At least one of them." */
const MAPPING = `confirmed: true
version: 1
people:
- id: ada
  display_name: Ada
  accounts:
    plex: [ada_plex]
- id: grace
  display_name: Grace
  accounts:
    plex: [grace_plex]
- id: linus
  display_name: Linus
  accounts: {}
groups:
- id: kids
  label: Kids
  min_present: 1
  people: [ada, grace]
  optional_people: [linus]
`;

const PORT = 18811;
const base = `http://localhost:${PORT}`;

const get = async <T>(url: string): Promise<T> =>
  (await (await fetch(base + url)).json()) as T;

const put = async (
  url: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(base + url, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'PUT',
  });
  return { body: (await res.json()) as Record<string, unknown>, status: res.status };
};

const dir = await fs.mkdtemp(path.join(tmpdir(), 'qp-queue-people-'));
await fs.writeFile(path.join(dir, 'sets.yaml'), SETS);
await fs.writeFile(path.join(dir, 'queues.yaml'), QUEUES);
await fs.writeFile(path.join(dir, 'groups.yaml'), GROUPS);
await fs.writeFile(path.join(dir, 'pending.yaml'), 'seen_through: 0\n');
await fs.writeFile(path.join(dir, 'people-mapping-proposal.yaml'), MAPPING);

const setsBefore = await fs.readFile(path.join(dir, 'sets.yaml'), 'utf8');

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

  // ── 1. wire ids, first and last ─────────────────────────────────────────────────────── //

  const registry = await get<{
    sets: { id: string; activity: string; activity_default: string; provider_kind: string }[];
  }>('/api/sets');
  same('the set ids are exactly the registry, in file order', registry.sets.map((s) => s.id), [
    ...SET_IDS,
  ]);

  // ── 2. the activity is derived, and nothing was written to say so ───────────────────── //

  same(
    'every queue has an activity, derived from its provider',
    Object.fromEntries(registry.sets.map((s) => [s.id, s.activity])),
    {
      bob_alice_anime: 'watching',
      bob_movies: 'watching',
      carol_shows: 'watching',
      // Anime is NOT a type — `bob_alice_anime` is `watching`, told apart from `bob_movies` by
      // what is in it. A Kavita queue is the only one here that is not.
      dave_reading: 'reading',
      kids_shorts: 'watching',
    },
  );
  same(
    'the derivation is reported as the default too, so the editor can chip it',
    Object.fromEntries(registry.sets.map((s) => [s.id, s.activity_default])),
    Object.fromEntries(registry.sets.map((s) => [s.id, s.activity])),
  );
  ok(
    'migration day wrote NO bytes to sets.yaml',
    (await fs.readFile(path.join(dir, 'sets.yaml'), 'utf8')) === setsBefore,
  );

  // ── 3. the people, and the group's own rule ─────────────────────────────────────────── //

  const people = await get<{
    people: { id: string }[];
    groups: { id: string; minPresent: number | null; roster: { personId: string; role: string }[] }[];
  }>('/api/people');

  same('the roster is the people the mapping named', people.people.map((p) => p.id), [
    'ada',
    'grace',
    'linus',
  ]);

  const kids = people.groups.find((group) => group.id === 'kids');
  same('a group carries "at least one of them"', kids?.minPresent, 1);
  same(
    '…over the required half of its roster, with the third able to join',
    kids?.roster,
    [
      { personId: 'ada', position: 0, role: 'required' },
      { personId: 'grace', position: 1, role: 'required' },
      { personId: 'linus', position: 2, role: 'optional' },
    ],
  );
  same(
    'a group with no rule reads as ALL of them, never as one',
    people.groups.find((group) => group.id === 'bob')?.minPresent,
    null,
  );

  // ── 4. migration day ────────────────────────────────────────────────────────────────── //

  const trays = await get<{ queues: Record<string, { kind: string; id: string; role: string }[]> }>(
    '/api/queue-people',
  );

  same(
    'a claimed queue keeps its people — the GROUP, so its count travels with it',
    trays.queues.bob_alice_anime,
    [{ id: 'kids', kind: 'group', position: 0, role: 'required' }],
  );
  same(
    '…for every group that claims it',
    Object.keys(trays.queues).sort(),
    ['bob_alice_anime', 'bob_movies', 'dave_reading', 'kids_shorts'],
  );
  // A RULES pool is seeded by the same join, off the same claim list. It is the half the
  // editor had no screen for, and the rows were here the whole time.
  same(
    'a RULES pool is filed the same way a Picks queue is',
    trays.queues.kids_shorts,
    [{ id: 'kids', kind: 'group', position: 0, role: 'required' }],
  );
  same(
    'an UNCLAIMED queue comes up with nobody rather than a guess off its label',
    trays.queues.carol_shows ?? [],
    [],
  );

  // ── 5. the two trays are writable, and the constraint is enforced ───────────────────── //

  const written = await put('/api/sets/carol_shows/people', {
    members: [
      { id: 'ada', kind: 'person', role: 'required' },
      { id: 'linus', kind: 'person', role: 'optional' },
    ],
  });
  ok('a tray write is accepted', written.status === 200, `status ${written.status}`);
  same('…and reads back Must-be-here first', written.body.members, [
    { id: 'ada', kind: 'person', position: 0, role: 'required' },
    { id: 'linus', kind: 'person', position: 0, role: 'optional' },
  ]);

  // …and the same endpoint writes a RULES pool. Nothing about `PUT /api/sets/:id/people`
  // consults a set's kind, and this is what stops that becoming true by accident.
  const onRules = await put('/api/sets/kids_shorts/people', {
    members: [{ id: 'grace', kind: 'person', role: 'required' }],
  });
  ok('a RULES pool takes a tray write too', onRules.status === 200, `status ${onRules.status}`);
  same('…and reads it back', onRules.body.members, [
    { id: 'grace', kind: 'person', position: 0, role: 'required' },
  ]);

  const emptied = await put('/api/sets/carol_shows/people', { members: [] });
  same('an EMPTY list is a legitimate write — everybody back to Everyone else', emptied.body.members, []);

  const ghost = await put('/api/sets/carol_shows/people', {
    members: [{ id: 'nobody', kind: 'person', role: 'required' }],
  });
  ok('a member naming nobody is REFUSED', ghost.status === 400, `status ${ghost.status}`);

  // THE CONSTRAINT. Two Plex accounts on one group means a `requires_profile` queue keyed on it
  // would sign into whichever sorted first.
  const ambiguous = await put('/api/sets/carol_shows/people', {
    members: [{ id: 'two-profiles', kind: 'group', role: 'required' }],
  });
  ok(
    'a group that cannot resolve to ONE provider profile is refused',
    ambiguous.status === 400,
    `status ${ambiguous.status}`,
  );
  ok(
    '…and the refusal names both candidates rather than choosing',
    String(ambiguous.body.error ?? '').includes('one_plex') &&
      String(ambiguous.body.error ?? '').includes('other_plex'),
    String(ambiguous.body.error ?? ''),
  );
  same('…and nothing was written', (await get<{ members: unknown[] }>('/api/sets/carol_shows/people')).members, []);

  // ── 6. the rule is writable, and an impossible one is refused ───────────────────────── //

  const tooMany = await put('/api/groups/kids/membership', { minPresent: 5 });
  ok('"at least 5 of 2" is refused', tooMany.status === 400, `status ${tooMany.status}`);

  const cleared = await put('/api/groups/kids/membership', { minPresent: null });
  ok('the rule clears back to "all of them"', cleared.status === 200, `status ${cleared.status}`);
  same(
    '…which is the ABSENCE of a number, not a stored two',
    (cleared.body.membership as { minPresent: number | null }).minPresent,
    null,
  );

  // ── 7. the ids are still the ids ────────────────────────────────────────────────────── //

  const after = await get<{ sets: { id: string }[] }>('/api/sets');
  same('every wire id survived the whole session', after.sets.map((s) => s.id), [...SET_IDS]);
  const groups = await get<{ groups: { id: string }[] }>('/api/groups');
  same('…and every group id, `all` first', groups.groups.map((g) => g.id), [
    'all',
    'bob',
    'kids',
    'dave',
    'two-profiles',
  ]);
} finally {
  await new Promise((resolve) => {
    child.once('exit', resolve);
    killServer(child);
  });
}

console.log(failures ? `\n${failures} FAILED` : '\nall queue-people checks passed');
process.exit(failures ? 1 : 0);
