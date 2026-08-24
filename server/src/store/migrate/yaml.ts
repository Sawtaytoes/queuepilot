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
// The rule has to answer two situations at once. A container restart must NOT re-import over
// rows the app has since edited. A hand-edit of `queues.yaml` over SMB, during the bridge
// release, SHOULD still be picked up — the file is still a supported way in until the mirror
// is switched off. So:
//
//   1. Fingerprint the four files (sha256 of the bytes; an absent file has its own marker).
//   2. Same fingerprint as the recorded import? Nothing to do.
//   3. Different, but a store's `version` has moved since its import? The STORE is
//      authoritative — the app has written since — so the YAML is stale and is left alone.
//      Logged loudly, because during the bridge release that means somebody hand-edited a file
//      the app had already moved past.
//   4. Otherwise: copy aside, replace the rows, record the new fingerprint and versions.
//
// Rule 3 is what makes the mirror safe: every store write also writes YAML, so the fingerprint
// changes constantly and only the version check stops an endless re-import.
//
// ── The wire ids ─────────────────────────────────────────────────────────────────────────
//
// This is the file that carries them across, and it carries them VERBATIM. `importReport()`
// returns every id it wrote so a caller — the tool, the test, the PR — can prove that the 20
// sets, 16 queues and 5 groups that went in are the 20, 16 and 5 that came out, by name.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, parseDocument } from 'yaml';

import { QUEUES_PATH } from '../../config.js';
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

/** True when any store has been written since its import — the test that makes the rows, not
 * the files, authoritative once the app has started editing. */
function storeHasMoved(db: SqliteDatabase): StoreName | null {
  for (const store of SOURCES as readonly StoreName[]) {
    const current = Number(readMeta(db, store, 'version') ?? 0);
    const atImport = Number(readMeta(db, store, 'imported_version') ?? -1);
    if (atImport >= 0 && current > atImport) return store;
  }
  return null;
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
    'INSERT INTO sets (id, position, data, comment_before, comment) ' +
      'VALUES (:id, :position, :data, :comment_before, :comment)',
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
    ids.push(group.name);
    for (const row of group.rows) {
      insertEntry.run({
        set_id: group.name,
        position: row.position,
        data: row.data,
        comment_before: row.comment_before,
        comment: row.comment,
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
    'INSERT INTO groups (id, position, data, comment_before, comment) ' +
      'VALUES (:id, :position, :data, :comment_before, :comment)',
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

  if (!force) {
    const moved = storeHasMoved(db);
    if (moved) {
      console.log(
        `[store] the YAML files changed, but the ${moved} store has been written since the last ` +
          'import — the rows are authoritative and the files were NOT re-read',
      );
      return { imported: false, reason: `the ${moved} store has been written since the import`, backupDir: null, ...EMPTY_REPORT };
    }
  }

  const backupDir = copyAside();

  const report = db.withTransaction(() => {
    const setIds = importSets(db);
    const queues = importQueues(db);
    const groupIds = importGroups(db);
    const pending = importPending(db);

    for (const store of SOURCES as readonly StoreName[]) {
      bumpVersion(db, store);
      writeMeta(db, store, 'imported_version', readMeta(db, store, 'version'));
      writeMeta(db, store, 'yaml_fingerprint', current);
    }
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

/**
 * The boot-time hook every SQLite store calls before its first read or write.
 *
 * Synchronous on purpose: `readSync` is on the scan path and cannot await, and the import is
 * four small files read once per process. A failure LOGS and gives up rather than throwing —
 * an unreadable `groups.yaml` must not stop the container, which is the policy the file store
 * already had.
 */
export function ensureImported(): void {
  if (done) return;
  done = true;
  try {
    importYaml();
  } catch (e) {
    console.log(`[store] YAML import failed: ${errMessage(e)}`);
  }
}

/** Let a test drive a second import in the same process. */
export function resetImportedFlagForTests(): void {
  done = false;
}
