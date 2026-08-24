// THE DRIVER SHIM — a better-sqlite3-SHAPED facade over `node:sqlite`'s DatabaseSync.
//
// WHY IT EXISTS. `cache.ts` states the constraint this file honours, and it is a rule about
// DEPLOYS, not about performance: "Not better-sqlite3 — a native build inside
// `npm install --omit=dev` turns a missed prebuild into a deploy-time compiler hunt and buys
// nothing at tens of statements per request." The absorbed board-game data layer arrives
// written against better-sqlite3: 104 `prepare(…).get/.all/.run` call sites, 11
// `db.transaction(fn)()`, 3 `db.pragma(…)`. Rewriting all 118 by hand is how a port drifts
// from the behaviour its own tests pin. So the call sites keep their shape and this file
// supplies it — no native dependency, and `better-sqlite3` appears in no package.json.
//
// WHAT IT EMULATES. `prepare` (with `.get` / `.all` / `.run` / `.iterate`), `exec`, `pragma`,
// and `withTransaction`. That is the whole measured surface. Rows come back as PLAIN objects
// and `.get()`/`.all()` are typed `unknown`, both deliberately — see the differences below.
//
// WHAT IT DELIBERATELY DOES NOT EMULATE. Each of these has zero call sites in the code being
// absorbed, and faking one is how a shim grows a second, wronger driver inside it:
//   * `db.transaction(fn)` returning a CALLABLE, with `.deferred` / `.immediate` /
//     `.exclusive` variants. `withTransaction(fn)` runs the body instead of returning a
//     function that runs it. The 11 call sites lose their trailing `()`; nothing else moves.
//   * `db.function()`, `db.aggregate()`, `db.backup()`, `db.loadExtension()`, `db.table()`,
//     `db.serialize()`, `db.unsafeMode()`, `db.defaultSafeIntegers()`.
//   * Statement `.pluck()`, `.expand()`, `.raw()`, `.bind()`, `.columns()`, `.safeIntegers()`,
//     and the `database` / `source` / `reader` / `readonly` / `busy` properties.
//   * The `SqliteError` CLASS. node:sqlite throws its own `Error` with a `.errcode` /
//     `.errstr`; nothing may `instanceof` a better-sqlite3 error type through this shim.
//   * A named-parameter object anywhere but FIRST in the argument list. better-sqlite3 accepts
//     it in any position; this throws, because node:sqlite's own signature demands position
//     one and silently reordering a caller's arguments is worse than refusing them.
//
// THE DIFFERENCES BETWEEN THE TWO DRIVERS, measured on Node v26.7.0. Four are closed here;
// three are not closable and every future port has to know them.
//
//   CLOSED — null-prototype rows. node:sqlite returns `[Object: null prototype] {…}`; the
//   whole Object.prototype is missing, so `row.hasOwnProperty(…)` is `undefined`, and
//   `assert.deepStrictEqual(row, {a: 1})` FAILS against an identical plain object. Every row
//   this shim hands out is spread into a plain object first. That costs one allocation per
//   row and buys back an entire class of "identical values, unequal objects" bug.
//
//   CLOSED — `.run()`'s `changes`. node:sqlite types it `number | bigint`; better-sqlite3
//   types it `number`. Coerced with `Number()`. `lastInsertRowid` stays `number | bigint`,
//   which is what better-sqlite3 says too.
//
//   CLOSED — `db.pragma()`. node:sqlite has no such method, and the obvious substitution is a
//   TRAP: `db.exec('PRAGMA table_info(t)')` returns `undefined` and throws nothing, so
//   `addMissingColumns` would read an empty column list and try to ALTER TABLE every column it
//   knows about, on a database that already has them. `PRAGMA <source>` therefore goes through
//   `prepare().all()`, which serves both shapes — a reading pragma (`table_info(x)`) returns
//   its rows and a setting pragma (`foreign_keys = ON`) returns `[]`, exactly as
//   better-sqlite3's default does. One method, no call site that has to know which kind it has.
//
//   CLOSED — nesting. See `withTransaction` below.
//
//   OPEN — INTEGER out of double range. better-sqlite3 with `safeIntegers` off converts an
//   int64 to a double and LOSES PRECISION silently. node:sqlite THROWS
//   `RangeError [ERR_OUT_OF_RANGE]: Value is too large to be represented as a JavaScript
//   number`. Louder, and better, but it is a behaviour change: a column that only ever held a
//   quietly-wrong number now stops the request. Nothing absorbed stores an id that large —
//   BGG ids are six digits and every primary key is TEXT — and `setReadBigInts` is the escape
//   hatch if that ever stops being true.
//
//   OPEN — a MISSING named parameter. better-sqlite3 throws `Missing named parameter "x"`.
//   node:sqlite binds NULL and carries on. An UNKNOWN one throws in both
//   (`Unknown named parameter 'zzz'`), so a typo in the object is still caught; it is an
//   OMITTED key that goes quiet, and it writes a NULL rather than failing. This shim cannot
//   restore the check without parsing the SQL for its own placeholders, which is a second
//   parser and a worse bug. Know it and grep for it.
//
//   OPEN — `undefined` and booleans bind differently from what you would guess, but IDENTICALLY
//   in both drivers: all three of `undefined`, `true` and `false` are REJECTED. SQLite has no
//   boolean type, so the absorbed code already writes `is_beginner ? 1 : 0` at every call site.
//   Listed because it is the first thing a new caller gets wrong, not because it differs.
//
// TYPING. `.get()` is `unknown` and `.all()` is `unknown[]`, matching better-sqlite3's own
// `@types` defaults — which is what lets the absorbed `…all() as { name: string }[]` casts
// compile untouched. New code should pass the type argument: `prepare<{ name: string }>(…)`.
//
// WHAT THIS DOES NOT REPLACE. `cache.ts` (the derived Plex cache) and `promote.ts` (the durable
// lead-cooldown store) both talk to `DatabaseSync` directly, and both should keep doing it.
// They were written against node:sqlite from the start, so there is no better-sqlite3 shape to
// emulate for them, and `cache.ts` in particular counts its per-row cost out loud — the plain
// -object spread this file pays on every row is exactly what that module does not want. The
// shim is for the ABSORBED layer. A native queuepilot module has no reason to go through it.
// Two habits worth copying FROM those modules when the absorbed layer lands: they cache
// prepared statements at module level (this file deliberately does not, because better-sqlite3
// does not either, and because the absorbed code already hoists its own `const insert =
// db.prepare(…)`), and every export has an `async` signature so the module can move into a
// worker_thread later without touching a caller.
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/** What SQLite will accept as a bound value. `boolean` and `undefined` are absent on purpose:
 * both drivers reject them, and widening this to include them would move a compile error to
 * runtime. */
