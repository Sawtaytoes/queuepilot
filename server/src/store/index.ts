// THE STORE SEAM — the one place that knows where QueuePilot's durable state lives and how
// to read and write it.
//
// ── What is behind it ────────────────────────────────────────────────────────────────────
//
//   store.sets      sets.yaml     the set registry: every queue and every pool
//   store.queues    queues.yaml   the curated queues' ordered entries
//   store.groups    groups.yaml   who is watching, and which provider accounts each of them is
//   store.pending   pending.yaml  the Pending watermark, the per-item dismissals, the libraries
//
// ── What is NOT ──────────────────────────────────────────────────────────────────────────
//
// `cache.ts` is the DERIVED Plex cache — deletable, rebuildable, and deliberately not the
// store (decision 2026-08-03-sqlite-is-a-derived-plex-cache-not-the-store). `promote.ts`'s
// cooldown DB and the two `providers*.yaml` files keep their own readers for now; provider
// TOKENS in particular have their own 0600 file and their own rules
// (decision 2026-08-12-provider-tokens-live-in-a-separate-config-file), so folding them in
// here would be a decision, not a refactor. `history.ts`'s `.history.json` is an undo mirror
// of two of the files above, so it reads and writes THROUGH this seam rather than living
// behind it.
//
// ── Why it exists ────────────────────────────────────────────────────────────────────────
//
// Every body under `store/` was MOVED here out of `sets.ts`, `queues.ts`, `groups.ts` and
// `pending.ts`, unchanged. Nothing about the bytes on disk changed and nothing about the app's
// behaviour changed. The point is the boundary: outside this directory nothing names a `.yaml`
// path, takes a lock, or writes a file. `sets.ts` and `queues.ts` are the two largest modules
// in the repo and are edited by several branches at once, so a data-layer swap that reached
// into them line by line would conflict with all of them. Behind a seam it is a second
// implementation of the interfaces below instead.
//
// ── WP-2 landed, and this is what it did ─────────────────────────────────────────────────
//
// There are now TWO implementations of every interface below, and `STORE_BACKEND` picks one:
//
//   sqlite  (default)  `store/db/*` over `/config/queuepilot.sqlite`, the book of record.
//   yaml               `store/{sets,queues,groups,pending}.ts` — WP-1's, unchanged. THE
//                      ROLLBACK. One env var and a restart puts the four files back in charge.
//
// The SQLite store keeps WRITING the YAML files for this release (`STORE_YAML_MIRROR`), which
// is what makes that rollback real rather than theoretical. After this release the files are
// an import bridge and nothing else. `store/migrate/yaml.ts` is that bridge: one-shot,
// idempotent, and it copies all four files aside before it writes a row.
//
// Three things had to survive the swap, and they are why the interfaces have the shape they
// do. All three did:
//
//   1. **Wire ids do not change.** A set id is the primary key TEXT, migrated verbatim. NFC
//      cards and Home Assistant's MQTT `{"set": "<id>"}` payloads reference it, so a re-keyed
//      row is a dead card on the wall.
//   2. **The comment-preserving round-trip is a contract, not a detail.** `sets.yaml`,
//      `queues.yaml` and `groups.yaml` are hand-edited over SMB. For as long as YAML is a
//      supported read path, `readDoc`/`writeDoc` go through the `yaml` `Document` API and
//      never `parse` + `stringify`; `e2e/yaml-roundtrip-test.ts` gates it.
//   3. **`readSync` stays.** The engine's read side is synchronous on the scan path
//      (`engine/routing.ts loadSets`, `engine/resolve.ts loadEntries`). The SQLite store
//      answers it with `node:sqlite`'s synchronous API, exactly as this note predicted; an
//      interface that were async-only would have forced those two call sites open.
//
// ── The one interface that could not be answered by a query ──────────────────────────────
//
// `readRawSnapshot` / `writeRawSnapshot`, called out below and in `history.ts`. The SQLite
// store answers them with a SERIALIZED EXPORT OF ITS OWN ROWS — the document it would have
// written, stringified — which is the option the warning names and the only one that leaves
// `history.ts` untouched. Undo/redo therefore survives at the store's fidelity rather than the
// file's: everything a row can hold restores exactly, and a comment that belongs to no row was
// already gone at the cutover rather than lost at the undo. The 1.6 MB of existing
// `.history.json` is undo DEPTH, not user data, and starting the stacks empty costs nothing.
//
// ── `store/sqlite.ts` is not one of these ────────────────────────────────────────────────
//
// It arrived from WP-4a and is the better-sqlite3-shaped DRIVER shim over `node:sqlite` —
// `prepare` / `exec` / `pragma` / `withTransaction`. It is what the SQLite implementation in
// `store/db/` is written ON; it does not implement these interfaces and it knows nothing about
// sets, queues, groups or pending. `store/db/open.ts` adds the one guard the shim's own header
// says it cannot: a named parameter the caller FORGOT binds NULL in node:sqlite instead of
// throwing, so every write in `store/db/` goes through `prepareChecked`.
//
// ── One asymmetry, on purpose ────────────────────────────────────────────────────────────
//
// The three `Document` stores expose `readDoc`/`writeDoc`; `pending` exposes `read`/`write`
// over a plain state object. `pending.yaml` is written whole every time and has no
// hand-authored structure to preserve, so giving it a document API would be inventing a
// requirement WP-2 then has to keep.
import type { Document } from 'yaml';

