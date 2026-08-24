// THE WP-3 GATE — people arrive without disturbing a single wire id, and the import will not
// run until the owner says so.
//
// Two servers, over two copies of ONE fixture directory. The first boots with an UNCONFIRMED
// mapping file sitting in the config directory; the second boots with the same file confirmed.
// Between them, everything that already worked is compared as EXACT STRINGS.
//
// ── Why the assertions are strings and not counts ────────────────────────────────────────
//
// A count of five groups passes even if all five were replaced. A set id is what a physical
// NFC card carries and what Home Assistant puts in an MQTT `{"set": "<id>"}` payload, and a
// group id is a bookmarked `/g/<id>` URL. There is no redeploy that fixes a card on a wall, so
// the only assertion worth making is the list itself.
//
// ── What the gate is, in the plan's words ────────────────────────────────────────────────
//
//   "the profile gate (`requires_profile`) still resolves for every existing set, and
//    `/g/<id>` URLs still open"
//
// Both are here. The profile gate is checked as MEMBERSHIP, not as a field that survived a
// round trip: `bob_movies` is gated to a Plex account, no group names it in `sets:`, and it
// therefore has to DERIVE into the group that claims that account. That is the rule the whole
// groups feature is built on, and it is the one an identity change would break silently.
//
// Plex is unreachable on purpose (a closed port), so nothing here talks to the household.
//
// Run:  server/node_modules/.bin/tsx e2e/people-test.ts   (repo root; non-zero on failure)
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChildProcess } from 'node:child_process';

import { killServer, spawnServer } from './stubs/server-process.mjs';

let failures = 0;
const ok = (name: string, condition: boolean, extra = ''): void => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!condition) failures += 1;
};

/** Compare by value. ARRAY order is a contract here and is compared strictly — it is shelf
 * order, registry order and roster order. OBJECT key order is not, so keys are sorted first;
 * the maps below are keyed by set id and would otherwise fail on the order they were built in. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : item,
  );

const same = (name: string, actual: unknown, expected: unknown): void =>
  ok(name, stable(actual) === stable(expected), `got ${JSON.stringify(actual)}`);

// ── the fixture ───────────────────────────────────────────────────────────────────────── //
//
// The existing e2e cast — Bob, Alice, Carol, Dave, Erin. New PEOPLE fixtures are Ada, Grace
// and Linus; the groups and queues here are the old cast and are not renamed.

const SET_IDS = ['bob_movies', 'bob_alice_anime', 'carol_shows', 'dave_reading'] as const;
const GROUP_IDS = ['bob', 'bob-alice', 'carol', 'dave'] as const;

const SETS = `sets:
- id: bob_movies
  label: Bob — Movies
  kind: picks
  source: queue
  requires_profile: bob_plex
  sections: [1]
- id: bob_alice_anime
  label: Bob & Alice — Anime
  kind: anime
  source: queue
  requires_profile: bob_plex
  sections: [11]
- id: carol_shows
  label: Carol — Shows
  kind: cartoons
  source: rotation
  sections: [5]
  profiles:
  - plex_user: carol_plex
    account_id: 1
- id: dave_reading
  label: Dave — Reading
  kind: manga
  source: queue
  sections: []
`;

const QUEUES = `bob_movies:
- {ratingKey: "1", title: "A Movie (2001)"}
bob_alice_anime: []
dave_reading: []
`;

// `bob-alice` claims its set EXPLICITLY; `bob` claims by ACCOUNT. Both halves of the
// membership rule are therefore live in this fixture, which is what makes "the profile gate
// still resolves" a real assertion rather than a field check.
const GROUPS = `groups:
- id: bob
  label: Bob
  accounts:
    plex: [bob_plex]
    kavita: [Bob]
- id: bob-alice
  label: Bob & Alice
  sets: [bob_alice_anime]
- id: carol
  label: Carol
  accounts:
    plex: [carol_plex]
- id: dave
  label: Dave
  sets: [dave_reading]
`;

/** The mapping the tool would write: two people, one attached to an existing group. `Erin` is
 * a person nobody's group names — the ordinary case, and the one that merges nothing. */
const MAPPING = `version: 1
people:
- id: bob
  display_name: Bob
  board_game_picker_id: player-bob
  accounts:
    plex: [bob_plex]
    kavita: [Bob]
  birth_year: 1985
  max_weight: 4.2
  is_beginner: false
- id: erin
  display_name: Erin
  board_game_picker_id: player-erin
  accounts: {}
  birth_year: null
  max_weight: null
  is_beginner: true
groups:
- id: bob
  label: Bob
  people: [bob]
`;

interface Capture {
  setIds: string[];
  groupIds: string[];
  bobSetIds: string[];
  bobAliceSetIds: string[];
  requiresProfile: Record<string, string | null>;
  groupPageStatus: Record<string, number>;
  storePath: string;
}

