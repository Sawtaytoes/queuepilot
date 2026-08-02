// Read/modify the shared queues.yaml with comment- and order-preserving round-trips
// (the `yaml` Document API), guarded by a CROSS-PROCESS lock that the Python prune also
// takes. Both writers (this Node editor + queue_builder.queues.prune) run in the same
// container but as separate processes, so the Python threading lock can't cover us — a
// mkdir-based advisory lock on `<queues.yaml>.lock` does (see queue_builder/queues.py).
import { promises as fs } from 'node:fs';
import { parseDocument, YAMLSeq, Scalar } from 'yaml';
import { QUEUES_PATH } from './config.js';

const LOCK_DIR = QUEUES_PATH + '.lock';
const LOCK_STALE_MS = 15000; // a holder older than this is presumed dead; steal the lock
const LOCK_WAIT_MS = 10000; // give up acquiring after this
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquireLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(LOCK_DIR);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
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

async function releaseLock() {
  await fs.rmdir(LOCK_DIR).catch(() => {});
}

async function withLock(fn) {
  await acquireLock();
  try {
    return await fn();
  } finally {
    await releaseLock();
  }
}

// Stable identity for an entry — MUST match queue_builder.queues.entry_key so the two
// writers address the same lines. `value` is a plain-JS entry (scalar or {ratingKey,title}).
export function entryKey(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.ratingKey != null) return `rk:${value.ratingKey}`;
    if (value.title) return `title:${String(value.title).trim()}`;
    return null;
  }
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return `rk:${s}`;
  return s ? `title:${s}` : null;
}

// A finished entry is KEPT and tagged by the Python service as a `{title/ratingKey, done: true}`
// mapping (decision: keep+tag rather than auto-prune). A plain string, a bare ratingKey, or a
// mapping without `done:true` is NOT done. Handles both on-disk shapes so a legacy plain entry
// simply reads as not-done.
export function entryDone(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.done === true);
}

async function readDoc() {
  let text = '';
  try {
    text = await fs.readFile(QUEUES_PATH, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const doc = parseDocument(text);
  if (!doc.contents || typeof doc.get !== 'function') doc.contents = doc.createNode({});
  return doc;
}

function seqFor(doc, setName) {
  let seq = doc.get(setName);
  if (!(seq instanceof YAMLSeq)) {
    seq = new YAMLSeq();
    doc.set(setName, seq);
  }
  return seq;
}

// Match the Python/ruamel writer's style so the file doesn't churn as the two writers
// alternate: `indentSeq: false` puts block dashes at the key's indent (ruamel offset=0),
// `lineWidth: 0` disables wrapping so long titles/comments stay on one line.
const YAML_OUT = { indentSeq: false, lineWidth: 0 };

async function writeDoc(doc) {
  const text = doc.toString(YAML_OUT);
  const tmp = QUEUES_PATH + '.tmp';
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.rename(tmp, QUEUES_PATH); // atomic on the same filesystem
  } catch {
    // A single-file bind-mount rejects rename-over (EBUSY); fall back to in-place write.
    await fs.writeFile(QUEUES_PATH, text, 'utf8');
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

// Ordered raw entries for one set: [{ key, value }]. `value` is plain JS (scalar or object).
export async function listSet(setName) {
  const doc = await readDoc();
  const seq = doc.get(setName);
  if (!(seq instanceof YAMLSeq)) return [];
  return seq.items
    .map((node) => {
      const value = node.toJSON();
      return { key: entryKey(value), value, done: entryDone(value) };
    })
    .filter((e) => e.key !== null);
}

// Remove EVERY done entry from a set's list (the "Remove all completed" button). Done entries
// are the ones the Python service kept + tagged after they finished; this is the ONLY path
// that drops them (never automatic). Returns the count removed.
export async function removeCompleted(setName) {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(setName);
    if (!(seq instanceof YAMLSeq)) return { removed: 0 };
    const before = seq.items.length;
    seq.items = seq.items.filter((n) => !entryDone(n.toJSON()));
    const removed = before - seq.items.length;
    if (removed) {
      if (seq.items.length === 0) seq.flow = true; // restore a compact `[]` when emptied
      await writeDoc(doc);
    }
    return { removed };
  });
}

// Add a new entry. `value` is a string (title), a number (ratingKey), or {ratingKey,title}.
// `position` is 'top' (default — top plays next) or 'bottom'. Set-name validity is the
// caller's (server.js) job — it checks against the live sets.yaml registry.
export async function addItem(setName, value, position = 'top') {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = seqFor(doc, setName);
    const key = entryKey(value);
    if (!key) throw new Error('empty entry');
    if (seq.items.some((n) => entryKey(n.toJSON()) === key)) return { added: false, key };
    seq.flow = false; // a populated queue is always a block list, never `[ ... ]`
    // Force double-quoted title strings so a `:` (e.g. "Star Trek: ...") stays readable.
    let node;
    if (typeof value === 'string') {
      node = doc.createNode(value);
      if (node instanceof Scalar) node.type = Scalar.QUOTE_DOUBLE;
    } else {
      node = doc.createNode(value);
    }
    if (position === 'bottom') seq.items.push(node);
    else seq.items.unshift(node);
    await writeDoc(doc);
    return { added: true, key };
  });
}

