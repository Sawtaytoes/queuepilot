// The shim's gate. Two jobs, and the second is the one that earns its keep.
//
//   1. Pin the better-sqlite3 SHAPE the absorbed call sites depend on — the return types, the
//      parameter forms, the transaction semantics.
//   2. CHARACTERIZE the places where `node:sqlite` and `better-sqlite3` genuinely differ. Those
//      tests do not assert that the shim is nice; they assert what the driver actually does, so
//      that a Node upgrade which changes one of them fails HERE rather than inside a pick three
//      months later. Each is marked `DRIVER DIFFERENCE` and matches an entry in `sqlite.ts`'s
//      header.
//
// The fixture is a miniature of the absorbed board-game schema — text primary keys, a cascade,
// a numeric-boolean column, an ISO-8601 timestamp — because those are the shapes the 104 real
// call sites use. The people are this repo's existing placeholder cast — Bob, Alice, Carol —
// and every title is invented. (AGENTS.md: this repo is public, and library contents are
// placeholders.)
import { describe, expect, it } from 'vitest';
import { openSqlite, type SqliteDatabase } from './sqlite.js';

const SCHEMA = `
CREATE TABLE games (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  weight REAL,
  bgg_id INTEGER
);

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  is_beginner INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE known_games (
  game_id TEXT NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (game_id, player_id)
);
`;

/** A fresh in-memory database with the fixture loaded, opened exactly the way the ported
 * `database.ts` opens the real one. */
const open = (): SqliteDatabase => {
  const db = openSqlite(':memory:');

  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare("INSERT INTO games (id, name, weight, bgg_id) VALUES ('orchard', 'Orchard', 2.4, 101)").run();
  db.prepare("INSERT INTO games (id, name, weight, bgg_id) VALUES ('lantern', 'Harbour Lantern', 3.1, 102)").run();
  db.prepare("INSERT INTO players (id, display_name, is_beginner) VALUES ('bob', 'Bob', 0)").run();
  db.prepare("INSERT INTO players (id, display_name, is_beginner) VALUES ('alice', 'Alice', 1)").run();

  return db;
};

interface GameRow {
  id: string;
  name: string;
  weight: number | null;
  bgg_id: number | null;
}

describe('prepare / get / all / run', () => {
  it('reads one row, and undefined when nothing matched', () => {
    const db = open();
    const statement = db.prepare<GameRow>('SELECT * FROM games WHERE id = ?');

    expect(statement.get('orchard')).toEqual({
      id: 'orchard',
      name: 'Orchard',
      weight: 2.4,
      bgg_id: 101,
    });
    expect(statement.get('nothing-by-that-name')).toBeUndefined();
  });

  it('reads every row, and an empty array when nothing matched', () => {
    const db = open();

    expect(
      db
        .prepare<GameRow>('SELECT * FROM games ORDER BY name')
        .all()
        .map((row) => row.name),
    ).toEqual(['Harbour Lantern', 'Orchard']);
    expect(db.prepare('SELECT * FROM games WHERE id = ?').all('nothing')).toEqual([]);
  });

  it('reports changes and the inserted rowid as better-sqlite3 does', () => {
    const db = open();
    const result = db
      .prepare('INSERT INTO players (id, display_name, is_beginner) VALUES (?, ?, ?)')
      .run('carol', 'Carol', 0);

    expect(result.changes).toBe(1);
    expect(typeof result.changes).toBe('number');
    expect(typeof result.lastInsertRowid).toBe('number');

    expect(db.prepare('DELETE FROM players WHERE id = ?').run('carol').changes).toBe(1);
    expect(db.prepare('DELETE FROM players WHERE id = ?').run('carol').changes).toBe(0);
  });

  it('iterates row by row', () => {
    const db = open();
    const names = [...db.prepare<GameRow>('SELECT * FROM games ORDER BY name').iterate()].map(
      (row) => row.name,
    );

    expect(names).toEqual(['Harbour Lantern', 'Orchard']);
  });

  it('carries the SQL it was compiled from', () => {
    expect(open().prepare('SELECT 1').sql).toBe('SELECT 1');
  });
});

