// `prepareChecked` — the guard over WP-4a's OPEN driver difference #6.
//
// node:sqlite binds NULL for a named parameter the caller FORGOT; better-sqlite3 throws
// `Missing named parameter`. An UNKNOWN key throws in both, so a typo is caught either way —
// it is an OMISSION that goes quiet, and it writes a NULL rather than failing. That is the
// single most likely way a data migration loses a column without anybody noticing, and the
// shim's own header says it cannot close it "without parsing the SQL for its own
// placeholders, which is a second parser and a worse bug".
//
// This IS that parser, deliberately kept to a regex, and the last test here pins the
// limitation that buys: a `:name` inside a SQL string literal is read as a placeholder. No
// statement in `store/db/` contains one, and this is where a future one would be caught.
import { describe, expect, it } from 'vitest';

import { migrate, prepareChecked, SCHEMA_VERSION } from './open.js';
import { openSqlite, type SqliteDatabase } from '../sqlite.js';

const fresh = (): SqliteDatabase => {
  const db = openSqlite(':memory:');
  migrate(db);
  return db;
};

describe('prepareChecked', () => {
  it('THROWS on an omitted named parameter, where the raw driver would bind NULL', () => {
    const db = fresh();
    const sql = 'INSERT INTO store_meta (store, key, value) VALUES (:store, :key, :value)';

    expect(() => prepareChecked(db, sql).run({ store: 'sets', key: 'a' })).toThrow(
      /missing named parameter\(s\) :value/,
    );

    // The characterization, so the reason this guard exists is visible in the test file: the
    // UNGUARDED statement accepts the same call and writes a NULL.
    db.prepare(sql).run({ store: 'sets', key: 'a' } as never);
    const row = db.prepare<{ value: string | null }>(
      "SELECT value FROM store_meta WHERE store = 'sets' AND key = 'a'",
    ).get();
    expect(row?.value).toBeNull();

    db.close();
  });

  it('still lets an UNKNOWN key through to the driver, which throws on its own', () => {
    const db = fresh();
    expect(() =>
      prepareChecked(db, 'INSERT INTO store_meta (store, key, value) VALUES (:store, :key, :value)').run({
        store: 'sets',
        key: 'a',
        value: 'b',
        typo: 'c',
      }),
    ).toThrow(/Unknown named parameter/);
    db.close();
  });

  it('passes a complete object through untouched', () => {
    const db = fresh();
    prepareChecked(db, 'INSERT INTO store_meta (store, key, value) VALUES (:store, :key, :value)').run({
      store: 'sets',
      key: 'a',
      value: 'b',
    });
    expect(
      prepareChecked<{ value: string }>(db, 'SELECT value FROM store_meta WHERE key = :key').get({ key: 'a' })?.value,
    ).toBe('b');
    db.close();
  });

  it('does not interfere with positional parameters', () => {
    const db = fresh();
    db.prepare("INSERT INTO store_meta (store, key, value) VALUES ('sets', ?, ?)").run('k', 'v');
    expect(
      prepareChecked<{ value: string }>(db, 'SELECT value FROM store_meta WHERE key = ?').get('k')?.value,
    ).toBe('v');
    db.close();
  });

  it('LIMITATION: a colon inside a string literal reads as a placeholder', () => {
    // Documented rather than fixed. Closing it needs a real SQL tokenizer, which is the second
    // parser the shim's header warns about; refusing the statement is the safe failure, and no
    // statement in this directory has one. If you add one, this test is why it broke.
    const db = fresh();
    expect(() =>
      prepareChecked(db, "SELECT * FROM store_meta WHERE value = 'a:b' AND key = :key").get({ key: 'k' }),
    ).toThrow(/missing named parameter\(s\) :b/);
    db.close();
  });
});

