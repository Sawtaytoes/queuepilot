// queues.yaml — the FILE behind the curated queues.
//
// Moved out of `queues.ts` verbatim: the cross-process lock, the comment- and
// order-preserving `Document` round-trip, and the atomic write. What stayed in `queues.ts`
// is everything that reads or edits the parsed document — `entryKey`, the entry readers,
// `seqFor`, the mutations, the `listAll` memo. The split is "who touches the disk".
//
// The lock is on DISK rather than in memory, and that is the oldest constraint in this file.
// It was built that way because two writers shared this path: this editor and a Python
// `queue_builder.queues.prune` in a sibling process. That writer was deleted in `7bf01e0` and
// only `cast_sidecar/` is tracked Python now, which never opens this file. The mkdir lock on
// `<queues.yaml>.lock` stays because it still earns its keep — every mutation in `queues.ts` is
// an async read-modify-write over the whole document, and it survives a crashed holder (see
// LOCK_STALE_MS), which a language-level mutex cannot.
import { promises as fs, readFileSync, statSync } from 'node:fs';
import { parse, parseDocument } from 'yaml';
import type { Document } from 'yaml';
import { QUEUES_PATH } from '../config.js';
import { isNodeError } from '../errors.js';

/** Where the file is. Named `path` so no caller outside `store/` spells a `.yaml` constant. */
export const path = QUEUES_PATH;

const LOCK_DIR = path + '.lock';
const LOCK_STALE_MS = 15000; // a holder older than this is presumed dead; steal the lock
const LOCK_WAIT_MS = 10000; // give up acquiring after this
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

async function acquireLock(): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(LOCK_DIR);
      return;
    } catch (e) {
      if (!isNodeError(e) || e.code !== 'EEXIST') throw e;
      // Steal a stale lock (a crashed holder that never rmdir'd).
      try {
        const st = await fs.stat(LOCK_DIR);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.rmdir(LOCK_DIR).catch(() => {});
          continue;
        }
      } catch {
        /* lock vanished between mkdir and stat — retry */
      }
      if (Date.now() > deadline) throw new Error('timed out acquiring queues.yaml lock');
      await sleep(50);
    }
  }
}

async function releaseLock(): Promise<void> {
  await fs.rmdir(LOCK_DIR).catch(() => {});
}

export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await acquireLock();
  try {
    return await fn();
  } finally {
    await releaseLock();
  }
}

export async function readDoc(): Promise<Document> {
  let text = '';
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (e) {
    if (!isNodeError(e) || e.code !== 'ENOENT') throw e;
  }
  const doc: Document = parseDocument(text);
  if (!doc.contents || typeof doc.get !== 'function') doc.contents = doc.createNode({});
  return doc;
}

// The emit style the file on disk is already written in, so an edit rewrites the line it
// touched and nothing else. It came from ruamel.yaml, which is what the retired Python writer
// used: `indentSeq: false` puts block dashes at the key's indent (ruamel offset=0), and
// `lineWidth: 0` disables wrapping so long titles and comments stay on one line. Changing
// either would reflow the whole household file on the next save.
const YAML_OUT = { indentSeq: false, lineWidth: 0 };

export async function writeDoc(doc: Document): Promise<void> {
  const text = doc.toString(YAML_OUT);
  const tmp = path + '.tmp';
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.rename(tmp, path); // atomic on the same filesystem
  } catch {
    // A single-file bind-mount rejects rename-over (EBUSY); fall back to in-place write.
    await fs.writeFile(path, text, 'utf8');
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * The file's `(mtimeMs, size)`, or null when it is not there yet.
 *
 * Moved from `queues.ts listAll()`, which memoizes every set's entries on this pair. Any
 * writer — this process, or an SMB hand-edit, which is the only other one left — moves at
 * least one of the two.
 */
export async function stat(): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const st = await fs.stat(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** The same pair as a string, for the `/api/queues` ETag. A stat, not a read. */
export function revision(): string {
  try {
    const st = statSync(path);
    return `${Math.round(st.mtimeMs)}-${st.size}`;
  } catch {
    return '0-0';
  }
}

/**
 * The WHOLE store as one opaque blob, for `history.ts`'s undo/redo stack.
 *
 * Not a read: `readText()` would suggest a cheaper cousin of `readDoc()`, and this is neither
 * cheap nor partial. It is the entire store at a point in time, taken before a mutation and
 * restored byte for byte — which is the only way an undo can bring back the comment somebody
 * typed over SMB and the blank line they left under it.
 *
 * ⚠️ THIS IS THE PAIR THAT DOES NOT SURVIVE WP-2 FOR FREE. A SQLite store has no text to
 * snapshot, so satisfying this interface means one of: a serialized export of the store's rows
 * (still opaque to the caller, which is why the signature is `string` and not a document), or a
 * redesign of undo/redo onto row-level journalling. The plan calls folding `.history.json` in
 * "7 KB, the smallest reader in the set"; the size is right and the conclusion is not. Keeping
 * the capability NAMED here is the point — WP-2 has to answer it deliberately rather than
 * discover it when undo silently stops restoring formatting.
 */
export async function readRawSnapshot(): Promise<string | null> {
  return fs.readFile(path, 'utf8').catch(() => null);
}

/** Put a snapshot back, byte for byte. Same atomic tmp+rename as `writeDoc`, same fallback. */
export async function writeRawSnapshot(text: string): Promise<void> {
  const tmp = path + '.tmp';
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.rename(tmp, path);
  } catch {
    await fs.writeFile(path, text, 'utf8');
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * Parse the whole file SYNCHRONOUSLY, and THROW rather than decide what a failure means.
 *
 * The engine's read side (`engine/resolve.ts loadEntries`) is synchronous and runs on every
 * scan. It owns the error policy — an absent file means "no entries" there — so this returns
 * the parse and nothing else.
 */
export function readSync(): unknown {
  return parse(readFileSync(path, 'utf8'));
}