async function boot(label: string, port: number, confirmed: boolean): Promise<Capture> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), `qp-people-${label}-`));
  await fs.writeFile(path.join(dir, 'sets.yaml'), SETS);
  await fs.writeFile(path.join(dir, 'queues.yaml'), QUEUES);
  await fs.writeFile(path.join(dir, 'groups.yaml'), GROUPS);
  await fs.writeFile(path.join(dir, 'pending.yaml'), 'seen_through: 0\n');
  // The proposal filename, not the confirmed one — the tool writes this, and confirming is
  // meant to be ONE edit rather than an edit plus a rename.
  await fs.writeFile(
    path.join(dir, 'people-mapping-proposal.yaml'),
    `${confirmed ? 'confirmed: true\n' : '# confirmed: true\n'}${MAPPING}`,
  );

  const child: ChildProcess = spawnServer({
    env: {
      ...process.env,
      CACHE_PATH: path.join(dir, 'cache.sqlite'),
      GROUPS_PATH: path.join(dir, 'groups.yaml'),
      HISTORY_PATH: path.join(dir, '.history.json'),
      MQTT_HOST: '',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      PENDING_PATH: path.join(dir, 'pending.yaml'),
      PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
      PLEX_TOKEN: '',
      QUEUES_PATH: path.join(dir, 'queues.yaml'),
      SETS_PATH: path.join(dir, 'sets.yaml'),
      STORE_BACKEND: 'sqlite',
      WEB_PORT: String(port),
    },
    stdio: 'ignore',
  });

  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        await fetch(`http://localhost:${port}/api/history`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    const registry = (await (await fetch(`http://localhost:${port}/api/sets`)).json()) as {
      sets: { id: string; requires_profile?: string }[];
    };
    const groups = (await (await fetch(`http://localhost:${port}/api/groups`)).json()) as {
      groups: { id: string; setIds: string[] }[];
    };

    const groupPageStatus: Record<string, number> = {};
    for (const id of GROUP_IDS) {
      groupPageStatus[id] = (await fetch(`http://localhost:${port}/g/${id}`)).status;
    }

    const byId = new Map(groups.groups.map((group) => [group.id, group]));
    return {
      bobAliceSetIds: byId.get('bob-alice')?.setIds ?? [],
      bobSetIds: byId.get('bob')?.setIds ?? [],
      groupIds: groups.groups.map((group) => group.id),
      groupPageStatus,
      requiresProfile: Object.fromEntries(
        registry.sets.map((set) => [set.id, set.requires_profile ?? null]),
      ),
      setIds: registry.sets.map((set) => set.id),
      storePath: path.join(dir, 'queues.queuepilot.sqlite'),
    };
  } finally {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      killServer(child);
    });
  }
}

/** The people rows the server left behind, read straight off the store file. */
function peopleIn(storePath: string): { people: string[]; roster: Record<string, string[]> } {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const people = (db.prepare('SELECT id FROM people ORDER BY position, id').all() as { id: string }[])
      .map((row) => row.id);
    const roster: Record<string, string[]> = {};
    for (const row of db
      .prepare('SELECT group_id, person_id FROM group_people ORDER BY group_id, position')
      .all() as { group_id: string; person_id: string }[]) {
      roster[row.group_id] = [...(roster[row.group_id] ?? []), row.person_id];
    }
    return { people, roster };
  } finally {
    db.close();
  }
}

// ── 1. an UNCONFIRMED mapping file changes nothing ───────────────────────────────────── //

const before = await boot('unconfirmed', 18801, false);

same('the set ids are exactly the registry, in file order', before.setIds, [...SET_IDS]);
same('the group ids are exactly the file, `all` first', before.groupIds, ['all', ...GROUP_IDS]);
same('every `requires_profile` survived verbatim', before.requiresProfile, {
  bob_alice_anime: 'bob_plex',
  bob_movies: 'bob_plex',
  carol_shows: null,
  dave_reading: null,
});
// The profile gate as MEMBERSHIP: `bob_movies` names no group, plays as `bob_plex`, and
// therefore derives into the group that claims that account. `bob_alice_anime` plays as the
// same account but is NAMED by `bob-alice`, so explicit beats derived and it does not leak.
same('the profile gate still resolves — a gated set derives into its account holder',
  before.bobSetIds, ['bob_movies']);
same('…and an explicitly claimed set stays where it was claimed',
  before.bobAliceSetIds, ['bob_alice_anime']);
same('every `/g/<id>` still opens', before.groupPageStatus, {
  bob: 200, 'bob-alice': 200, carol: 200, dave: 200,
});

const beforeRows = peopleIn(before.storePath);
same('an UNCONFIRMED mapping imported NOBODY', beforeRows.people, []);
same('…and attached nobody to a group', beforeRows.roster, {});

// ── 2. the same file, confirmed ───────────────────────────────────────────────────────── //

const after = await boot('confirmed', 18802, true);

const afterRows = peopleIn(after.storePath);
same('a CONFIRMED mapping imports the people it names', afterRows.people, ['bob', 'erin']);
same('…and the group it names becomes a saved set of those people', afterRows.roster, {
  bob: ['bob'],
});

// The whole point of the package, and the reason the ids are compared as strings.
same('the set ids are unchanged by the people import', after.setIds, before.setIds);
same('the group ids are unchanged by the people import', after.groupIds, before.groupIds);
same('the profile gate is unchanged by the people import', after.requiresProfile, before.requiresProfile);
same('group membership is unchanged by the people import', after.bobSetIds, before.bobSetIds);
same('…on the explicit side too', after.bobAliceSetIds, before.bobAliceSetIds);
same('every `/g/<id>` still opens after the import', after.groupPageStatus, before.groupPageStatus);

console.log(failures ? `\n${failures} FAILED` : '\nall people checks passed');
process.exit(failures ? 1 : 0);