describe('migrate', () => {
  it('brings an older file forward by ALTERing in the columns it is missing', () => {
    // The stale-scratch-database case, which is how this was found: a suite that passes on a
    // fresh CI runner throws `no such column` locally, against a file an earlier run left.
    const db = openSqlite(':memory:');
    db.exec('CREATE TABLE sets (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL)');
    migrate(db);

    const columns = (db.pragma('table_xinfo(sets)') as { name: string }[]).map((row) => row.name);
    expect(columns).toContain('presentation');
    expect(columns).toContain('label');

    // …TWICE. `table_info` omits a GENERATED column, so reading the column list with it makes
    // every generated column look missing on the second open and throws `duplicate column
    // name` — a container that starts once and then will not restart.
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });

  it('records the schema version and is safe to run again', () => {
    const db = fresh();
    migrate(db);
    migrate(db);
    const row = db.prepare<{ value: string }>(
      "SELECT value FROM schema_meta WHERE key = 'schema_version'",
    ).get();
    expect(Number(row?.value)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('REFUSES a file written by a newer build rather than writing rows it may misread', () => {
    const db = fresh();
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION + 1),
    );
    expect(() => migrate(db)).toThrow(/Roll forward, or restore the file/);
    db.close();
  });

  it('refuses a set row whose id disagrees with its payload', () => {
    // The CHECK is what stops a wire id drifting away from the mapping that carries it.
    const db = fresh();
    expect(() =>
      prepareChecked(db, 'INSERT INTO sets (id, position, data) VALUES (:id, :position, :data)').run({
        id: 'bob',
        position: 0,
        data: JSON.stringify({ id: 'alice', label: 'Alice' }),
      }),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('cascades a queue delete to its entries and never the other way', () => {
    const db = fresh();
    prepareChecked(db, 'INSERT INTO queues (set_id, position) VALUES (:set_id, :position)').run({
      set_id: 'bob',
      position: 0,
    });
    prepareChecked(
      db,
      'INSERT INTO queue_entries (set_id, position, data) VALUES (:set_id, :position, :data)',
    ).run({ set_id: 'bob', position: 0, data: JSON.stringify({ ratingKey: '1', title: 'A' }) });

    db.exec("DELETE FROM queues WHERE set_id = 'bob'");
    expect(db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM queue_entries').get()?.n).toBe(0);
    db.close();
  });

  it('exposes the generated columns as real, queryable columns', () => {
    const db = fresh();
    prepareChecked(db, 'INSERT INTO sets (id, position, data) VALUES (:id, :position, :data)').run({
      id: 'bob',
      position: 0,
      data: JSON.stringify({ id: 'bob', label: 'Bob — Movies', kind: 'picks', source: 'queue' }),
    });
    const row = db.prepare<{ label: string; kind: string }>(
      "SELECT label, kind FROM sets WHERE source = 'queue'",
    ).get();
    expect(row).toEqual({ label: 'Bob — Movies', kind: 'picks' });
    db.close();
  });

  it('reads a numeric ratingKey back as TEXT, so no INTEGER can reach the 2^53 cliff', () => {
    // WP-4a driver difference #5: node:sqlite THROWS RangeError past 2^53 where better-sqlite3
    // lost the precision quietly. A Plex ratingKey is a numeric STRING; the column's TEXT
    // affinity is what keeps a legacy numeric one from ever being read as an INTEGER.
    const db = fresh();
    prepareChecked(db, 'INSERT INTO queues (set_id, position) VALUES (:set_id, :position)').run({
      set_id: 'bob',
      position: 0,
    });
    prepareChecked(
      db,
      'INSERT INTO queue_entries (set_id, position, data) VALUES (:set_id, :position, :data)',
    ).run({ set_id: 'bob', position: 0, data: JSON.stringify({ ratingKey: 361504, title: 'B' }) });

    const row = db.prepare<{ rating_key: unknown }>('SELECT rating_key FROM queue_entries').get();
    expect(row?.rating_key).toBe('361504');
    db.close();
  });
});