export async function removeItem(setName, key) {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(setName);
    if (!(seq instanceof YAMLSeq)) return { removed: false };
    const before = seq.items.length;
    seq.items = seq.items.filter((n) => entryKey(n.toJSON()) !== key);
    if (seq.items.length === before) return { removed: false };
    if (seq.items.length === 0) seq.flow = true; // restore a compact `[]` when emptied
    await writeDoc(doc);
    return { removed: true };
  });
}

function applyOrder(seq, keys) {
  const rank = new Map(keys.map((k, i) => [k, i]));
  const withKeys = seq.items.map((n, i) => ({ n, k: entryKey(n.toJSON()), i }));
  withKeys.sort((a, b) => {
    const ra = rank.has(a.k) ? rank.get(a.k) : keys.length + a.i;
    const rb = rank.has(b.k) ? rank.get(b.k) : keys.length + b.i;
    return ra - rb;
  });
  seq.items = withKeys.map((x) => x.n);
}

// Move an entry from one set to another (cross-queue drag), placing it per `toKeys` (the
// target set's desired key order incl. the moved entry). Same-set → a plain reorder. The
// actual YAML node is relocated, so its formatting/inline comment travels with it. Atomic:
// both sets live in one document, mutated under a single lock + one write.
export async function moveItem(fromSet, toSet, key, toKeys) {
  if (fromSet === toSet) return reorder(toSet, toKeys);
  return withLock(async () => {
    const doc = await readDoc();
    const src = doc.get(fromSet);
    if (!(src instanceof YAMLSeq)) return { moved: false };
    const idx = src.items.findIndex((n) => entryKey(n.toJSON()) === key);
    if (idx < 0) return { moved: false };
    const [node] = src.items.splice(idx, 1);
    if (src.items.length === 0) src.flow = true; // source emptied → compact `[]`
    const dst = seqFor(doc, toSet);
    dst.flow = false;
    if (!dst.items.some((n) => entryKey(n.toJSON()) === key)) dst.items.push(node);
    applyOrder(dst, toKeys);
    await writeDoc(doc);
    return { moved: true };
  });
}

// Bulk-move many entries (possibly from several source sets) into `toSet`, appended in the
// given order. One lock + one write, so a multi-select move is atomic. Entries already in
// `toSet` are left in place. `items` = [{fromSet, key}].
export async function moveBulk(items, toSet) {
  return withLock(async () => {
    const doc = await readDoc();
    const dst = seqFor(doc, toSet);
    let moved = 0;
    for (const { fromSet, key } of items) {
      if (fromSet === toSet) continue;
      const src = doc.get(fromSet);
      if (!(src instanceof YAMLSeq)) continue;
      const i = src.items.findIndex((n) => entryKey(n.toJSON()) === key);
      if (i < 0) continue;
      const [node] = src.items.splice(i, 1);
      if (src.items.length === 0) src.flow = true;
      if (!dst.items.some((n) => entryKey(n.toJSON()) === key)) {
        dst.flow = false;
        dst.items.push(node);
        moved += 1;
      }
    }
    if (moved) await writeDoc(doc);
    return { moved };
  });
}

// Bulk-remove entries across sets. `items` = [{fromSet, key}]. One lock + one write.
export async function removeBulk(items) {
  return withLock(async () => {
    const doc = await readDoc();
    let removed = 0;
    for (const { fromSet, key } of items) {
      const src = doc.get(fromSet);
      if (!(src instanceof YAMLSeq)) continue;
      const before = src.items.length;
      src.items = src.items.filter((n) => entryKey(n.toJSON()) !== key);
      if (src.items.length < before) {
        removed += 1;
        if (src.items.length === 0) src.flow = true;
      }
    }
    if (removed) await writeDoc(doc);
    return { removed };
  });
}

