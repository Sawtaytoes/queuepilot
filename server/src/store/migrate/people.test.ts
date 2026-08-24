// THE GATE, and the four ways past it that must not exist.
//
// The single most valuable assertion in this file is the first one: an unconfirmed mapping
// writes NOTHING. Everything else here is about the second-worst outcome — a confirmed file
// that is wrong in one line writing the other lines anyway.
//
// Every path is a fresh `mkdtemp`, and the env is set BEFORE the modules are imported:
// `config.ts` resolves `QUEUES_PATH` and `STORE_PATH` at module load. Hence the dynamic
// imports at the bottom.
//
// The cast is Ada, Grace and Linus. This repo is public.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'qp-people-'));

// Two groups, so a mapping can attach a person to one and get a typo wrong on the other.
const GROUPS = `groups:
- id: ada
  label: Ada
  accounts:
    plex: [ada-on-plex]
- id: lovelace
  label: Lovelace
`;

writeFileSync(join(dir, 'sets.yaml'), 'sets: []\n');
writeFileSync(join(dir, 'queues.yaml'), '{}\n');
writeFileSync(join(dir, 'groups.yaml'), GROUPS);
writeFileSync(join(dir, 'pending.yaml'), 'seen_through: 0\n');

process.env.QUEUES_PATH = join(dir, 'queues.yaml');
process.env.SETS_PATH = join(dir, 'sets.yaml');
process.env.GROUPS_PATH = join(dir, 'groups.yaml');
process.env.PENDING_PATH = join(dir, 'pending.yaml');
process.env.STORE_BACKEND = 'sqlite';
process.env.STORE_YAML_MIRROR = '0';

const MAPPING = join(dir, 'people-mapping.yaml');

const { importPeople, validateMapping } = await import('./people.js');
const { listPeople, groupPersonIds } = await import('../db/people.js');
const { bookOfRecord, closeBookOfRecord } = await import('../db/open.js');

/** Write a mapping file. `confirmed` is left OUT unless asked for — the way the tool writes
 * it, and the way the gate expects to find it. */
const writeMapping = (body: string, { confirmed = false } = {}): void => {
  writeFileSync(MAPPING, `${confirmed ? 'confirmed: true\n' : ''}${body}`);
};

const ONE_PERSON = `version: 1
people:
- id: ada
  display_name: Ada
  board_game_picker_id: player-1
  accounts:
    plex: [ada-on-plex]
    kavita: [Ada]
  birth_year: 1985
  max_weight: 4.2
  is_beginner: false
groups:
- id: ada
  people: [ada]
`;

afterAll(() => {
  closeBookOfRecord();
  rmSync(dir, { force: true, recursive: true });
});

beforeEach(() => {
  const db = bookOfRecord();
  db.exec('DELETE FROM group_people');
  db.exec('DELETE FROM people');
  db.exec("DELETE FROM store_meta WHERE store = 'people'");
});

describe('the confirmation gate', () => {
  it('WRITES NOTHING without `confirmed: true`', () => {
    // The reason this package exists. Migrating people on an unconfirmed guess is worse than
    // not migrating them: the second is a job still to do, the first is a corruption nobody
    // sees, because a wrong person's "knows the rules" claim is on no screen.
    writeMapping(ONE_PERSON);
    const result = importPeople();

    expect(result.imported).toBe(false);
    expect(result.reason).toMatch(/waiting for `confirmed: true`/);
    expect(listPeople()).toEqual([]);
  });

  it('is not satisfied by a truthy value that is not `true`', () => {
    for (const value of ['yes', '"true"', '1', 'null']) {
      writeFileSync(MAPPING, `confirmed: ${value}\n${ONE_PERSON}`);
      expect(importPeople().imported).toBe(false);
    }
    expect(listPeople()).toEqual([]);
  });

  it('writes once the owner confirms', () => {
    writeMapping(ONE_PERSON, { confirmed: true });
    const result = importPeople();

    expect(result.imported).toBe(true);
    expect(result.personIds).toEqual(['ada']);
    expect(result.groupIds).toEqual(['ada']);
    expect(result.accountCount).toBe(2);
    expect(result.rosterCount).toBe(1);

    const [person] = listPeople();
    expect(person?.id).toBe('ada');
    expect(person?.displayName).toBe('Ada');
    expect(person?.accounts).toEqual({ kavita: ['Ada'], plex: ['ada-on-plex'] });
    expect(person?.maxWeight).toBe(4.2);
    expect(person?.source).toBe('board-game-picker');
    expect(person?.sourceId).toBe('player-1');
    expect(groupPersonIds('ada')).toEqual(['ada']);
  });

  it('is IDEMPOTENT — a second run over the same file writes nothing new', () => {
    writeMapping(ONE_PERSON, { confirmed: true });
    expect(importPeople().imported).toBe(true);

    const again = importPeople();
    expect(again.imported).toBe(false);
    expect(again.reason).toMatch(/has not changed/);
    expect(listPeople()).toHaveLength(1);

    // …and forcing it through lands on the same single row rather than a twin.
    expect(importPeople({ force: true }).imported).toBe(true);
    expect(listPeople()).toHaveLength(1);
  });

  it('leaves a person it has never heard of alone', () => {
    // The file OWNS the rows it names and nothing else, so a re-run after somebody adds a
    // person by hand does not delete them.
    writeMapping(ONE_PERSON, { confirmed: true });
    importPeople();

    const db = bookOfRecord();
    db.prepare("INSERT INTO people (id, display_name) VALUES ('linus', 'Linus')").run();

    importPeople({ force: true });
    expect(listPeople().map((person) => person.id).sort()).toEqual(['ada', 'linus']);
  });
});

