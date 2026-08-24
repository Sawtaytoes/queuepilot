// The people rows: the upsert, the account replacement, the roster, and the two traps the
// schema is shaped around.
//
// The cast is Ada, Grace and Linus — new people fixtures are invented, never captured
// (AGENTS.md). The existing Bob/Alice/Carol cast belongs to the group and queue fixtures and
// is not renamed.
import { describe, expect, it } from 'vitest';

import {
  deletePerson,
  getPerson,
  getPersonBySource,
  groupPersonIds,
  listPeople,
  orphanGroupIds,
  rostersByGroup,
  setGroupPeople,
  setPersonAccounts,
  upsertPerson,
} from './people.js';
import { migrate } from './open.js';
import { openSqlite, type SqliteDatabase } from '../sqlite.js';

const fresh = (): SqliteDatabase => {
  const db = openSqlite(':memory:');
  migrate(db);
  return db;
};

/** A group row, written straight in — `store/db/groups.ts` wants a whole `Document` and this
 * file only needs the id to exist. */
const addGroup = (db: SqliteDatabase, id: string, label: string): void => {
  db.prepare('INSERT INTO groups (id, position, data) VALUES (?, 0, ?)').run(
    id,
    JSON.stringify({ id, label }),
  );
};

describe('people rows', () => {
  it('writes a person and reads them back whole', () => {
    const db = fresh();
    upsertPerson(
      {
        accounts: { kavita: ['Ada'], plex: ['ada-on-plex', 'ada-kids'] },
        birthYear: 1985,
        createdAt: '2026-08-23T00:00:00Z',
        displayName: 'Ada',
        id: 'ada',
        isBeginner: false,
        maxWeight: 4.2,
        position: 0,
        source: 'board-game-picker',
        sourceId: 'player-1',
      },
      db,
    );

    const person = getPerson('ada', db);
    expect(person).toEqual({
      accounts: { kavita: ['Ada'], plex: ['ada-on-plex', 'ada-kids'] },
      birthYear: 1985,
      createdAt: '2026-08-23T00:00:00Z',
      displayName: 'Ada',
      id: 'ada',
      isBeginner: false,
      maxWeight: 4.2,
      position: 0,
      source: 'board-game-picker',
      sourceId: 'player-1',
    });
    // The account order inside a kind is the order it was written in — it is a roster, and a
    // person's first account is the one they mostly are.
    expect(person?.accounts.plex).toEqual(['ada-on-plex', 'ada-kids']);
    db.close();
  });

  it('is idempotent on the source id — a second import updates rather than duplicating', () => {
    const db = fresh();
    upsertPerson({ displayName: 'Ada', id: 'ada', source: 'board-game-picker', sourceId: 'p1' }, db);
    upsertPerson({ displayName: 'Ada Lovelace', id: 'ada', source: 'board-game-picker', sourceId: 'p1' }, db);

    expect(listPeople(db)).toHaveLength(1);
    expect(getPersonBySource('board-game-picker', 'p1', db)?.displayName).toBe('Ada Lovelace');
    db.close();
  });

  it('refuses two people claiming the same source player', () => {
    // The unique index is the last line of defence behind the mapping file's own check. Two
    // people pointing at one Board Game Picker player is a merge nobody asked for, and it takes
    // that player's known-how with it.
    const db = fresh();
    upsertPerson({ displayName: 'Ada', id: 'ada', source: 'board-game-picker', sourceId: 'p1' }, db);
    expect(() =>
      upsertPerson({ displayName: 'Grace', id: 'grace', source: 'board-game-picker', sourceId: 'p1' }, db),
    ).toThrow(/UNIQUE|constraint/i);
    db.close();
  });

  it('lets many people carry no source at all', () => {
    // The unique index is PARTIAL for exactly this: a household of people created by hand all
    // have (NULL, NULL) and must not collide.
    const db = fresh();
    upsertPerson({ displayName: 'Ada', id: 'ada' }, db);
    upsertPerson({ displayName: 'Grace', id: 'grace' }, db);
    upsertPerson({ displayName: 'Linus', id: 'linus' }, db);
    expect(listPeople(db).map((person) => person.id)).toEqual(['ada', 'grace', 'linus']);
    db.close();
  });

  it('keeps NULL max_weight distinct from a ceiling of 5', () => {
    // "No ceiling stated" and "will play anything up to 5" are different answers and the picker
    // treats them differently. A column that defaulted one to the other would be unrecoverable.
    const db = fresh();
    upsertPerson({ displayName: 'Ada', id: 'ada', maxWeight: null }, db);
    upsertPerson({ displayName: 'Grace', id: 'grace', maxWeight: 5 }, db);
    expect(getPerson('ada', db)?.maxWeight).toBeNull();
    expect(getPerson('grace', db)?.maxWeight).toBe(5);
    db.close();
  });

  it('refuses a weight outside BoardGameGeek 1–5 and a nonsense birth year', () => {
    const db = fresh();
    expect(() => upsertPerson({ displayName: 'Ada', id: 'ada', maxWeight: 9 }, db)).toThrow(/CHECK/i);
    expect(() => upsertPerson({ displayName: 'Ada', id: 'ada', birthYear: 12 }, db)).toThrow(/CHECK/i);
    db.close();
  });

  it('replaces the whole account list rather than merging it', () => {
    const db = fresh();
    upsertPerson({ accounts: { plex: ['a', 'b'] }, displayName: 'Ada', id: 'ada' }, db);
    setPersonAccounts('ada', { plex: ['a'] }, db);
    // Removing an account has to be possible through this door, so it is a replace.
    expect(getPerson('ada', db)?.accounts).toEqual({ plex: ['a'] });
    db.close();
  });

  it('leaves an omitted field alone but clears an explicit null', () => {
    const db = fresh();
    upsertPerson({ displayName: 'Ada', id: 'ada', maxWeight: 3.5, position: 7 }, db);
    upsertPerson({ id: 'ada' }, db);
    const person = getPerson('ada', db);
    expect(person?.displayName).toBe('Ada'); // omitted — kept
    expect(person?.position).toBe(7); // omitted — kept
    expect(person?.maxWeight).toBeNull(); // absent means null on the picker fields
    db.close();
  });

  it('falls back to the id when a person is written with no display name', () => {
    const db = fresh();
    upsertPerson({ id: 'ada' }, db);
    expect(getPerson('ada', db)?.displayName).toBe('ada');
    db.close();
  });
});