describe('parameter binding', () => {
  it('binds positionally', () => {
    const db = open();

    expect(
      db.prepare<GameRow>('SELECT * FROM games WHERE weight > ? AND bgg_id < ?').all(3, 200),
    ).toHaveLength(1);
  });

  it('binds a named-parameter object under every prefix SQLite accepts', () => {
    const db = open();

    // The absorbed code writes `@name`; `:name` and `$name` are the other two spellings, and a
    // port that only proved one of them would be a port that had not looked.
    for (const sql of [
      'SELECT * FROM games WHERE id = @id',
      'SELECT * FROM games WHERE id = :id',
      'SELECT * FROM games WHERE id = $id',
    ]) {
      expect(db.prepare<GameRow>(sql).get({ id: 'orchard' })?.name).toBe('Orchard');
    }
  });

  it('takes a named object and positional values together, object first', () => {
    const db = open();
    const row = db
      .prepare<GameRow>('SELECT * FROM games WHERE id = @id AND weight > ?')
      .get({ id: 'orchard' }, 1);

    expect(row?.name).toBe('Orchard');
  });

  it('refuses a named-parameter object anywhere but first', () => {
    // Not a driver difference — a deliberate narrowing. better-sqlite3 accepts the object in
    // any position; node:sqlite's signature demands position one, and quietly reordering a
    // caller's arguments to bridge that is worse than saying no.
    const db = open();

    expect(() =>
      db.prepare('SELECT * FROM games WHERE weight > ? AND id = @id').all(1, { id: 'orchard' }),
    ).toThrow(/must be the FIRST argument/);
  });

  it('DRIVER DIFFERENCE — an UNKNOWN named parameter throws, in both drivers', () => {
    const db = open();

    expect(() =>
      db.prepare('SELECT * FROM games WHERE id = @id').all({ id: 'orchard', typo: 'x' }),
    ).toThrow(/Unknown named parameter/);
  });

  it('DRIVER DIFFERENCE — a MISSING named parameter binds NULL instead of throwing', () => {
    // better-sqlite3 throws `Missing named parameter "name"`. node:sqlite binds NULL and runs.
    // This is the one difference the shim cannot close without parsing the SQL for its own
    // placeholders, and it turns a typo'd OMISSION into a silent NULL write. Pinned so nobody
    // discovers it from a row of nulls in production.
    const db = open();

    db.prepare('INSERT INTO games (id, name, weight) VALUES (@id, @name, @weight)').run({
      id: 'unnamed',
      name: 'Placeholder',
    });

    expect(db.prepare<GameRow>('SELECT * FROM games WHERE id = ?').get('unnamed')?.weight).toBeNull();
  });

  it('DRIVER DIFFERENCE — booleans and undefined are REJECTED, in both drivers', () => {
    // SQLite has no boolean type. The absorbed code already writes `is_beginner ? 1 : 0` at
    // every call site, which is why this is a note rather than a port task — but it is the
    // first thing a new caller gets wrong.
    const db = open();
    const insert = db.prepare('INSERT INTO players (id, display_name, is_beginner) VALUES (?, ?, ?)');

    expect(() => insert.run('carol', 'Carol', true as unknown as number)).toThrow();
    expect(() => insert.run('carol', 'Carol', undefined as unknown as number)).toThrow();
    expect(() => insert.run('carol', 'Carol', 1)).not.toThrow();
  });

  it('binds null, and a null column reads back as null', () => {
    const db = open();

    db.prepare('INSERT INTO games (id, name, weight, bgg_id) VALUES (?, ?, ?, ?)').run(
      'sketch',
      'Paper Sketch',
      null,
      null,
    );

    expect(db.prepare<GameRow>('SELECT * FROM games WHERE id = ?').get('sketch')).toEqual({
      id: 'sketch',
      name: 'Paper Sketch',
      weight: null,
      bgg_id: null,
    });
  });
});