export type BindValue = null | number | bigint | string | NodeJS.ArrayBufferView;

/** better-sqlite3's `RunResult`, to the letter. `changes` is narrowed to `number` here;
 * `lastInsertRowid` keeps the union because better-sqlite3's own types do. */
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** One compiled statement. `Result` defaults to `unknown` so an existing `as` cast on the
 * result still compiles; name it to get a typed row instead. */
export interface PreparedStatement<Result = unknown> {
  /** The first row, or `undefined` when the query matched nothing. */
  get(...params: readonly (BindValue | Record<string, BindValue>)[]): Result | undefined;
  /** Every row. `[]` when the query matched nothing. */
  all(...params: readonly (BindValue | Record<string, BindValue>)[]): Result[];
  /** Row-at-a-time. Each row is materialized as it is yielded, not up front. */
  iterate(...params: readonly (BindValue | Record<string, BindValue>)[]): IterableIterator<Result>;
  /** For INSERT / UPDATE / DELETE. */
  run(...params: readonly (BindValue | Record<string, BindValue>)[]): RunResult;
  /** The SQL this statement was compiled from. Handy in an error message; better-sqlite3
   * calls the same thing `source`, and this is the one property name that differs. */
  readonly sql: string;
}

export interface SqliteDatabase {
  prepare<Result = unknown>(sql: string): PreparedStatement<Result>;
  /** Run one or more statements for their effect. Returns nothing — better-sqlite3 returns
   * `this` for chaining and no absorbed call site chains. */
  exec(sql: string): void;
  /** `PRAGMA <source>`. Rows for a reading pragma, `[]` for a setting one. Never `exec()` —
   * see the header; `exec` swallows a row-returning pragma and hands back `undefined`. */
  pragma(source: string): unknown[];
  /**
   * Run `body` inside a transaction. Commits on return, rolls back on throw, and re-throws.
   *
   * NESTING. better-sqlite3's `.transaction()` nests through SAVEPOINTs, so this does too —
   * an inner call that throws undoes only its own work and lets the outer one still commit.
   * No absorbed call site nests today: all 11 sit at the top of an exported function, and
   * `saveMerge` — the one function that calls five transactional functions in a row — calls
   * them SEQUENTIALLY and opens no transaction of its own. The support is here anyway
   * because it is eight lines, because `DatabaseSync.isTransaction` makes the "am I already
   * inside one?" test exact rather than a counter this file would have to keep true, and
   * because the flat alternative does not fail gracefully — a plain second `BEGIN` throws
   * `cannot start a transaction within a transaction`, which is a confusing SQLite error
   * arriving at whichever caller happens to be second.
   */
  withTransaction<T>(body: () => T): T;
  close(): void;
  /** The underlying driver, for the handful of things this shim does not wrap (`isTransaction`,
   * `setReadBigInts`, session/changeset APIs). Reach for it knowingly. */
  readonly raw: DatabaseSync;
}

/** A bound value that is a named-parameter OBJECT rather than a scalar. `Uint8Array` is an
 * object too and IS a scalar bind, so the test has to exclude every ArrayBufferView. */
const isNamedParameters = (
  value: BindValue | Record<string, BindValue> | undefined,
): value is Record<string, BindValue> =>
  typeof value === 'object' && value !== null && !ArrayBuffer.isView(value);

