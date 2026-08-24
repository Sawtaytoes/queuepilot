// People, as rows: `people` + `person_accounts` + `group_people`.
//
// ── Why this one has no YAML twin ────────────────────────────────────────────────────────
//
// The other four stores exist in two implementations because `STORE_BACKEND=yaml` is the
// rollback for WP-2's cutover. People arrived AFTER the cutover and have never had a file, so
// there is nothing to roll back to and no second implementation to keep in step. A process
// running `STORE_BACKEND=yaml` simply has no people; nothing in the app reads them yet, which
// is what makes that survivable rather than a gap.
//
// ── Every write goes through `prepareChecked` ────────────────────────────────────────────
//
// WP-4a's driver difference #6: node:sqlite binds NULL for a named parameter the caller
// FORGOT, where better-sqlite3 throws. On this table that is not a crash, it is a person whose
// `max_weight` quietly became NULL — which the picker reads as "no ceiling stated" and would
// then offer them a game they will not play. An UNKNOWN key still throws in both drivers, so
// a typo is caught; only an omission is silent, and `prepareChecked` is what closes it.
//
// ── The one thing this file will not do ──────────────────────────────────────────────────
//
// It never MATCHES a person by name. Names arrive already decided, from the owner-confirmed
// mapping file in `store/migrate/people.ts`. There is no `findPersonByName` here and there
// must not be one — a fuzzy match writing the wrong person's known-how claim is the failure
// this whole package is shaped around.
import { normalizeAccounts, type Person, type PersonWrite } from '../../people.js';
import type { ProfileAccounts } from '../../groups.js';
import { bumpVersion, readMeta, writeMeta } from './common.js';
import { bookOfRecord, prepareChecked } from './open.js';
import type { SqliteDatabase } from '../sqlite.js';

interface PersonRow {
  id: string;
  position: number;
  display_name: string;
  birth_year: number | null;
  max_weight: number | null;
  is_beginner: number;
  source: string | null;
  source_id: string | null;
  created_at: string | null;
}

interface AccountRow {
  person_id: string;
  kind: string;
  account: string;
  position: number;
}

const PERSON_COLUMNS =
  'id, position, display_name, birth_year, max_weight, is_beginner, source, source_id, created_at';

/** Accounts for the whole roster in one query, so listing N people is two statements and not
 * N + 1. A household is tens of rows, but the shape is the one WP-5 will lean on. */
function accountsByPerson(db: SqliteDatabase): Map<string, ProfileAccounts> {
  const out = new Map<string, ProfileAccounts>();
  const rows = prepareChecked<AccountRow>(
    db,
    'SELECT person_id, kind, account, position FROM person_accounts ORDER BY person_id, kind, position',
  ).all();
  for (const row of rows) {
    const map = out.get(row.person_id) ?? {};
    (map[row.kind] ??= []).push(row.account);
    out.set(row.person_id, map);
  }
  return out;
}

const toPerson = (row: PersonRow, accounts: ProfileAccounts): Person => ({
  accounts,
  birthYear: row.birth_year,
  createdAt: row.created_at,
  displayName: row.display_name,
  id: row.id,
  isBeginner: row.is_beginner !== 0,
  maxWeight: row.max_weight,
  position: row.position,
  source: row.source,
  sourceId: row.source_id,
});

/** The whole roster, in position order. */
export function listPeople(db: SqliteDatabase = bookOfRecord()): Person[] {
  const accounts = accountsByPerson(db);
  return prepareChecked<PersonRow>(
    db,
    `SELECT ${PERSON_COLUMNS} FROM people ORDER BY position, id`,
  )
    .all()
    .map((row) => toPerson(row, accounts.get(row.id) ?? {}));
}

/** One person by id, or null. */
export function getPerson(id: string, db: SqliteDatabase = bookOfRecord()): Person | null {
  const row = prepareChecked<PersonRow>(
    db,
    `SELECT ${PERSON_COLUMNS} FROM people WHERE id = :id`,
  ).get({ id });
  if (!row) return null;
  const accounts: ProfileAccounts = {};
  for (const account of prepareChecked<AccountRow>(
    db,
    'SELECT person_id, kind, account, position FROM person_accounts WHERE person_id = :id ORDER BY kind, position',
  ).all({ id })) {
    (accounts[account.kind] ??= []).push(account.account);
  }
  return toPerson(row, accounts);
}

