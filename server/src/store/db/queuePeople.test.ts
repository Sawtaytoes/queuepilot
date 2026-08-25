// `queue_people` as rows, and the two absent foreign keys the schema documents.
//
// The cast is Ada, Grace and Linus — new people fixtures are invented, never captured.
import { describe, expect, it } from 'vitest';

import {
  deleteQueueMembers,
  forgetMember,
  membersByQueue,
  orphanQueueMembers,
  queueMembers,
  setQueueMembers,
} from './queuePeople.js';
import {
  deletePerson,
  groupMembership,
  groupMinPresent,
  groupRoster,
  minPresentByGroup,
  setGroupMinPresent,
  setGroupPeople,
  upsertPerson,
} from './people.js';
import { migrate } from './open.js';
import type { QueueMember } from '../../queuePeople.js';
import { openSqlite, type SqliteDatabase } from '../sqlite.js';

const fresh = (): SqliteDatabase => {
  const db = openSqlite(':memory:');
  migrate(db);
  return db;
};

const addGroup = (db: SqliteDatabase, id: string, data: Record<string, unknown> = {}): void => {
  db.prepare('INSERT INTO groups (id, position, data) VALUES (?, 0, ?)').run(
    id,
    JSON.stringify({ id, label: id, ...data }),
  );
};

const addPeople = (db: SqliteDatabase, ...ids: string[]): void => {
  ids.forEach((id, position) => upsertPerson({ displayName: id, id, position }, db));
};

const member = (
  kind: QueueMember['kind'],
  id: string,
  role: QueueMember['role'] = 'required',
): QueueMember => ({ id, kind, position: 0, role });

describe('a queue is required people plus optional people', () => {
  it('reads back Must-be-here before Nice-to-have, whatever order it was written in', () => {
    const db = fresh();
    addPeople(db, 'ada', 'grace');
    setQueueMembers(
      'movies',
      [member('person', 'grace', 'optional'), member('person', 'ada')],
      db,
    );
    expect(queueMembers('movies', db)).toEqual([
      { id: 'ada', kind: 'person', position: 0, role: 'required' },
      { id: 'grace', kind: 'person', position: 0, role: 'optional' },
    ]);
  });

  it('numbers position PER TRAY, so two lists concatenated need no global index', () => {
    const db = fresh();
    addPeople(db, 'ada', 'grace', 'linus');
    setQueueMembers(
      'movies',
      [
        member('person', 'ada'),
        member('person', 'grace'),
        member('person', 'linus', 'optional'),
      ],
      db,
    );
    expect(queueMembers('movies', db).map((m) => [m.id, m.position])).toEqual([
      ['ada', 0],
      ['grace', 1],
      ['linus', 0],
    ]);
  });

  it('an EMPTY list is a legitimate write — everybody back to Everyone else', () => {
    const db = fresh();
    addPeople(db, 'ada');
    setQueueMembers('movies', [member('person', 'ada')], db);
    setQueueMembers('movies', [], db);
    expect(queueMembers('movies', db)).toEqual([]);
  });

  it('keeps a person and a group that share an id apart', () => {
    const db = fresh();
    addPeople(db, 'kids');
    addGroup(db, 'kids');
    setQueueMembers('movies', [member('person', 'kids'), member('group', 'kids')], db);
    expect(queueMembers('movies', db)).toHaveLength(2);
  });

  it('reads every queue at once', () => {
    const db = fresh();
    addPeople(db, 'ada', 'grace');
    setQueueMembers('movies', [member('person', 'ada')], db);
    setQueueMembers('reading', [member('person', 'grace')], db);
    const all = membersByQueue(db);
    expect(all.get('movies')?.map((m) => m.id)).toEqual(['ada']);
    expect(all.get('reading')?.map((m) => m.id)).toEqual(['grace']);
  });
});

