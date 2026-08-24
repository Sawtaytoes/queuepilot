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
// ── What WP-2 does to it ─────────────────────────────────────────────────────────────────
//
// It adds `store/schema.sql` and a SQLite implementation of these interfaces, plus
// `store/migrate/yaml.ts` — a one-shot, idempotent import of the four files that copies each
// one aside before it runs. The seam is then cut over one store at a time, with YAML kept as
// a write-through rollback path for one release and as an import bridge after that. Three
// things must survive the swap, and they are stated here because they are why the interfaces
// have the shape they do:
//
//   1. **Wire ids do not change.** A set id is the primary key TEXT, migrated verbatim. NFC
//      cards and Home Assistant's MQTT `{"set": "<id>"}` payloads reference it, so a re-keyed
//      row is a dead card on the wall.
//   2. **The comment-preserving round-trip is a contract, not a detail.** `sets.yaml`,
//      `queues.yaml` and `groups.yaml` are hand-edited over SMB. For as long as YAML is a
//      supported read path, `readDoc`/`writeDoc` go through the `yaml` `Document` API and
//      never `parse` + `stringify`; `e2e/yaml-roundtrip-test.ts` gates it.
//   3. **`readSync` stays.** The engine's read side is synchronous on the scan path
//      (`engine/routing.ts loadSets`, `engine/resolve.ts loadEntries`). A SQLite store answers
//      it with `node:sqlite`'s synchronous API; an interface that were async-only would force
//      those two call sites open, and they are in the hottest code in the app.
//
// ── One asymmetry, on purpose ────────────────────────────────────────────────────────────
//
// The three `Document` stores expose `readDoc`/`writeDoc`; `pending` exposes `read`/`write`
// over a plain state object. `pending.yaml` is written whole every time and has no
// hand-authored structure to preserve, so giving it a document API would be inventing a
// requirement WP-2 then has to keep.
import type { Document } from 'yaml';

import * as groupsStore from './groups.js';
import * as pendingStore from './pending.js';
import * as queuesStore from './queues.js';
import * as setsStore from './sets.js';

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
  return [queuesStore.path, setsStore.path, groupsStore.path];
}

export const store: Store = {
  sets: setsStore,
  queues: queuesStore,
  groups: groupsStore,
  pending: pendingStore,
  watchTargets,
};