/** One person by where they came from — the lookup that makes the import idempotent. */
export function getPersonBySource(
  source: string,
  sourceId: string,
  db: SqliteDatabase = bookOfRecord(),
): Person | null {
  const row = prepareChecked<{ id: string }>(
    db,
    'SELECT id FROM people WHERE source = :source AND source_id = :source_id',
  ).get({ source, source_id: sourceId });
  return row ? getPerson(row.id, db) : null;
}

/**
 * Create or update one person, and REPLACE their account list.
 *
 * An UPSERT on the id, so a re-run of the import is a no-op rather than a duplicate. A field
 * the caller omits keeps its stored value — `COALESCE(:x, column)` — because the mapping file
 * is allowed to be partial and an omission there means "leave it alone", not "clear it".
 *
 * ⚠️ `accounts` is the exception and is deliberately all-or-nothing: pass it and the person's
 * whole account list is replaced, omit it and the stored list is untouched. A per-account
 * merge would make removing an account impossible through this door.
 *
 * Not transactional by itself. Callers that write several people wrap the lot, so a half-run
 * import is never committed.
 */
export function upsertPerson(person: PersonWrite, db: SqliteDatabase = bookOfRecord()): void {
  const id = String(person.id ?? '').trim();
  if (!id) throw new Error('a person needs an id');

  prepareChecked(
    db,
    // The three COALESCEs in the VALUES are what let a partial write reach a NOT NULL column:
    // `position`, `display_name` and `is_beginner` all have defaults, and passing NULL to one
    // on a FIRST insert would be refused rather than defaulted.
    `INSERT INTO people (${PERSON_COLUMNS}) VALUES (
       :id, COALESCE(:position, 0), COALESCE(:display_name, ''), :birth_year, :max_weight,
       COALESCE(:is_beginner, 0), :source, :source_id, :created_at
     )
     ON CONFLICT (id) DO UPDATE SET
       position     = COALESCE(:position, people.position),
       display_name = COALESCE(:display_name, people.display_name),
       birth_year   = :birth_year,
       max_weight   = :max_weight,
       is_beginner  = COALESCE(:is_beginner, people.is_beginner),
       source       = COALESCE(:source, people.source),
       source_id    = COALESCE(:source_id, people.source_id),
       created_at   = COALESCE(people.created_at, :created_at)`,
  ).run({
    birth_year: person.birthYear ?? null,
    created_at: person.createdAt ?? null,
    display_name: person.displayName ?? null,
    id,
    is_beginner: person.isBeginner === undefined ? null : person.isBeginner ? 1 : 0,
    max_weight: person.maxWeight ?? null,
    position: person.position ?? null,
    source: person.source ?? null,
    source_id: person.sourceId ?? null,
  });

  // `display_name` and `is_beginner` are NOT NULL with defaults, so a first INSERT that passed
  // NULL for either would have been refused. Fill them here rather than branching the SQL.
  prepareChecked(
    db,
    "UPDATE people SET display_name = :display_name WHERE id = :id AND display_name = ''",
  ).run({ display_name: id, id });

  if (person.accounts !== undefined) setPersonAccounts(id, person.accounts, db);
}

/** Replace one person's provider accounts. Empty kinds are dropped, never written as `[]`. */
export function setPersonAccounts(
  personId: string,
  accounts: ProfileAccounts,
  db: SqliteDatabase = bookOfRecord(),
): void {
  prepareChecked(db, 'DELETE FROM person_accounts WHERE person_id = :person_id').run({
    person_id: personId,
  });
  const insert = prepareChecked(
    db,
    'INSERT OR REPLACE INTO person_accounts (person_id, kind, account, position) ' +
      'VALUES (:person_id, :kind, :account, :position)',
  );
  for (const [kind, names] of Object.entries(normalizeAccounts(accounts))) {
    names.forEach((account, position) => {
      insert.run({ account, kind, person_id: personId, position });
    });
  }
}

