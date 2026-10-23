// A person's photo, as one row in `person_photos`.
//
// The bytes stored here are ALWAYS the server's own re-encode (`personPhoto.ts
// normalizePersonPhoto`), never what a browser uploaded — this module is the storage half and
// trusts its caller to have done that. The table's CHECKs are the backstop: a mime outside the
// three image types, an empty blob, or one over 1 MiB is refused by SQLite itself.
//
// Why a row and not a file: `schema.sql` says it at the table, and the decision record
// `2026-10-22-a-person-photo-is-a-row-in-the-book-of-record` says it at length.
import type { SqliteDatabase } from '../sqlite.js';
import { bookOfRecord, prepareChecked } from './open.js';

export interface PersonPhoto {
  personId: string;
  mime: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  /** The ETag value, unquoted — a hash prefix of `bytes`. */
  version: string;
  updatedAt: string;
}

interface PhotoRow {
  person_id: string;
  mime: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  version: string;
  updated_at: string;
}

/** One person's photo, bytes included, or null when they have none. */
export function readPersonPhoto(
  personId: string,
  db: SqliteDatabase = bookOfRecord(),
): PersonPhoto | null {
  const row = prepareChecked<PhotoRow>(
    db,
    'SELECT person_id, mime, bytes, width, height, version, updated_at FROM person_photos WHERE person_id = :person_id',
  ).get({ person_id: personId });
  return row
    ? {
        bytes: row.bytes,
        height: row.height,
        mime: row.mime,
        personId: row.person_id,
        updatedAt: row.updated_at,
        version: row.version,
        width: row.width,
      }
    : null;
}

/**
 * Every person's photo VERSION, without the bytes — what `/api/people` projects.
 *
 * One statement for the roster rather than one per person, and the BLOB column is never
 * selected: a list read must not drag every picture through the process to answer "who has
 * one".
 */
export function photoVersionsByPerson(
  db: SqliteDatabase = bookOfRecord(),
): Map<string, string> {
  const rows = prepareChecked<{ person_id: string; version: string }>(
    db,
    'SELECT person_id, version FROM person_photos',
  ).all();
  return new Map(rows.map((row) => [row.person_id, row.version]));
}

/** Set or replace one person's photo. The caller has already checked the person exists — the
 *  foreign key refuses the write if they do not. */
export function writePersonPhoto(
  photo: Omit<PersonPhoto, 'updatedAt'> & { updatedAt?: string },
  db: SqliteDatabase = bookOfRecord(),
): void {
  prepareChecked(
    db,
    `INSERT INTO person_photos (person_id, mime, bytes, width, height, version, updated_at)
     VALUES (:person_id, :mime, :bytes, :width, :height, :version, :updated_at)
     ON CONFLICT (person_id) DO UPDATE SET
       mime = excluded.mime,
       bytes = excluded.bytes,
       width = excluded.width,
       height = excluded.height,
       version = excluded.version,
       updated_at = excluded.updated_at`,
  ).run({
    bytes: photo.bytes,
    height: photo.height,
    mime: photo.mime,
    person_id: photo.personId,
    updated_at: photo.updatedAt ?? new Date().toISOString(),
    version: photo.version,
    width: photo.width,
  });
}

/** Remove one person's photo. True when there was one to remove. */
export function deletePersonPhoto(
  personId: string,
  db: SqliteDatabase = bookOfRecord(),
): boolean {
  const result = prepareChecked(
    db,
    'DELETE FROM person_photos WHERE person_id = :person_id',
  ).run({ person_id: personId });
  return Number(result.changes) > 0;
}
