// THE ONE-SHOT YAML IMPORT — sets.yaml, queues.yaml, groups.yaml, pending.yaml into the book
// of record.
//
// ── It copies the files aside before it touches anything ─────────────────────────────────
//
// App-Configs holds EIGHTEEN hand-made `.bak-*` files beside these four, every one of them a
// person remembering to `cp` before a risky edit. This replaces that habit with one that runs
// itself: every import writes `store-imports/<utc-timestamp>/` beside the files, with the four
// originals in it, before the first row is written. Only on an import that actually runs, so
// the directory does not grow one entry per container restart.
//
// ── Idempotency, and why it is not "run once and set a flag" ──────────────────────────────
//
// The rule has to answer two situations at once, and the answer is different on each side of
// the bridge.
//
// WHILE THE MIRROR IS ON (this release), the rows and the files are kept in step by every
// write, so a file whose CONTENT has changed can only mean somebody changed it from outside —
// a hand-edit over SMB, which the storage decision says is still supported until the reader
// moves. So the rule is simply: import when the content differs.
//
//   1. Cheap gate: `stat` the four files. Nothing moved → return, no hashing at all. This is
//      on the scan path (`loadEntries` calls it per set) and must not read 30 KB per call.
//   2. Something moved → sha256 the bytes. Same fingerprint as the recorded import → nothing
//      to do; an mtime moved without the content moving is the common case, because OUR OWN
//      mirror write is what moved it.
//   3. Different → copy aside, replace the rows, record the new fingerprint.
//
// `noteMirrorWrite()` is what keeps step 2 from firing on every write: after a successful
// mirror the files and the rows agree by construction, so the fingerprint is re-recorded
// there rather than being re-discovered here.
//
// ⚠️ IF THE MIRROR WRITE FAILS the fingerprint is NOT updated, `writeDoc` throws, and the next
// boot re-reads the YAML — so a store write whose rollback copy could not be written is
// reported as a failed write and is then undone. That is the conservative direction on
// purpose: through the bridge release the two must not be allowed to drift silently.
//
// ONCE THE MIRROR IS OFF (`STORE_YAML_MIRROR=0`) the files are frozen relics of the last
// write, and re-reading one would revert the store to it. So the import runs ONCE per process
// and never re-checks.
//
// ── The wire ids ─────────────────────────────────────────────────────────────────────────
//
// This is the file that carries them across, and it carries them VERBATIM. `importReport()`
// returns every id it wrote so a caller — the tool, the test, the PR — can prove that the 20
// sets, 16 queues and 5 groups that went in are the 20, 16 and 5 that came out, by name.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, parseDocument } from 'yaml';

import { QUEUES_PATH, STORE_YAML_MIRROR } from '../../config.js';
import { errMessage } from '../../errors.js';
import * as yamlGroups from '../groups.js';
import * as yamlPending from '../pending.js';
import * as yamlQueues from '../queues.js';
import { DEFAULT_YAML } from '../sets.js';
import * as yamlSets from '../sets.js';
import { bumpVersion, readMeta, writeMeta, type StoreName } from '../db/common.js';
import { bookOfRecord, prepareChecked } from '../db/open.js';
import { shredListDocument, shredMapOfListsDocument } from '../db/shred.js';
import type { SqliteDatabase } from '../sqlite.js';

/** What one import did. Every count and every id, so the migration can be PROVEN rather than
 * asserted. */
export interface ImportReport {
  imported: boolean;
  reason: string;
  backupDir: string | null;
  setIds: string[];
  queueIds: string[];
  groupIds: string[];
  entryCount: number;
  dismissedCount: number;
  seenThrough: number;
}

const SOURCES = ['sets', 'queues', 'groups', 'pending'] as const;

const pathFor = (source: (typeof SOURCES)[number]): string =>
  source === 'sets'
    ? yamlSets.path
    : source === 'queues'
      ? yamlQueues.path
      : source === 'groups'
        ? yamlGroups.path
        : yamlPending.path;

