// Undo/redo for the two data files (queues.yaml + sets.yaml), as raw-text snapshots so
// comments/formatting restore byte-for-byte. Every mutating endpoint snapshots BEFORE it
// writes (server.js withSnapshot); undo pushes the current state onto the redo stack and
// restores the top of the undo stack. The stacks mirror to HISTORY_PATH (a dotfile beside
// queues.yaml) so a container restart keeps history; a persist failure only logs — the
// YAML files themselves are the durable state. The Python prune's writes aren't
// snapshotted: undoing "watched entries pruned" would only re-prune next scan, so nothing
// breaks — user-facing edits are what the buttons are for.
import { promises as fs } from 'node:fs';
import { HISTORY_PATH, QUEUES_PATH } from './config.js';
import { errMessage } from './errors.js';
import { SETS_PATH } from './sets.js';

/**
 * One undo/redo entry: the raw text of both data files at a point in time, or null per file
 * when that file did not exist (`readBoth`'s `.catch(() => null)`), which `writeBoth` then
 * skips rather than restoring an empty file.
 */
interface Snapshot {
  q: string | null;
  s: string | null;
}

const MAX = 50;
let undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];

/**
 * The ONLY validation the persisted stack has ever had: each entry must be a non-null object.
 * Its `q`/`s` are NOT checked — a corrupt entry survives the filter and lands in `writeBoth`,
 * where `text == null` skips the write, so a garbage snapshot restores nothing instead of
 * truncating a data file. Typed honestly as a predicate over that one check rather than
 * pretending the file was schema-validated.
 */
function isSnapshot(s: unknown): s is Snapshot {
  return Boolean(s && typeof s === 'object');
}

// Top-level await, deliberately: the undo stack must be hydrated before the first request can
// snapshot onto it, and this module is imported at boot.
try {
  const saved: unknown = JSON.parse(await fs.readFile(HISTORY_PATH, 'utf8'));
  const stack = (a: unknown): Snapshot[] => (Array.isArray(a) ? a.filter(isSnapshot).slice(-MAX) : []);
  // Not optional-chained: a persisted `null` must throw here exactly as it did before, so the
  // catch below is what starts the stacks empty.
  const persisted = saved as { undo?: unknown; redo?: unknown };
  undoStack = stack(persisted.undo);
  redoStack = stack(persisted.redo);
} catch {
  /* absent or unparsable = start empty */
}

async function persist() {
  const tmp = HISTORY_PATH + '.tmp';
  try {
    await fs.writeFile(tmp, JSON.stringify({ undo: undoStack, redo: redoStack }), 'utf8');
    await fs.rename(tmp, HISTORY_PATH);
  } catch (e) {
    console.log(`[history] persist failed: ${errMessage(e)}`);
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

async function readBoth(): Promise<Snapshot> {
  const read = (p: string) => fs.readFile(p, 'utf8').catch(() => null); // null = file absent
  return { q: await read(QUEUES_PATH), s: await read(SETS_PATH) };
}

async function writeBoth(snap: Snapshot) {
  const write = async (p: string, text: string | null) => {
    if (text == null) return;
    const tmp = p + '.tmp';
    await fs.writeFile(tmp, text, 'utf8');
    try {
      await fs.rename(tmp, p);
    } catch {
      await fs.writeFile(p, text, 'utf8');
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  };
  await write(QUEUES_PATH, snap.q);
  await write(SETS_PATH, snap.s);
}

// Call BEFORE a mutation. Clears the redo stack (a new edit forks history).
export async function snapshot() {
  undoStack.push(await readBoth());
  if (undoStack.length > MAX) undoStack.shift();
  redoStack.length = 0;
  await persist();
}

export async function undo() {
  const snap = undoStack.pop();
  if (!snap) return { ok: false, error: 'nothing to undo' };
  redoStack.push(await readBoth());
  await writeBoth(snap);
  await persist();
  return { ok: true };
}

export async function redo() {
  const snap = redoStack.pop();
  if (!snap) return { ok: false, error: 'nothing to redo' };
  undoStack.push(await readBoth());
  await writeBoth(snap);
  await persist();
  return { ok: true };
}

export const counts = () => ({ undo: undoStack.length, redo: redoStack.length });