describe('a confirmed file that does not validate', () => {
  const refuses = (body: string, pattern: RegExp): void => {
    writeMapping(body, { confirmed: true });
    const result = importPeople();
    expect(result.imported).toBe(false);
    expect(result.problems.join('\n')).toMatch(pattern);
    // NOTHING is written. A file that is half right is a file to look at, not half a household.
    expect(listPeople()).toEqual([]);
  };

  it('refuses two people claiming the same Board Game Picker player', () => {
    refuses(
      `version: 1
people:
- id: ada
  board_game_picker_id: player-1
- id: grace
  board_game_picker_id: player-1
`,
      /already claimed by 'ada'/,
    );
  });

  it('refuses a group that names somebody who is not in `people:`', () => {
    refuses(
      `version: 1
people:
- id: ada
groups:
- id: ada
  people: [ada, grace]
`,
      /names 'grace', who is not in/,
    );
  });

  it('refuses a group id that is not a group', () => {
    // This file attaches people to EXISTING groups. A group id is a bookmarked `/g/<id>` URL
    // and inventing one is the owner's decision, not a migration's — so an unknown id is a typo.
    refuses(
      `version: 1
people:
- id: ada
groups:
- id: adaa
  people: [ada]
`,
      /no such group/,
    );
  });

  it('refuses an id that is not URL-shaped, and a duplicate one', () => {
    refuses(
      `version: 1
people:
- id: Ada Lovelace
`,
      /it is a URL/,
    );
    refuses(
      `version: 1
people:
- id: ada
- id: ada
`,
      /duplicate id/,
    );
  });

  it('refuses a weight off BoardGameGeek 1–5 and a fractional birth year', () => {
    refuses(
      `version: 1
people:
- id: ada
  max_weight: 7
`,
      /1–5 scale/,
    );
    refuses(
      `version: 1
people:
- id: ada
  birth_year: 1985.5
`,
      /whole year/,
    );
  });

  it('refuses a version it does not understand', () => {
    refuses('version: 2\npeople:\n- id: ada\n', /version must be 1/);
  });

  it('reports EVERY problem at once, not the first', () => {
    // A file with four typos should cost one round trip, not four. The owner is reading this
    // at a keyboard once.
    writeMapping(
      `version: 3
people:
- id: Ada
- id: grace
  max_weight: 9
groups:
- id: nope
  people: [ada]
`,
      { confirmed: true },
    );
    expect(importPeople().problems.length).toBeGreaterThanOrEqual(4);
  });
});

describe('validateMapping', () => {
  it('never reads `unmatched:` — it is documentation', () => {
    // The proposal writes its own uncertainty into the same file as its answers, so the
    // question is not dropped on the floor. Reading it would defeat the whole point.
    const { problems } = validateMapping(
      {
        people: [{ id: 'ada' }],
        unmatched: { groups: [{ id: 'not-a-group', people: ['nobody'] }], people: [{ id: 'NOT VALID' }] },
        version: 1,
      },
      new Set(['ada']),
    );
    expect(problems).toEqual([]);
  });

  it('says so when there is nothing to import', () => {
    const { problems } = validateMapping({ version: 1 }, new Set());
    expect(problems.join('\n')).toMatch(/`people:` is empty/);
  });
});
