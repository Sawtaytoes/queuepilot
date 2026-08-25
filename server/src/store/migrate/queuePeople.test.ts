// Migration day for the sixteen queues — and the thing it refuses to do.
//
// The cast is Ada, Grace and Linus. `STORE_PATH` never comes near this: `seedQueuePeople` is
// exercised through the process-wide handle a `:memory:` database stands in for, so the suite
// is one file and no `/config` path is opened.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from '../db/open.js';
import { openSqlite, type SqliteDatabase } from '../sqlite.js';

let db: SqliteDatabase;

// The seeder reaches for the process-wide handle and for the YAML importer. Both are stubbed
// so the test drives rows directly — what is under test is the JOIN, not the boot sequence.
vi.mock('./yaml.js', () => ({ ensureImported: () => {} }));
vi.mock('../db/open.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db/open.js')>();
  return { ...real, bookOfRecord: () => db };
});

const { seedQueuePeople, resetQueuePeopleSeedState } = await import('./queuePeople.js');
const { queueMembers, setQueueMembers } = await import('../db/queuePeople.js');

const addSet = (id: string): void => {
  db.prepare('INSERT INTO sets (id, position, data) VALUES (?, 0, ?)').run(
    id,
    JSON.stringify({ id, label: id }),
  );
};

const addGroup = (id: string, claimed: string[]): void => {
  db.prepare('INSERT INTO groups (id, position, data) VALUES (?, 0, ?)').run(
    id,
    JSON.stringify({ id, label: id, sets: claimed }),
  );
};

beforeEach(() => {
  db = openSqlite(':memory:');
  migrate(db);
  resetQueuePeopleSeedState();
});

describe('the queues keep their people, recovered from the group CLAIM', () => {
  it('seeds a claimed queue with the group that claims it, as a required member', () => {
    addSet('movies');
    addGroup('family', ['movies']);

    const report = seedQueuePeople();

    expect(report.seeded).toBe(true);
    expect(report.seededSets).toEqual([{ memberCount: 1, setId: 'movies' }]);
    expect(queueMembers('movies', db)).toEqual([
      { id: 'family', kind: 'group', position: 0, role: 'required' },
    ]);
  });

  it('keeps the GROUP as the member rather than flattening it to its people', () => {
    // Flattening would turn "either of the kids is enough" into "both of them", which is the
    // rule the whole package exists to express.
    addSet('shows');
    addGroup('kids', ['shows']);
    seedQueuePeople();
    expect(queueMembers('shows', db)[0]?.kind).toBe('group');
  });

  it('gives a queue every group that claims it', () => {
    addSet('movies');
    addGroup('family', ['movies']);
    addGroup('kids', ['movies']);
    seedQueuePeople();
    expect(queueMembers('movies', db).map((m) => m.id)).toEqual(['family', 'kids']);
  });

  it('leaves an UNCLAIMED queue with no members — everybody in Everyone else', () => {
    // The honest outcome. A heuristic willing to read people out of "Family — Movies" would
    // have to invent them, and what it corrupts is which profile the queue signs into.
    addSet('movies');
    addSet('reading');
    addGroup('family', ['movies']);

    const report = seedQueuePeople();

    expect(report.unclaimedSetIds).toEqual(['reading']);
    expect(queueMembers('reading', db)).toEqual([]);
  });

  it('REPORTS a claimed set id that is not in the registry, and writes nothing for it', () => {
    addSet('movies');
    addGroup('family', ['movies', 'deleted-long-ago']);

    const report = seedQueuePeople();

    expect(report.unknownSetIds).toEqual(['deleted-long-ago']);
    expect(queueMembers('deleted-long-ago', db)).toEqual([]);
  });
});

describe('it never undoes an edit', () => {
  it('leaves a queue that already has members alone', () => {
    addSet('movies');
    addGroup('family', ['movies']);
    setQueueMembers('movies', [{ id: 'ada', kind: 'person', position: 0, role: 'required' }], db);

    const report = seedQueuePeople();

    expect(report.skippedSetIds).toEqual(['movies']);
    expect(queueMembers('movies', db).map((m) => m.id)).toEqual(['ada']);
  });

  it('is a no-op on the second run', () => {
    addSet('movies');
    addGroup('family', ['movies']);
    seedQueuePeople();
    resetQueuePeopleSeedState();
    expect(seedQueuePeople().reason).toBe('already seeded');
  });

  it('does not overwrite an edit even when FORCED', () => {
    addSet('movies');
    addGroup('family', ['movies']);
    seedQueuePeople();
    setQueueMembers('movies', [], db);

    const report = seedQueuePeople({ force: true });

    expect(report.reason).toBe('forced');
    // An empty audience is an EDIT — "everybody back to Everyone else" — so a forced re-run
    // re-seeds it. What it must not do is fight a non-empty one.
    expect(report.seededSets).toEqual([{ memberCount: 1, setId: 'movies' }]);

    setQueueMembers('movies', [{ id: 'ada', kind: 'person', position: 0, role: 'required' }], db);
    expect(seedQueuePeople({ force: true }).skippedSetIds).toEqual(['movies']);
  });
});
