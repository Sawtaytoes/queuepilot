// Opening the book of record, and the one guard that stands between it and silent data loss.
//
// ── The file ─────────────────────────────────────────────────────────────────────────────
//
// `/config/queuepilot.sqlite`. It is NOT `/config/cache.sqlite`, which is derived, wiped on a
// schema bump and safe to `rm`; the two never merge
// (decision 2026-08-23-sqlite-is-the-book-of-record-and-cache-sqlite-stays-derived).
//
// ── The guard ────────────────────────────────────────────────────────────────────────────
//
// `prepareChecked` exists because of WP-4a's driver difference #6, which is the single most
// likely way this migration loses data quietly: node:sqlite binds NULL for a named parameter
// the caller FORGOT, where better-sqlite3 throws `Missing named parameter`. An UNKNOWN key
// still throws in both, so a typo is caught — an omission is not. Every write below goes
// through a statement that asserts its own placeholders are present before it binds.
//
// The shim's own header says it cannot close that difference "without parsing the SQL for its
// own placeholders, which is a second parser and a worse bug", and it is right about the
// general case. This is not the general case: it is a regex over SQL THIS DIRECTORY WROTE, it
// runs at prepare time rather than in a query planner, and it fails closed. `store/db/open.test.ts`
// pins the limitation it does have — a `:name` inside a string literal would be read as a
// placeholder, and none of our statements contain one.
import { readFileSync } from 'node:fs';

import { STORE_PATH } from '../../config.js';
import { errMessage } from '../../errors.js';
import { SCHEMA_SQL } from '../schema.generated.js';
import { openSqlite, type BindValue, type PreparedStatement, type SqliteDatabase } from '../sqlite.js';

/**
 * Bumped when `schema.sql` changes in a way an existing file cannot absorb by itself.
 *
 * Every statement in `schema.sql` is `CREATE … IF NOT EXISTS`, so re-running it over an older
 * file ADDS what is missing and touches nothing that is there. That covers a new table and a
 * new index. It does NOT cover a changed column, which is what this number is for: the day one
 * arrives, `migrate()` gets an `ALTER TABLE` branch keyed on the version it is upgrading FROM.
 *
 * Unlike `cache.ts`, a mismatch here never DROPs. This file holds the household's queues.
 */
export const SCHEMA_VERSION = 1;

/** A `:name` in the SQL, matched over our own statements only — see the header. */
const NAMED_PARAMETER = /[:@$]([A-Za-z_][A-Za-z0-9_]*)/g;

const namedParametersIn = (sql: string): string[] => [
  ...new Set([...sql.matchAll(NAMED_PARAMETER)].map(([, name]) => name as string)),
];

/**
 * `db.prepare(sql)`, plus the check node:sqlite does not do: every `:placeholder` in the SQL
 * must have a key in the bound object.
 *
 * Throws on an OMITTED key rather than writing NULL. The cost is one regex per prepare and one
 * `in` test per placeholder per call, on a store of a few hundred rows.
 */
export function prepareChecked<Result = unknown>(
  db: SqliteDatabase,
  sql: string,
): PreparedStatement<Result> {
  const expected = namedParametersIn(sql);
  const statement = db.prepare<Result>(sql);

  if (expected.length === 0) return statement;

  const assertComplete = (
    params: readonly (BindValue | Record<string, BindValue>)[],
  ): void => {
    const [first] = params;
    if (typeof first !== 'object' || first === null || ArrayBuffer.isView(first)) return;

    const missing = expected.filter((name) => !(name in first));
    if (missing.length > 0) {
      throw new Error(
        `sqlite: missing named parameter(s) ${missing.map((n) => `:${n}`).join(', ')} — ` +
          `node:sqlite would have bound NULL. SQL: ${sql.trim().split('\n')[0]}…`,
      );
    }
  };

  return {
    sql: statement.sql,
    get: (...params) => {
      assertComplete(params);
      return statement.get(...params);
    },
    all: (...params) => {
      assertComplete(params);
      return statement.all(...params);
    },
    iterate: (...params) => {
      assertComplete(params);
      return statement.iterate(...params);
    },
    run: (...params) => {
      assertComplete(params);
      return statement.run(...params);
    },
  };
}

/**
 * Create the schema on a new file, and bring an old one forward.
 *
 * Exported so a test can drive it against a `:memory:` database without going near
 * `STORE_PATH`.
 */
export function migrate(db: SqliteDatabase): void {
  // The whole schema is idempotent, so it runs on every open rather than only on a version
  // bump — that is what makes "add a table" a one-file change with no migration step.
  db.exec(SCHEMA_SQL);

  const row = db
    .prepare<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get();
  const found = row ? Number(row.value) : null;

  if (found !== null && found > SCHEMA_VERSION) {
    // Downgrading is a real scenario — a rollback to the previous image — and it must not
    // silently write rows a newer schema will then misread.
    throw new Error(
      `queuepilot.sqlite is schema ${found}, this build understands ${SCHEMA_VERSION}. ` +
        'Roll forward, or restore the file from a backup taken before the upgrade.',
    );
  }

  if (found !== SCHEMA_VERSION) {
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
    if (found !== null) console.log(`[store] migrated queuepilot.sqlite ${found} → ${SCHEMA_VERSION}`);
  }
}

/** Open a database at `path`, set the pragmas, and put the schema on it. */
export function openBookOfRecord(path: string): SqliteDatabase {
  const db = openSqlite(path);

  // WAL for the same reason `promote.ts` and `cache.ts` use it: a reader is never blocked by
  // the writer, and this process both serves HTTP and runs the scan loop.
  db.exec('PRAGMA journal_mode = WAL');
  // NORMAL, not FULL. A power cut can lose the last transaction; it cannot corrupt the file.
  // The alternative is an fsync per queue reorder on a NAS.
  db.exec('PRAGMA synchronous = NORMAL');
  // Not the default, and the cascade in `queue_entries` depends on it.
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);

  return db;
}

let handle: SqliteDatabase | null = null;

/**
 * The process-wide handle, opened on first use.
 *
 * Lazy rather than at import: `store/index.ts` is imported by every module in the server, and
 * an eager open would create `/config/queuepilot.sqlite` for a harness that only wanted
 * `entryKey()`.
 */
export function bookOfRecord(): SqliteDatabase {
  if (!handle) {
    handle = openBookOfRecord(STORE_PATH);
    console.log(`[store] book of record: ${STORE_PATH}`);
  }
  return handle;
}

/** Close it. For tests and for a clean shutdown; the next call to `bookOfRecord()` reopens. */
export function closeBookOfRecord(): void {
  if (!handle) return;
  try {
    handle.close();
  } catch (e) {
    console.log(`[store] close failed: ${errMessage(e)}`);
  }
  handle = null;
}

/** True when the file exists and has a non-zero size — the "is there anything to read" test the
 * importer asks before it decides to copy the YAML aside. */
export const fileHasBytes = (path: string): boolean => {
  try {
    return readFileSync(path).byteLength > 0;
  } catch {
    return false;
  }
};