/** Remove a person. `person_accounts` and `group_people` cascade; nothing else references one
 * yet, and WP-5's queue keying will need its own answer here rather than a cascade. */
export function deletePerson(id: string, db: SqliteDatabase = bookOfRecord()): boolean {
  const result = prepareChecked(db, 'DELETE FROM people WHERE id = :id').run({ id });
  return Number(result.changes) > 0;
}

// ── Groups as saved sets of people ────────────────────────────────────────────────────── //

/** One group's roster, in roster order. Ids only — the caller joins if it wants the people. */
export function groupPersonIds(
  groupId: string,
  db: SqliteDatabase = bookOfRecord(),
): string[] {
  return prepareChecked<{ person_id: string }>(
    db,
    'SELECT person_id FROM group_people WHERE group_id = :group_id ORDER BY position, person_id',
  )
    .all({ group_id: groupId })
    .map((row) => row.person_id);
}

/** Every group's roster at once, keyed by group id. */
export function rostersByGroup(db: SqliteDatabase = bookOfRecord()): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of prepareChecked<{ group_id: string; person_id: string }>(
    db,
    'SELECT group_id, person_id FROM group_people ORDER BY group_id, position, person_id',
  ).all()) {
    out.set(row.group_id, [...(out.get(row.group_id) ?? []), row.person_id]);
  }
  return out;
}

/**
 * Replace one group's roster. The list IS the order.
 *
 * A person id that names nobody is REFUSED rather than written — the foreign key would refuse
 * it anyway, and failing here names the id in the message instead of leaving the caller with
 * `FOREIGN KEY constraint failed`.
 */
export function setGroupPeople(
  groupId: string,
  personIds: readonly string[],
  db: SqliteDatabase = bookOfRecord(),
): void {
  const known = new Set(
    prepareChecked<{ id: string }>(db, 'SELECT id FROM people').all().map((row) => row.id),
  );
  const missing = personIds.filter((id) => !known.has(id));
  if (missing.length) {
    throw new Error(`group '${groupId}' names ${missing.length} unknown person id(s): ${missing.join(', ')}`);
  }

  prepareChecked(db, 'DELETE FROM group_people WHERE group_id = :group_id').run({
    group_id: groupId,
  });
  const insert = prepareChecked(
    db,
    'INSERT OR REPLACE INTO group_people (group_id, person_id, position) ' +
      'VALUES (:group_id, :person_id, :position)',
  );
  personIds.forEach((personId, position) => {
    insert.run({ group_id: groupId, person_id: personId, position });
  });
}

/**
 * Group ids in `group_people` that no longer have a row in `groups` — the report that stands
 * in for the foreign key the schema deliberately does not have.
 *
 * ⚠️ Under `STORE_BACKEND=yaml` the `groups` TABLE is empty by design, so every group id would
 * look orphaned. Callers must treat a non-empty answer as a thing to LOOK AT, never as a thing
 * to delete.
 */
export function orphanGroupIds(db: SqliteDatabase = bookOfRecord()): string[] {
  return prepareChecked<{ group_id: string }>(
    db,
    'SELECT DISTINCT gp.group_id FROM group_people gp ' +
      'LEFT JOIN groups g ON g.id = gp.group_id WHERE g.id IS NULL ORDER BY gp.group_id',
  )
    .all()
    .map((row) => row.group_id);
}

// ── bookkeeping ───────────────────────────────────────────────────────────────────────── //

/** Record that the people store changed. Call INSIDE the transaction that wrote the rows. */
export const bumpPeopleVersion = (db: SqliteDatabase = bookOfRecord()): void =>
  bumpVersion(db, 'people');

export const readPeopleMeta = (key: string, db: SqliteDatabase = bookOfRecord()): string | null =>
  readMeta(db, 'people', key);

export const writePeopleMeta = (
  key: string,
  value: string | null,
  db: SqliteDatabase = bookOfRecord(),
): void => writeMeta(db, 'people', key, value);