describe('rows are ordinary objects', () => {
  it('DRIVER DIFFERENCE — a raw node:sqlite row has a NULL prototype; a shim row does not', () => {
    // The whole of Object.prototype is missing from a raw row: `hasOwnProperty` is `undefined`
    // and a strict deep-equal against an identical plain object FAILS. Every row this shim
    // returns is spread first, which is what makes the assertions below hold.
    const db = open();

    const raw = db.raw.prepare('SELECT id, name FROM games WHERE id = ?').get('orchard');
    expect(Object.getPrototypeOf(raw)).toBeNull();

    const row = db.prepare<GameRow>('SELECT id, name FROM games WHERE id = ?').get('orchard');
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(row).toStrictEqual({ id: 'orchard', name: 'Orchard' });
    expect(Object.prototype.hasOwnProperty.call(row, 'name')).toBe(true);
  });

  it('gives every row from .all() and .iterate() the same treatment', () => {
    const db = open();

    for (const row of db.prepare('SELECT id FROM games').all()) {
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    }
    for (const row of db.prepare('SELECT id FROM games').iterate()) {
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    }
  });
});

describe('exec and pragma', () => {
  it('runs several statements in one exec', () => {
    const db = open();

    db.exec(`
      INSERT INTO games (id, name) VALUES ('kite', 'Paper Kite');
      INSERT INTO games (id, name) VALUES ('lamp', 'Reading Lamp');
    `);

    expect(db.prepare('SELECT count(*) AS n FROM games').get()).toEqual({ n: 4 });
  });

  it('DRIVER DIFFERENCE — exec() SWALLOWS a row-returning pragma; pragma() does not', () => {
    // The trap this shim's `pragma()` exists to close. `exec` returns `undefined` and throws
    // nothing, so the absorbed `addMissingColumns()` would read an empty column list off a
    // table that has every column, and then try to ALTER TABLE them all back on. Pinned as a
    // characterization test: if a future Node makes `exec` return rows, this fails and somebody
    // gets to simplify.
    const db = open();

    expect(db.raw.exec('PRAGMA table_info(games)')).toBeUndefined();
    expect(db.pragma('table_info(games)')).not.toHaveLength(0);
  });

  it('returns rows for a reading pragma', () => {
    const columns = (open().pragma('table_info(games)') as { name: string }[]).map(
      (row) => row.name,
    );

    expect(columns).toEqual(['id', 'name', 'weight', 'bgg_id']);
  });

  it('actually applies a setting pragma — foreign keys cascade', () => {
    // `foreign_keys` is OFF by default in SQLite, and a pragma that silently did nothing would
    // leave orphaned rows behind forever with every test still green. So assert the EFFECT.
    const db = open();

    db.prepare('INSERT INTO known_games (game_id, player_id, confirmed_at) VALUES (?, ?, ?)').run(
      'orchard',
      'bob',
      '2099-01-01T00:00:00Z',
    );
    db.prepare('DELETE FROM players WHERE id = ?').run('bob');

    expect(db.prepare('SELECT * FROM known_games').all()).toEqual([]);
  });
});