/** `(mtimeMs, size)` for the four files — the CHEAP gate, so the scan path does not hash. */
function sourceStamp(): string {
  return SOURCES.map((source) => {
    try {
      const stat = statSync(pathFor(source));
      return `${source}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return `${source}:absent`;
    }
  }).join('|');
}

/** sha256 of each file's bytes, or `absent` — the four together are the import fingerprint. */
function fingerprint(): string {
  const parts = SOURCES.map((source) => {
    try {
      return `${source}:${createHash('sha256').update(readFileSync(pathFor(source))).digest('hex')}`;
    } catch {
      return `${source}:absent`;
    }
  });
  return parts.join('|');
}

/** Copy the four files into `store-imports/<utc>/` beside them, before a row is written. */
function copyAside(): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(dirname(QUEUES_PATH), 'store-imports', stamp);
  try {
    mkdirSync(dir, { recursive: true });
    for (const source of SOURCES) {
      const from = pathFor(source);
      if (existsSync(from)) copyFileSync(from, join(dir, `${source}.yaml`));
    }
    return dir;
  } catch (e) {
    // A read-only /config is a real deployment (and several e2e harnesses point at one). The
    // import is still the right thing to do; it just cannot leave a copy behind, and saying so
    // is better than refusing to start.
    console.log(`[store] could not copy the YAML aside into ${dir}: ${errMessage(e)}`);
    return null;
  }
}

const textOf = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

function importSets(db: SqliteDatabase): string[] {
  // No file on a first boot means the built-in registry, parsed straight into rows rather than
  // written out and read back — the mirror puts it on disk at the first mutation.
  const text = textOf(yamlSets.path) ?? DEFAULT_YAML;
  const { rows, leftovers } = shredListDocument(parseDocument(text), 'sets');
  const ids: string[] = [];

  prepareChecked(db, 'DELETE FROM sets').run();
  const insert = prepareChecked(
    db,
    'INSERT INTO sets (id, position, data, comment_before, comment, inner_comments) ' +
      'VALUES (:id, :position, :data, :comment_before, :comment, :inner_comments)',
  );
  for (const row of rows) {
    const id = (row.value as { id?: unknown } | null)?.id;
    if (id == null || String(id) === '') continue;
    insert.run({
      id: String(id),
      position: row.position,
      data: row.data,
      comment_before: row.comment_before,
      comment: row.comment,
      inner_comments: row.inner_comments,
    });
    ids.push(String(id));
  }
  writeMeta(db, 'sets', 'leftovers', JSON.stringify(leftovers));
  return ids;
}

function importQueues(db: SqliteDatabase): { ids: string[]; entries: number } {
  const text = textOf(yamlQueues.path);
  const { groups, leftovers } = shredMapOfListsDocument(parseDocument(text ?? ''));
  const ids: string[] = [];
  let entries = 0;

  prepareChecked(db, 'DELETE FROM queues').run();
  const insertQueue = prepareChecked(
    db,
    'INSERT INTO queues (set_id, position, comment_before, comment, list_comment_before, list_comment) ' +
      'VALUES (:set_id, :position, :comment_before, :comment, :list_comment_before, :list_comment)',
  );
  const insertEntry = prepareChecked(
    db,
    'INSERT INTO queue_entries (set_id, position, data, comment_before, comment, inner_comments) ' +
      'VALUES (:set_id, :position, :data, :comment_before, :comment, :inner_comments)',
  );

  for (const group of groups) {
    insertQueue.run({
      set_id: group.name,
      position: group.position,
      comment_before: group.comments.comment_before,
      comment: group.comments.comment,
      list_comment_before: group.listComments.comment_before,
      list_comment: group.listComments.comment,
    });
    ids.push(group.name);
    for (const row of group.rows) {
      insertEntry.run({
        set_id: group.name,
        position: row.position,
        data: row.data,
        comment_before: row.comment_before,
        comment: row.comment,
        inner_comments: row.inner_comments,
      });
      entries += 1;
    }
  }

  writeMeta(db, 'queues', 'leftovers', JSON.stringify(leftovers));
  return { ids, entries };
}

function importGroups(db: SqliteDatabase): string[] {
  const text = textOf(yamlGroups.path);
  const ids: string[] = [];

  prepareChecked(db, 'DELETE FROM groups').run();
  if (text == null) {
    // Absent is the normal cold start: `groups.ts seedIfMissing()` derives the starter groups
    // from the registry and calls `seed()`. Nothing to import, and nothing to log about.
    return ids;
  }

  const { rows, leftovers } = shredListDocument(parseDocument(text), 'groups');
  const insert = prepareChecked(
    db,
    'INSERT INTO groups (id, position, data, comment_before, comment, inner_comments) ' +
      'VALUES (:id, :position, :data, :comment_before, :comment, :inner_comments)',
  );
  for (const row of rows) {
    const id = (row.value as { id?: unknown } | null)?.id;
    if (id == null || String(id) === '') continue;
    insert.run({
      id: String(id),
      position: row.position,
      data: row.data,
      comment_before: row.comment_before,
      comment: row.comment,
      inner_comments: row.inner_comments,
    });
    ids.push(String(id));
  }
  writeMeta(db, 'groups', 'leftovers', JSON.stringify(leftovers));
  return ids;
}

function importPending(db: SqliteDatabase): { dismissed: number; seenThrough: number } {
  const text = textOf(yamlPending.path);
  const parsed = (text == null ? null : (parse(text) as Partial<{
    seen_through: unknown;
    dismissed: unknown;
    libraries: unknown;
  }> | null)) ?? {};

  const seenThrough = Math.trunc(Number(parsed.seen_through) || 0);
  const dismissed = Array.isArray(parsed.dismissed) ? parsed.dismissed.map(String) : [];
  // Absent stays null — "nobody has chosen" — and only an actual list becomes one. Non-numeric
  // ids are dropped rather than coerced: `Number("Movies")` is NaN, matches no section, and
  // would silently empty the screen.
  const libraries = Array.isArray(parsed.libraries)
    ? parsed.libraries.map(Number).filter((id) => Number.isFinite(id))
    : null;

  prepareChecked(
    db,
    'INSERT INTO pending_state (id, seen_through, libraries) VALUES (1, :seen_through, :libraries) ' +
      'ON CONFLICT (id) DO UPDATE SET seen_through = excluded.seen_through, libraries = excluded.libraries',
  ).run({ seen_through: seenThrough, libraries: libraries === null ? null : JSON.stringify(libraries) });

  prepareChecked(db, 'DELETE FROM pending_dismissed').run();
  const insert = prepareChecked(
    db,
    'INSERT OR REPLACE INTO pending_dismissed (rating_key, position) VALUES (:rating_key, :position)',
  );
  dismissed.forEach((ratingKey, position) => {
    insert.run({ rating_key: ratingKey, position });
  });

  return { dismissed: dismissed.length, seenThrough };
}

const EMPTY_REPORT: Omit<ImportReport, 'imported' | 'reason' | 'backupDir'> = {
  setIds: [],
  queueIds: [],
  groupIds: [],
  entryCount: 0,
  dismissedCount: 0,
  seenThrough: 0,
};

/**
 * Run the import if it is the import's turn. Returns what it did, either way.
 *
 * `force` skips the fingerprint and the version check but NOT the copy-aside — a deliberate
 * re-import is exactly when a copy is most wanted.
 */
export function importYaml({ force = false }: { force?: boolean } = {}): ImportReport {
  const db = bookOfRecord();
  const current = fingerprint();
  const recorded = readMeta(db, 'sets', 'yaml_fingerprint');

  if (!force && recorded === current) {
    return { imported: false, reason: 'the YAML has not changed since the last import', backupDir: null, ...EMPTY_REPORT };
  }

  const backupDir = copyAside();

  const report = db.withTransaction(() => {
    const setIds = importSets(db);
    const queues = importQueues(db);
    const groupIds = importGroups(db);
    const pending = importPending(db);

    for (const store of SOURCES as readonly StoreName[]) bumpVersion(db, store);
    writeMeta(db, 'sets', 'yaml_fingerprint', current);
    writeMeta(db, 'sets', 'yaml_imported_at', new Date().toISOString());

    return {
      imported: true,
      reason: force ? 'forced' : recorded === null ? 'first import' : 'the YAML changed',
      backupDir,
      setIds,
      queueIds: queues.ids,
      groupIds,
      entryCount: queues.entries,
      dismissedCount: pending.dismissed,
      seenThrough: pending.seenThrough,
    } satisfies ImportReport;
  });

  console.log(
    `[store] imported YAML → queuepilot.sqlite: ${report.setIds.length} set(s), ` +
      `${report.queueIds.length} queue(s), ${report.entryCount} entr(ies), ` +
      `${report.groupIds.length} group(s), ${report.dismissedCount} dismissal(s)` +
      (backupDir ? ` — originals copied to ${backupDir}` : ''),
  );

  return report;
}

let done = false;
let lastStamp: string | null = null;

/**
 * The hook every SQLite store calls before a read or a write.
 *
 * Synchronous on purpose: `readSync` is on the scan path and cannot await. The cost of the
 * common call is four `stat`s and a string compare; it only reads and hashes when one of the
 * four files has actually moved.
 *
 * A failure LOGS and gives up rather than throwing — an unreadable `groups.yaml` must not stop
 * the container, which is the policy the file store already had.
 */
export function ensureImported(): void {
  // With the mirror off the files are relics; import once and never look again.
  if (done && !STORE_YAML_MIRROR) return;

  const stamp = sourceStamp();
  if (done && stamp === lastStamp) return;
  done = true;
  lastStamp = stamp;

  try {
    importYaml();
  } catch (e) {
    console.log(`[store] YAML import failed: ${errMessage(e)}`);
  }
}

/**
 * Called after a SUCCESSFUL mirror write: the files now hold what the rows hold, so record
 * that rather than letting the next read discover a "change" it made itself.
 *
 * Not called when the mirror write threw — see the ⚠️ in the header.
 */
export function noteMirrorWrite(): void {
  try {
    writeMeta(bookOfRecord(), 'sets', 'yaml_fingerprint', fingerprint());
    lastStamp = sourceStamp();
    done = true;
  } catch (e) {
    console.log(`[store] could not record the mirror write: ${errMessage(e)}`);
  }
}
