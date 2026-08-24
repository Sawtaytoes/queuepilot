// What all four SQLite stores share: the meta rows, the write counter, the comment carrying,
// and the mutex that replaces the YAML advisory lock.
//
// ── The mutex ────────────────────────────────────────────────────────────────────────────
//
// `sets.yaml` and `queues.yaml` are guarded by a mkdir-based CROSS-PROCESS lock, because a
// second writer — the Python `queue_builder.queues.prune` — shared the files. That writer is
// gone (decision 2026-08-12-python-is-gone-except-the-cast-sidecar; the only Python left in
// the image is the ~100-line cast sidecar, which does not touch the store). What `withLock`
// still has to do is serialize this process's own read-modify-write pairs, and an in-process
// promise chain does that exactly, with no filesystem round trip and no 15-second stale-lock
// heuristic that can steal a lock from a slow write.
//
// It is deliberately a queue and not a `try`: every caller expects to WAIT for its turn, the
// way it waited for the mkdir.
//
// ── The version counter ──────────────────────────────────────────────────────────────────
//
// `stat()` and `revision()` exist so `sets.ts` and `queues.ts` can memoize a parse on
// `(mtimeMs, size)` and so `/api/queues` can answer an ETag. With rows there is no mtime, so
// the pair becomes `(updated_at_ms, version)` — a counter incremented inside the same
// transaction as the write it describes. That is strictly better than the file pair it
// replaces: two writes inside one millisecond that happen to produce the same file size are
// indistinguishable to a stat and are two different versions here.
import { isNode, type Document, type Node } from 'yaml';

import { prepareChecked } from './open.js';
import type { SqliteDatabase } from '../sqlite.js';

/** Match the `yaml` writer the four YAML stores use, so the mirror files do not churn:
 * `indentSeq: false` puts block dashes at the key's indent, `lineWidth: 0` never wraps. */
export const YAML_OUT = { indentSeq: false, lineWidth: 0 } as const;

/** Which store a `store_meta` row belongs to. */
export type StoreName = 'sets' | 'queues' | 'groups' | 'pending';

/** The two comment slots the `yaml` Document API gives a node, as they are stored. */
export interface RowComments {
  comment_before: string | null;
  comment: string | null;
}

/** Read a node's comments. A non-node (a plain value that never became a node) has none. */
export const commentsOf = (node: unknown): RowComments =>
  isNode(node)
    ? { comment_before: node.commentBefore ?? null, comment: node.comment ?? null }
    : { comment_before: null, comment: null };

/** Put them back on a node built from a row. Assigning `undefined` rather than `null` is what
 * the `yaml` writer treats as "no comment"; a null would print an empty `#`. */
export function applyComments(node: unknown, row: RowComments): void {
  if (!isNode(node)) return;
  if (row.comment_before != null) node.commentBefore = row.comment_before;
  if (row.comment != null) node.comment = row.comment;
}

/** The node at `path` inside a document, or undefined. `true` asks for the NODE rather than
 * its value, which is the only form that carries comments. */
export const nodeAt = (doc: Document, path: readonly unknown[]): Node | undefined =>
  doc.getIn(path, true) as Node | undefined;

// ── store_meta ────────────────────────────────────────────────────────────────────────── //

export function readMeta(db: SqliteDatabase, store: StoreName, key: string): string | null {
  const row = prepareChecked<{ value: string | null }>(
    db,
    'SELECT value FROM store_meta WHERE store = :store AND key = :key',
  ).get({ store, key });
  return row?.value ?? null;
}

export function writeMeta(
  db: SqliteDatabase,
  store: StoreName,
  key: string,
  value: string | null,
): void {
  prepareChecked(
    db,
    'INSERT INTO store_meta (store, key, value) VALUES (:store, :key, :value) ' +
      'ON CONFLICT (store, key) DO UPDATE SET value = excluded.value',
  ).run({ store, key, value });
}

/** A meta row that holds JSON, parsed. Returns `fallback` when absent or unparsable — a
 * corrupt meta row must not take the app down over a comment. */
export function readJsonMeta<T>(db: SqliteDatabase, store: StoreName, key: string, fallback: T): T {
  const raw = readMeta(db, store, key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ── the version counter ───────────────────────────────────────────────────────────────── //

/** `(updated_at_ms, version)` — what `stat()` returns and what `revision()` prints. */
export interface StoreVersion {
  mtimeMs: number;
  size: number;
}

export function versionOf(db: SqliteDatabase, store: StoreName): StoreVersion {
  return {
    mtimeMs: Number(readMeta(db, store, 'updated_at_ms') ?? 0),
    size: Number(readMeta(db, store, 'version') ?? 0),
  };
}

/** Increment the counter. Call INSIDE the transaction that wrote the rows, so a rolled-back
 * write does not leave a version claiming it happened. */
export function bumpVersion(db: SqliteDatabase, store: StoreName): void {
  const next = Number(readMeta(db, store, 'version') ?? 0) + 1;
  writeMeta(db, store, 'version', String(next));
  writeMeta(db, store, 'updated_at_ms', String(Date.now()));
}

// ── the mutex ─────────────────────────────────────────────────────────────────────────── //

const tails = new Map<StoreName, Promise<unknown>>();

/** Run `fn` after every earlier caller for this store has finished, and before every later
 * one. Rejections are contained: the chain moves on with `.catch`, so one failed mutation
 * does not wedge the queue behind it. */
export function withStoreLock<T>(store: StoreName, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(store) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  tails.set(
    store,
    next.catch(() => undefined),
  );
  return next;
}
