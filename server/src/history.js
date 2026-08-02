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
import { SETS_PATH } from './sets.js';

const MAX = 50;
let undoStack = [];
let redoStack = [];

try {
  const saved = JSON.parse(await fs.readFile(HISTORY_PATH, 'utf8'));
  const stack = (a) => (Array.isArray(a) ? a.filter((s) => s && typeof s === 'object').slice(-MAX) : []);
  undoStack = stack(saved.undo);
  redoStack = stack(saved.redo);
} catch {
  /* absent or unparsable = start empty */
}

async function persist() {
  const tmp = HISTORY_PATH + '.tmp';
  try {
    await fs.writeFile(tmp, JSON.stringify({ undo: undoStack, redo: redoStack }), 'utf8');
    await fs.rename(tmp, HISTORY_PATH);
  } catch (e) {
    console.log(`[history] persist failed: ${e.message}`);
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

async function readBoth() {
  const read = (p) => fs.readFile(p, 'utf8').catch(() => null); // null = file absent
  return { q: await read(QUEUES_PATH), s: await read(SETS_PATH) };
}

async function writeBoth(snap) {
  const write = async (p, text) => {
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