describe('a group as a saved set of people', () => {
  it('holds a roster in the order it was given', () => {
    const db = fresh();
    addGroup(db, 'lovelace', 'Lovelace');
    for (const id of ['ada', 'grace', 'linus']) upsertPerson({ displayName: id, id }, db);

    setGroupPeople('lovelace', ['linus', 'ada'], db);
    expect(groupPersonIds('lovelace', db)).toEqual(['linus', 'ada']);
    expect(rostersByGroup(db).get('lovelace')).toEqual(['linus', 'ada']);
    db.close();
  });

  it('names the unknown person rather than throwing a foreign-key message', () => {
    const db = fresh();
    addGroup(db, 'lovelace', 'Lovelace');
    expect(() => setGroupPeople('lovelace', ['nobody'], db)).toThrow(/unknown person id\(s\): nobody/);
    db.close();
  });

  it('SURVIVES the groups table being rewritten — the trap the schema has no FK for', () => {
    // `store/db/groups.ts writeDoc()` and the YAML importer both replace the whole `groups`
    // table with DELETE + INSERT on every write. An `ON DELETE CASCADE` from `group_people`
    // would therefore empty every roster the next time anybody renamed a group, silently.
    const db = fresh();
    addGroup(db, 'lovelace', 'Lovelace');
    upsertPerson({ displayName: 'Ada', id: 'ada' }, db);
    setGroupPeople('lovelace', ['ada'], db);

    db.exec('DELETE FROM groups');
    addGroup(db, 'lovelace', 'Lovelace & Friends');

    expect(groupPersonIds('lovelace', db)).toEqual(['ada']);
    db.close();
  });

  it('reports an orphaned roster rather than deleting it', () => {
    const db = fresh();
    addGroup(db, 'lovelace', 'Lovelace');
    upsertPerson({ displayName: 'Ada', id: 'ada' }, db);
    setGroupPeople('lovelace', ['ada'], db);
    db.exec('DELETE FROM groups');

    expect(orphanGroupIds(db)).toEqual(['lovelace']);
    db.close();
  });

  it('cascades a DELETED PERSON out of every roster', () => {
    // The one cascade that is right: a person who is gone cannot still be in a group. This one
    // is safe because nothing ever replaces the `people` table wholesale.
    const db = fresh();
    addGroup(db, 'lovelace', 'Lovelace');
    upsertPerson({ displayName: 'Ada', id: 'ada' }, db);
    upsertPerson({ displayName: 'Grace', id: 'grace' }, db);
    setGroupPeople('lovelace', ['ada', 'grace'], db);

    expect(deletePerson('ada', db)).toBe(true);
    expect(groupPersonIds('lovelace', db)).toEqual(['grace']);
    expect(deletePerson('ada', db)).toBe(false);
    db.close();
  });
});
