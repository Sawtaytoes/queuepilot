// The set registry, as rows. `sets` + the leftovers in `store_meta`.
//
// Same interface as `store/sets.ts` (SetsStore); everything below is that file's contract
// answered out of the book of record instead of out of `sets.yaml`. Read `store/index.ts`
// first — it says what each method is for and which of them the callers cannot lose.
//
// THE WIRE IDS LIVE HERE. `sets.id` is the text an NFC card carries and the text Home
// Assistant puts in `{"set": "<id>"}`. Nothing in this file generates, normalizes or
// renumbers one; `INSERT … (:id …)` takes what the document held.
import type { Document } from 'yaml';
import { parse, parseDocument } from 'yaml';
import { readFileSync } from 'node:fs';

import { STORE_YAML_MIRROR } from '../../config.js';
import * as yamlSets from '../sets.js';
import type { SetsStore, StoreStat } from '../index.js';
import {
  applyComments,
  bumpVersion,
  nodeAt,
  readJsonMeta,
  versionOf,
  withStoreLock,
  writeMeta,
  YAML_OUT,
} from './common.js';
import { bookOfRecord, prepareChecked } from './open.js';
import { assemble, documentFrom, shredListDocument, type DocumentLeftovers } from './shred.js';
import { ensureImported } from '../migrate/yaml.js';

/** The YAML file's path. Still the store's `path`: `sse.ts` watches its directory, log lines
 * name it, and `engine/routing.ts` passes it back into `readSync` as the "no fixture" default.
 * It is where the mirror is written, not where the truth is. */
export const path = yamlSets.path;

const EMPTY_LEFTOVERS: DocumentLeftovers = {
  order: ['sets'],
  values: {},
  keyComments: {},
  commentBefore: null,
  comment: null,
};

interface SetRow {
  id: string;
  position: number;
  data: string;
  comment_before: string | null;
  comment: string | null;
}

const rows = (): SetRow[] =>
  prepareChecked<SetRow>(
    bookOfRecord(),
    'SELECT id, position, data, comment_before, comment FROM sets ORDER BY position',
  ).all();

const leftovers = (): DocumentLeftovers =>
  readJsonMeta(bookOfRecord(), 'sets', 'leftovers', EMPTY_LEFTOVERS);

/** The parsed registry as the file would have parsed: `{ global: …, sets: [ … ] }`. */
function plain(): Record<string, unknown> {
  const list = rows().map((row) => JSON.parse(row.data) as unknown);
  return assemble(leftovers(), { sets: list });
}

export async function ensureFile(): Promise<void> {
  ensureImported();
}

export async function readDoc(): Promise<Document> {
  ensureImported();
  const setRows = rows();
  const meta = leftovers();
  const doc = documentFrom(
    assemble(meta, { sets: setRows.map((row) => JSON.parse(row.data) as unknown) }),
    meta,
  );
  setRows.forEach((row, index) => {
    applyComments(nodeAt(doc, ['sets', index]), row);
  });
  return doc;
}

/** Shred the document back into rows, then mirror it to YAML while the rollback path is open.
 *
 * DELETE-then-INSERT rather than a diff: the document IS the new state, the table is tens of
 * rows, and the whole thing is one transaction. A diff would have to decide what a moved row
 * is, and getting that wrong loses an entry rather than reordering one. */
export async function writeDoc(doc: Document): Promise<void> {
  const db = bookOfRecord();
  const { rows: shredded, leftovers: meta } = shredListDocument(doc, 'sets');

  db.withTransaction(() => {
    prepareChecked(db, 'DELETE FROM sets').run();
    const insert = prepareChecked(
      db,
      'INSERT INTO sets (id, position, data, comment_before, comment) ' +
        'VALUES (:id, :position, :data, :comment_before, :comment)',
    );
    for (const row of shredded) {
      const id = (row.value as { id?: unknown } | null)?.id;
      // A set with no id has nothing to be addressed by — no card, no MQTT payload, no shelf
      // tile. The YAML reader skipped it silently; skipping it here keeps that behaviour and
      // keeps the CHECK on the table honest.
      if (id == null || String(id) === '') continue;
      insert.run({
        id: String(id),
        position: row.position,
        data: row.data,
        comment_before: row.comment_before,
        comment: row.comment,
      });
    }
    writeMeta(db, 'sets', 'leftovers', JSON.stringify(meta));
    bumpVersion(db, 'sets');
  });

  if (STORE_YAML_MIRROR) await yamlSets.writeDoc(doc);
}

export async function stat(): Promise<StoreStat | null> {
  ensureImported();
  return versionOf(bookOfRecord(), 'sets');
}

export function revision(): string {
  ensureImported();
  const version = versionOf(bookOfRecord(), 'sets');
  return `${Math.round(version.mtimeMs)}-${version.size}`;
}

/**
 * The whole store as one opaque blob, for `history.ts`.
 *
 * ⚠️ THIS IS THE WP-2 ANSWER TO THE WARNING ON `LockedDocumentStore.readRawSnapshot`, and it is
 * the option that record calls "a serialized export of the store's rows (still opaque to the
 * caller, which is why the signature is `string`)". The blob is the store's own YAML
 * projection: rows out, `Document` built, stringified. `history.ts` does not change by a line,
 * `reshapeQueues()` still migrates a pre-2026-08-21 stack entry because it works on text, and
 * `writeRawSnapshot` puts the text back through the same shredder every other write uses — so
 * a restore is exact for everything the store can hold.
 *
 * What it is NOT is byte-for-byte against a HAND-WRITTEN file. A comment that belongs to no
 * row, a flow-style list, a quoting choice: those are gone at the cutover, not at the undo.
 * Undo/redo restores the STORE, and the store no longer holds them. The existing 1.6 MB of
 * `.history.json` is undo depth rather than user data and starts empty after the cutover.
 */
export async function readRawSnapshot(): Promise<string | null> {
  ensureImported();
  return (await readDoc()).toString(YAML_OUT);
}

export async function writeRawSnapshot(text: string): Promise<void> {
  await writeDoc(parseDocument(text));
}

/**
 * Parse the registry synchronously.
 *
 * `file` is the FIXTURE SEAM — `engine/routing.ts loadSets()` passes a path, and every offline
 * e2e harness drives it against a YAML fixture. A path that is not this store's own is read off
 * disk exactly as before; the store's own path means "read the rows".
 */
export function readSync(file: string = path): unknown {
  if (file !== path) return parse(readFileSync(file, 'utf8'));
  ensureImported();
  return plain();
}

export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  return withStoreLock('sets', fn);
}

export const store: SetsStore = {
  path,
  ensureFile,
  readDoc,
  writeDoc,
  stat,
  revision,
  readRawSnapshot,
  writeRawSnapshot,
  readSync,
  withLock,
};