describe('the two foreign keys this table deliberately does not have', () => {
  it('survives the groups table being replaced wholesale, the way a rename does', () => {
    // `store/db/groups.ts writeDoc()` is DELETE + INSERT on every write. A cascade here would
    // empty every queue's audience on the next group rename — the same trap `group_people`
    // sits beside, and the reason both tables report instead of constraining.
    const db = fresh();
    addGroup(db, 'kids');
    setQueueMembers('movies', [member('group', 'kids')], db);

    db.prepare('DELETE FROM groups').run();
    addGroup(db, 'kids', { label: 'Kids (renamed)' });

    expect(queueMembers('movies', db).map((m) => m.id)).toEqual(['kids']);
    expect(orphanQueueMembers(db)).toEqual([]);
  });

  it('REPORTS a member naming somebody who is gone rather than deleting it', () => {
    const db = fresh();
    setQueueMembers('movies', [member('group', 'ghost')], db);
    expect(orphanQueueMembers(db).map((m) => m.id)).toEqual(['ghost']);
    // Reported, not repaired — the rows are still there.
    expect(queueMembers('movies', db)).toHaveLength(1);
  });

  it('forgets a person from every queue when they are DELETED, since no cascade can', () => {
    const db = fresh();
    addPeople(db, 'ada');
    setQueueMembers('movies', [member('person', 'ada')], db);
    setQueueMembers('reading', [member('person', 'ada')], db);
    deletePerson('ada', db);
    expect(queueMembers('movies', db)).toEqual([]);
    expect(queueMembers('reading', db)).toEqual([]);
  });

  it('forgets a set when the set is deleted', () => {
    const db = fresh();
    addPeople(db, 'ada');
    setQueueMembers('movies', [member('person', 'ada')], db);
    expect(deleteQueueMembers('movies', db)).toBe(1);
    expect(queueMembers('movies', db)).toEqual([]);
  });

  it('forgets one group everywhere', () => {
    const db = fresh();
    addGroup(db, 'kids');
    setQueueMembers('movies', [member('group', 'kids')], db);
    setQueueMembers('reading', [member('group', 'kids')], db);
    expect(forgetMember('group', 'kids', db)).toBe(2);
  });
});

describe('a group carries its own count, in its own table', () => {
  it('is ABSENT by default, which means all of the required roster', () => {
    const db = fresh();
    addPeople(db, 'ada', 'grace');
    addGroup(db, 'kids');
    setGroupPeople('kids', ['ada', 'grace'], db);
    expect(groupMinPresent('kids', db)).toBeNull();
    expect(groupMembership('kids', db)).toEqual({
      groupId: 'kids',
      minPresent: null,
      roster: [
        { personId: 'ada', position: 0, role: 'required' },
        { personId: 'grace', position: 1, role: 'required' },
      ],
    });
  });

  it('stores "at least one of them" and reads it back', () => {
    const db = fresh();
    addPeople(db, 'ada', 'grace', 'linus');
    addGroup(db, 'kids');
    setGroupPeople(
      'kids',
      [
        { personId: 'ada', position: 0, role: 'required' },
        { personId: 'grace', position: 1, role: 'required' },
        { personId: 'linus', position: 2, role: 'optional' },
      ],
      db,
    );
    setGroupMinPresent('kids', 1, db);

    expect(groupRoster('kids', db)).toEqual([
      { personId: 'ada', position: 0, role: 'required' },
      { personId: 'grace', position: 1, role: 'required' },
      { personId: 'linus', position: 2, role: 'optional' },
    ]);
    expect(minPresentByGroup(db).get('kids')).toBe(1);
  });

  it('CLEARS by deleting the row, so "all of them" never goes stale', () => {
    // A stored number equal to the roster size would still say 2 after somebody added a third
    // person, and would then mean "at least two" while reading as "all of them".
    const db = fresh();
    addPeople(db, 'ada', 'grace');
    addGroup(db, 'kids');
    setGroupPeople('kids', ['ada', 'grace'], db);
    setGroupMinPresent('kids', 1, db);
    setGroupMinPresent('kids', null, db);
    expect(groupMinPresent('kids', db)).toBeNull();
    expect(minPresentByGroup(db).size).toBe(0);
  });

  it('refuses a count that is not a whole number of one or more', () => {
    const db = fresh();
    expect(() => setGroupMinPresent('kids', 0, db)).toThrow(/whole number of 1 or more/);
  });

  it('defaults a bare id to `required`, so every pre-WP-5 caller keeps its meaning', () => {
    const db = fresh();
    addPeople(db, 'ada');
    setGroupPeople('kids', ['ada'], db);
    expect(groupRoster('kids', db)).toEqual([{ personId: 'ada', position: 0, role: 'required' }]);
  });
});
