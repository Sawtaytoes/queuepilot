// The curated queues, as rows. `queues` (one per top-level key) + `queue_entries` (one per
// line, `position` = play order, TOP plays next).
//
// Same interface as `store/queues.ts` (QueuesStore). Two things about the shape are worth
// stating before the code:
//
//   1. **A QUEUE ROW EXISTS EVEN WHEN IT IS EMPTY.** `queues.yaml` carries keys with nothing
//      under them, and a design that inferred the queue from its entries would delete that
//      line on the first write. That is why `queues` is a table and not just a column on
//      `queue_entries`.
//   2. **AN ENTRY'S `data` IS ITS WHOLE MAPPING**, `{ratingKey, title}` plus any override —
//      not a column per field. `episodes`, `weight`, `start`, `batch_stops_at`, `done` and
//      `done_at` are all optional, all written and cleared by different call sites, and the
//      rule for each is "drop the key when it equals the default". A JSON payload keeps that
//      rule exactly; six nullable columns would turn "the key is absent" and "the column is
//      NULL" into the same thing, and `storedCount(undefined) === null` is a real distinction
//      this app tests for.
import type { Document } from 'yaml';
import { parseDocument } from 'yaml';

import { STORE_YAML_MIRROR } from '../../config.js';
import * as yamlQueues from '../queues.js';
import type { QueuesStore, StoreStat } from '../index.js';
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
import { assemble, documentFrom, shredMapOfListsDocument, type DocumentLeftovers } from './shred.js';
import { ensureImported } from '../migrate/yaml.js';

export const path = yamlQueues.path;

const EMPTY_LEFTOVERS: DocumentLeftovers = {
  order: [],
  values: {},
  keyComments: {},
  commentBefore: null,
  comment: null,
};

interface QueueRow {
  set_id: string;
  position: number;
  comment_before: string | null;
  comment: string | null;
}

interface EntryRow {
  set_id: string;
  position: number;
  data: string;
  comment_before: string | null;
  comment: string | null;
}

const queueRows = (): QueueRow[] =>
  prepareChecked<QueueRow>(
    bookOfRecord(),
    'SELECT set_id, position, comment_before, comment FROM queues ORDER BY position',
  ).all();

const entryRows = (): EntryRow[] =>
  prepareChecked<EntryRow>(
    bookOfRecord(),
    'SELECT set_id, position, data, comment_before, comment FROM queue_entries ' +
      'ORDER BY set_id, position',
  ).all();

const leftovers = (): DocumentLeftovers =>
  readJsonMeta(bookOfRecord(), 'queues', 'leftovers', EMPTY_LEFTOVERS);

/** Entries grouped by queue, each list already in play order. */
function entriesBySet(): Map<string, EntryRow[]> {
  const grouped = new Map<string, EntryRow[]>();
  for (const row of entryRows()) {
    const list = grouped.get(row.set_id);
    if (list) list.push(row);
    else grouped.set(row.set_id, [row]);
  }
  return grouped;
}

/** `{ <setId>: [entry, …] }` — what the file would have parsed to. */
function plain(): Record<string, unknown> {
  const grouped = entriesBySet();
  const byQueue: Record<string, unknown> = {};
  for (const queue of queueRows()) {
    byQueue[queue.set_id] = (grouped.get(queue.set_id) ?? []).map(
      (row) => JSON.parse(row.data) as unknown,
    );
  }
  return assemble(leftovers(), byQueue);
}

export async function readDoc(): Promise<Document> {
  ensureImported();
  const grouped = entriesBySet();
  const queues = queueRows();
  const meta = leftovers();
  const byQueue: Record<string, unknown> = {};
  for (const queue of queues) {
    byQueue[queue.set_id] = (grouped.get(queue.set_id) ?? []).map(
      (row) => JSON.parse(row.data) as unknown,
    );
  }
  const doc = documentFrom(assemble(meta, byQueue), meta);

  for (const queue of queues) {
    // The queue's own comments hang off its KEY node, which is where they were read from.
    const pair = doc.contents && 'items' in doc.contents
      ? (doc.contents.items as { key?: unknown; value?: unknown }[]).find(
          (item) => String((item.key as { toJSON?: () => unknown })?.toJSON?.() ?? item.key) === queue.set_id,
        )
      : undefined;
    if (pair) applyComments(pair.key, queue);

    (grouped.get(queue.set_id) ?? []).forEach((row, index) => {
      applyComments(nodeAt(doc, [queue.set_id, index]), row);
    });
  }

  return doc;
}

export async function writeDoc(doc: Document): Promise<void> {
  const db = bookOfRecord();
  const { groups, leftovers: meta } = shredMapOfListsDocument(doc);

  db.withTransaction(() => {
    // The cascade on `queue_entries.set_id` clears the entries with their queue, so this is
    // one DELETE and not two.
    prepareChecked(db, 'DELETE FROM queues').run();
    const insertQueue = prepareChecked(
      db,
      'INSERT INTO queues (set_id, position, comment_before, comment) ' +
        'VALUES (:set_id, :position, :comment_before, :comment)',
    );
    const insertEntry = prepareChecked(
      db,
      'INSERT INTO queue_entries (set_id, position, data, comment_before, comment) ' +
        'VALUES (:set_id, :position, :data, :comment_before, :comment)',
    );

    for (const group of groups) {
      insertQueue.run({
        set_id: group.name,
        position: group.position,
        comment_before: group.comments.comment_before,
        comment: group.comments.comment,
      });
      for (const row of group.rows) {
        insertEntry.run({
          set_id: group.name,
          position: row.position,
          data: row.data,
          comment_before: row.comment_before,
          comment: row.comment,
        });
      }
    }

    writeMeta(db, 'queues', 'leftovers', JSON.stringify(meta));
    bumpVersion(db, 'queues');
  });

  if (STORE_YAML_MIRROR) await yamlQueues.writeDoc(doc);
}

export async function stat(): Promise<StoreStat | null> {
  ensureImported();
  return versionOf(bookOfRecord(), 'queues');
}

export function revision(): string {
  ensureImported();
  const version = versionOf(bookOfRecord(), 'queues');
  return `${Math.round(version.mtimeMs)}-${version.size}`;
}

/** See the long note on `store/db/sets.ts readRawSnapshot` — same answer, same trade. */
export async function readRawSnapshot(): Promise<string | null> {
  ensureImported();
  return (await readDoc()).toString(YAML_OUT);
}

export async function writeRawSnapshot(text: string): Promise<void> {
  await writeDoc(parseDocument(text));
}

export function readSync(): unknown {
  ensureImported();
  return plain();
}

export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  return withStoreLock('queues', fn);
}

export const store: QueuesStore = {
  path,
  readDoc,
  writeDoc,
  stat,
  revision,
  readRawSnapshot,
  writeRawSnapshot,
  readSync,
  withLock,
};