import { STORE_BACKEND } from '../config.js';
import * as groupsStore from './groups.js';
import * as pendingStore from './pending.js';
import * as queuesStore from './queues.js';
import * as setsStore from './sets.js';
// The SQLite implementations. They import the interfaces below with `import type`, so the
// cycle this reads like is erased at compile time and there is no runtime one.
import { store as sqliteGroups } from './db/groups.js';
import { store as sqlitePending } from './db/pending.js';
import { store as sqliteQueues } from './db/queues.js';
import { store as sqliteSets } from './db/sets.js';

export type { PendingState } from './pending.js';

/** A file's `(mtimeMs, size)` — what the two registry memos are keyed on. */
export interface StoreStat {
  mtimeMs: number;
  size: number;
}

/** What every store can say about its own backing file. */
export interface FileStore {
  /**
   * Where the file is.
   *
   * Exposed because two callers genuinely need the path rather than the contents: `sse.ts`
   * watches the containing directory, and log lines name the file. Nothing else should read
   * it, and nothing should open it.
   */
  readonly path: string;
}

/** A YAML file the app round-trips through the comment-preserving `Document` API. */
export interface DocumentStore extends FileStore {
  /** Parse the file into a `Document`, seeding or synthesizing an empty one as that store does. */
  readDoc(): Promise<Document>;
  /** Serialize and write it back, atomically where the mount allows it. */
  writeDoc(doc: Document): Promise<void>;
}

/**
 * A `DocumentStore` a second process also writes, so every mutation runs under a
 * cross-process advisory lock. `sets.yaml` and `queues.yaml` are both in this class;
 * `groups.yaml` is not, and never was.
 */
export interface LockedDocumentStore extends DocumentStore {
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** `(mtimeMs, size)`, or null when the file is not there yet. */
  stat(): Promise<StoreStat | null>;
  /** The same pair as an ETag-shaped string. A stat, not a read. */
  revision(): string;
  /**
   * The WHOLE store as one opaque blob, or null when there is nothing stored yet. `history.ts`
   * takes one before every mutating request and restores it byte for byte on undo.
   *
   * ⚠️ This is the pair WP-2 cannot satisfy by translating a query. A SQLite store has no text
   * to snapshot, so it must either export its rows into an opaque blob or undo/redo becomes a
   * redesign. The plan's "fold `.history.json` in, it is only 7 KB" is right about the size and
   * wrong about the cost. It is named here so that answer is deliberate.
   */
  readRawSnapshot(): Promise<string | null>;
  /** Put a snapshot back, byte for byte. */
  writeRawSnapshot(text: string): Promise<void>;
}

/** The set registry's file. `readSync` takes a path because the offline e2e harnesses drive
 * `engine/routing.ts loadSets()` against a fixture. */
export interface SetsStore extends LockedDocumentStore {
  ensureFile(): Promise<void>;
  readSync(file?: string): unknown;
}

/** The curated queues' file. */
export interface QueuesStore extends LockedDocumentStore {
  readSync(): unknown;
}

/**
 * The groups file. Optional, unlocked, and forgiving: `readSync` logs and returns `{}` rather
 * than throwing, because losing the web UI to a stray comma in an optional config file is the
 * worse failure.
 */
export interface GroupsStore extends DocumentStore {
  readSync(): Record<string, unknown>;
  exists(): Promise<boolean>;
  seed(groups: readonly unknown[]): Promise<boolean>;
}

/** The Pending decisions file — a state object, not a document. */
export interface PendingStore extends FileStore {
  read(): Promise<pendingStore.PendingState>;
  write(next: pendingStore.PendingState): Promise<void>;
}

export interface Store {
  sets: SetsStore;
  queues: QueuesStore;
  groups: GroupsStore;
  pending: PendingStore;
  /**
   * Every file whose change should repaint an open tab, for `sse.ts`'s directory watcher.
   *
   * All three are hand-edited over SMB, so a group added there has to reach an open tab the
   * same way a renamed queue does. `pending.yaml` is deliberately absent: it is written only
   * by the app's own Pending screen, which already repaints on its own action.
   */
  watchTargets(): string[];
}

function watchTargets(): string[] {
  // Still the three YAML paths under either backend. The SQLite store mirrors them, so a
  // change on disk is still what an open tab has to hear about — and under the `yaml` backend
  // they are the state itself. When the mirror is switched off this list becomes the empty
  // set and `sse.ts`'s watcher goes with it; that is a change for the release that removes the
  // bridge, not for this one.
  return [queuesStore.path, setsStore.path, groupsStore.path];
}

/**
 * The seam, bound to whichever implementation `STORE_BACKEND` names.
 *
 * The import of `./db/*` is STATIC rather than conditional. A dynamic import would make every
 * method async at the seam and would hide a broken SQLite store from `tsc`; the cost of
 * loading it under `STORE_BACKEND=yaml` is a module that opens no database, because
 * `bookOfRecord()` is lazy and nothing calls it.
 */
export const store: Store =
  STORE_BACKEND === 'yaml'
    ? {
        sets: setsStore,
        queues: queuesStore,
        groups: groupsStore,
        pending: pendingStore,
        watchTargets,
      }
    : {
        sets: sqliteSets,
        queues: sqliteQueues,
        groups: sqliteGroups,
        pending: sqlitePending,
        watchTargets,
      };