describe('withTransaction', () => {
  it('commits on return, and hands back the body’s value', () => {
    const db = open();
    const inserted = db.withTransaction(() => {
      db.prepare('INSERT INTO games (id, name) VALUES (?, ?)').run('kite', 'Paper Kite');
      return 'kite';
    });

    expect(inserted).toBe('kite');
    expect(db.prepare('SELECT id FROM games WHERE id = ?').get('kite')).toEqual({ id: 'kite' });
  });

  it('rolls back on throw, and re-throws the original error', () => {
    const db = open();

    expect(() =>
      db.withTransaction(() => {
        db.prepare('INSERT INTO games (id, name) VALUES (?, ?)').run('kite', 'Paper Kite');
        throw new Error('the caller changed its mind');
      }),
    ).toThrow('the caller changed its mind');

    expect(db.prepare('SELECT id FROM games WHERE id = ?').get('kite')).toBeUndefined();
    expect(db.raw.isTransaction).toBe(false);
  });

  it('rolls back a plain constraint failure and re-throws it', () => {
    // SQLite's default conflict resolution is ABORT: the statement fails, the TRANSACTION
    // stays open, and it is `withTransaction` that has to undo it.
    const db = open();

    expect(() =>
      db.withTransaction(() => {
        db.prepare('INSERT INTO games (id, name) VALUES (?, ?)').run('kite', 'Paper Kite');
        db.prepare('INSERT INTO games (id, name) VALUES (?, ?)').run('orchard', 'Duplicate');
      }),
    ).toThrow(/UNIQUE constraint failed/);

    expect(db.prepare('SELECT id FROM games WHERE id = ?').get('kite')).toBeUndefined();
    expect(db.raw.isTransaction).toBe(false);
  });

  it('re-throws the ORIGINAL error when SQLite already rolled the transaction back', () => {
    // `INSERT OR ROLLBACK` ends the transaction itself on a conflict — as does a full disk, and
    // as does any `ON CONFLICT ROLLBACK` clause in the schema. An unguarded ROLLBACK would then
    // throw "cannot rollback - no transaction is active" and REPLACE the real error with a
    // meaningless one. That is the debugging session this guard exists to prevent, so the guard
    // gets a test that actually reaches it.
    const db = open();

    expect(() =>
      db.withTransaction(() => {
        db.prepare('INSERT OR ROLLBACK INTO games (id, name) VALUES (?, ?)').run(
          'orchard',
          'Duplicate',
        );
      }),
    ).toThrow(/UNIQUE constraint failed/);

    expect(db.raw.isTransaction).toBe(false);
  });

  it('nests — an inner rollback keeps the outer work, which still commits', () => {
    const db = open();

    db.withTransaction(() => {
      db.prepare('INSERT INTO games (id, name) VALUES (?, ?)').run('kite', 'Paper Kite');

      expect(() =>
        db.withTransaction(() => {
          db.prepare('INSERT INTO games (id, name) VALUES (?, ?)').run('lamp', 'Reading Lamp');
          throw new Error('the inner half failed');
        }),
      ).toThrow('the inner half failed');
    });

    expect(
      db
        .prepare<{ id: string }>('SELECT id FROM games WHERE id IN (?, ?)')
        .all('kite', 'lamp')
        .map((row) => row.id),
    ).toEqual(['kite']);
  });

  it('nests — an outer rollback takes a committed inner one with it', () => {
    const db = open();

    expect(() =>
      db.withTransaction(() => {
        db.withTransaction(() => {
          db.prepare('INSERT INTO games (id, name) VALUES (?, ?)').run('kite', 'Paper Kite');
        });
        throw new Error('the outer half failed');
      }),
    ).toThrow('the outer half failed');

    expect(db.prepare('SELECT id FROM games WHERE id = ?').get('kite')).toBeUndefined();
    expect(db.raw.isTransaction).toBe(false);
  });

  it('nests three deep and leaves no savepoint behind', () => {
    const db = open();

    db.withTransaction(() =>
      db.withTransaction(() =>
        db.withTransaction(() => {
          db.prepare('INSERT INTO games (id, name) VALUES (?, ?)').run('kite', 'Paper Kite');
        }),
      ),
    );

    expect(db.raw.isTransaction).toBe(false);
    expect(db.prepare('SELECT id FROM games WHERE id = ?').get('kite')).toEqual({ id: 'kite' });
  });
});

describe('integers', () => {
  it('reads an ordinary INTEGER as a number', () => {
    expect(open().prepare<GameRow>('SELECT bgg_id FROM games WHERE id = ?').get('orchard')).toEqual({
      bgg_id: 101,
    });
  });

  it('DRIVER DIFFERENCE — an INTEGER past 2^53 THROWS instead of losing precision', () => {
    // better-sqlite3 with `safeIntegers` off converts an int64 to a double and is quietly
    // wrong. node:sqlite refuses. Louder and better, but it IS a behaviour change: a column
    // that used to return a wrong number now stops the request. Nothing absorbed stores an id
    // that large — BGG ids are six digits, every primary key is TEXT — and `setReadBigInts` on
    // `db.raw` is the escape hatch if that ever stops being true.
    const db = open();

    db.exec("INSERT INTO games (id, name, bgg_id) VALUES ('huge', 'Big Number', 9007199254740993)");

    expect(() => db.prepare('SELECT bgg_id FROM games WHERE id = ?').get('huge')).toThrow(
      /too large to be represented as a JavaScript number/,
    );
  });
});