// An entry as {identity, extras}: `identity` is the ratingKey/title that makes the entry
// addressable, `extras` is every OTHER field the file carries (episodes, start, done, a
// hand-written `collection:`, …). Rewrites keep the extras, so setting one override never
// silently drops another writer's field.
function splitEntry(cur) {
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
    const { ratingKey = null, title = null, ...extras } = cur;
    return { ratingKey, title, extras };
  }
  const s = String(cur).trim();
  if (/^\d+$/.test(s)) return { ratingKey: s, title: null, extras: {} };
  return { ratingKey: null, title: String(cur), extras: {} };
}

// Rebuild an entry node from its identity + extras, collapsing to the plainest form (a bare
// title string / ratingKey scalar) when there are no extras left to carry.
function entryNode(doc, { ratingKey, title, extras }) {
  const keys = Object.keys(extras).filter((k) => extras[k] != null);
  if (!keys.length) {
    if (title != null && ratingKey == null) {
      const node = doc.createNode(title);
      // Force a double-quoted title so a `:` (e.g. "Star Trek: …") stays readable.
      if (node instanceof Scalar) node.type = Scalar.QUOTE_DOUBLE;
      return node;
    }
    if (ratingKey != null && title == null) {
      return doc.createNode(/^\d+$/.test(String(ratingKey)) ? Number(ratingKey) : ratingKey);
    }
  }
  const o = {};
  if (ratingKey != null) o.ratingKey = ratingKey;
  if (title != null) o.title = title;
  for (const k of keys) o[k] = extras[k];
  return doc.createNode(o);
}

// Replace one entry in a set, addressed by its stable key. `mutate({ratingKey,title,extras})`
// edits the split form in place; the node is rebuilt from the result.
async function rewriteEntry(setName, key, mutate) {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(setName);
    if (!(seq instanceof YAMLSeq)) return false;
    const idx = seq.items.findIndex((node) => entryKey(node.toJSON()) === key);
    if (idx < 0) return false;
    const split = splitEntry(seq.items[idx].toJSON());
    mutate(split);
    seq.items[idx] = entryNode(doc, split);
    seq.flow = false;
    await writeDoc(doc);
    return true;
  });
}

// Set a series entry's per-show `episodes` (episodes queued per play). Rewrites the entry as
// a mapping carrying its ratingKey/title identity + `episodes` (or drops the field / reverts
// to a bare scalar when set back to 1). Entry identity (key) is unchanged.
export async function setEpisodes(setName, key, episodes) {
  const n = Math.max(1, Math.min(parseInt(episodes, 10) || 1, 20));
  const ok = await rewriteEntry(setName, key, (e) => {
    if (n > 1) e.extras.episodes = n;
    else delete e.extras.episodes;
  });
  return ok ? { ok: true, episodes: n } : { ok: false };
}

// Normalize a manual START point off the wire. A SHOW start is {season, episode}; a
// COLLECTION start also names the member to begin at — `series` is that member's ratingKey
// (a hand-written YAML entry may name it by title instead), and season/episode are optional
// (a movie member has neither). Anything without a series AND without an episode is "no
// start" — i.e. back to automatic next-unwatched.
export function normalizeStart(start) {
  if (!start || typeof start !== 'object') return null;
  const hasSeries = start.series != null && String(start.series).trim() !== '';
  if (!hasSeries && start.episode == null) return null;
  const s = {};
  if (hasSeries) s.series = String(start.series).trim();
  if (start.episode != null) {
    s.season = Math.max(1, parseInt(start.season, 10) || 1);
    s.episode = Math.max(1, parseInt(start.episode, 10) || 1);
  }
  return s;
}

// Set (or clear) an entry's manual START floor — begin here, skipping earlier episodes (and,
// for a collection, earlier members) WITHOUT marking anything watched. Preserves the entry's
// identity and every other field it carries; pass start=null to revert to automatic.
export async function setStart(setName, key, start) {
  const s = normalizeStart(start);
  const ok = await rewriteEntry(setName, key, (e) => {
    if (s) e.extras.start = s;
    else delete e.extras.start;
  });
  return ok ? { ok: true, start: s } : { ok: false };
}

// Drop a deleted queue's whole YAML key (used by DELETE /api/sets/:id so a removed queue
// doesn't leave an orphaned list behind). Missing key = fine.
export async function deleteSetKey(setName) {
  return withLock(async () => {
    const doc = await readDoc();
    if (!doc.has(setName)) return { deleted: false };
    doc.delete(setName);
    await writeDoc(doc);
    return { deleted: true };
  });
}

// Reorder a set to match `keys` (entry keys, new order). Entries not named in `keys` keep
// their relative order at the end, so a concurrently-added line is never dropped.
export async function reorder(setName, keys) {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(setName);
    if (!(seq instanceof YAMLSeq)) return { reordered: false };
    applyOrder(seq, keys);
    await writeDoc(doc);
    return { reordered: true };
  });
}