/**
 * Split the variadic arguments the way node:sqlite's signature wants them: the named-parameter
 * object first (if there is one), then the anonymous ones.
 *
 * better-sqlite3 lets the object sit anywhere and merges it in; this refuses a later one
 * rather than reordering the caller's arguments behind its back. No absorbed call site mixes
 * the two forms — every one is all-positional or a single object.
 */
const splitParams = (
  params: readonly (BindValue | Record<string, BindValue>)[],
): { named: Record<string, BindValue> | undefined; anonymous: BindValue[] } => {
  const [first, ...rest] = params;

  if (isNamedParameters(first)) {
    for (const later of rest) {
      if (isNamedParameters(later)) {
        throw new TypeError(
          'sqlite shim: a named-parameter object must be the only object argument, and must come first',
        );
      }
    }
    return { named: first, anonymous: rest as BindValue[] };
  }

  for (const later of rest) {
    if (isNamedParameters(later)) {
      throw new TypeError(
        'sqlite shim: a named-parameter object must be the FIRST argument, not a later one',
      );
    }
  }

  return { named: undefined, anonymous: params as BindValue[] };
};

/** node:sqlite hands back null-prototype objects. Spread each one so it is an ordinary object
 * with an ordinary prototype — see the header. `Result` is the caller's claim about the row,
 * exactly as better-sqlite3's `Statement<…, Result>` is. */
const materialize = <Result,>(row: Record<string, unknown>): Result => ({ ...row }) as Result;

class ShimStatement<Result> implements PreparedStatement<Result> {
  readonly #statement: StatementSync;
  readonly sql: string;

  constructor(statement: StatementSync, sql: string) {
    this.#statement = statement;
    this.sql = sql;
  }

  get(...params: readonly (BindValue | Record<string, BindValue>)[]): Result | undefined {
    const { named, anonymous } = splitParams(params);
    const row =
      named === undefined
        ? this.#statement.get(...anonymous)
        : this.#statement.get(named, ...anonymous);

    return row === undefined ? undefined : materialize<Result>(row);
  }

  all(...params: readonly (BindValue | Record<string, BindValue>)[]): Result[] {
    const { named, anonymous } = splitParams(params);
    const rows =
      named === undefined
        ? this.#statement.all(...anonymous)
        : this.#statement.all(named, ...anonymous);

    return rows.map((row) => materialize<Result>(row));
  }

  *iterate(
    ...params: readonly (BindValue | Record<string, BindValue>)[]
  ): IterableIterator<Result> {
    const { named, anonymous } = splitParams(params);
    const rows =
      named === undefined
        ? this.#statement.iterate(...anonymous)
        : this.#statement.iterate(named, ...anonymous);

    for (const row of rows as Iterable<Record<string, unknown>>) {
      yield materialize<Result>(row);
    }
  }

  run(...params: readonly (BindValue | Record<string, BindValue>)[]): RunResult {
    const { named, anonymous } = splitParams(params);
    const result =
      named === undefined
        ? this.#statement.run(...anonymous)
        : this.#statement.run(named, ...anonymous);

    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }
}

class ShimDatabase implements SqliteDatabase {
  readonly raw: DatabaseSync;
  /** Savepoint names have to be unique down a nest, and SQLite scopes them by name — reusing
   * one would release the wrong frame. A monotonic counter is enough; it never wraps in a
   * process's life and it never has to be decremented back. */
  #savepoints = 0;

  constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  prepare<Result = unknown>(sql: string): PreparedStatement<Result> {
    return new ShimStatement<Result>(this.raw.prepare(sql), sql);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  pragma(source: string): unknown[] {
    return this.prepare(`PRAGMA ${source}`).all();
  }

  withTransaction<T>(body: () => T): T {
    if (this.raw.isTransaction) {
      const name = `qp_savepoint_${(this.#savepoints += 1)}`;
      this.raw.exec(`SAVEPOINT ${name}`);

      try {
        const result = body();
        this.raw.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        // ROLLBACK TO leaves the savepoint OPEN — the RELEASE after it is what pops the frame.
        // Skipping it leaves a savepoint the outer COMMIT then has to unwind by accident.
        this.raw.exec(`ROLLBACK TO ${name}`);
        this.raw.exec(`RELEASE ${name}`);
        throw error;
      }
    }

    this.raw.exec('BEGIN');

    try {
      const result = body();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      // Guarded, because some failures (a constraint violation with ON CONFLICT ROLLBACK, a
      // full disk) roll the transaction back themselves. An unguarded ROLLBACK would then
      // throw "cannot rollback - no transaction is active" and REPLACE the real error with a
      // meaningless one.
      if (this.raw.isTransaction) this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }
}

/**
 * Open a database and wrap it.
 *
 * No `mkdirSync` and no schema load here on purpose — this file is the DRIVER, not a
 * migration runner. The caller owns where the file lives and what shape it has.
 */
export const openSqlite = (path: string): SqliteDatabase => new ShimDatabase(new DatabaseSync(path));

/** Wrap a DatabaseSync somebody else opened — a deserialized snapshot, or a handle from a
 * module that already has one. */
export const wrapSqlite = (raw: DatabaseSync): SqliteDatabase => new ShimDatabase(raw);
