// Read/modify the shared queues.yaml with comment- and order-preserving round-trips
// (the `yaml` Document API), guarded by a CROSS-PROCESS lock that the Python prune also
// takes. Both writers (this Node editor + queue_builder.queues.prune) run in the same
// container but as separate processes, so the Python threading lock can't cover us — a
// mkdir-based advisory lock on `<queues.yaml>.lock` does (see queue_builder/queues.py).
import { promises as fs } from 'node:fs';
import { parseDocument, YAMLSeq, Scalar, isCollection, isNode, isPair, isScalar } from 'yaml';
import type { Document, Node } from 'yaml';
import { QUEUES_PATH } from './config.js';
import { QUEUE_SERIES_LENGTH } from './env.js';
import { toWeight } from './engine/weight.js';
import { isNodeError } from './errors.js';
import type { EntryExtras, EntryValue, QueueEntry, Start } from './types.js';

/**
 * The MAPPING form of an on-disk entry, as it comes back off a YAML node.
 *
 * `EntryValue` in types.ts is the union of that mapping and a bare scalar; this is just its
 * object arm, named so the four readers below (`entryKey`, `entryDone`, `entryDoneAt`,
 * `splitEntry`) narrow through ONE place instead of casting individually.
 */
type EntryMapping = { ratingKey?: string | number; title?: string } & EntryExtras;

/**
 * `value` as a mapping, or null when it is a scalar / array / absent — the exact test the
 * four readers below share (`value && typeof value === 'object' && !Array.isArray(value)`).
 *
 * The cast is the one unavoidable step: `.toJSON()` hands back `any`/`unknown` and there is
 * no schema on disk, so "an object here is an entry mapping" is an assumption the file
 * format makes, not something the type system can prove. Every field read through it is
 * still coerced (`String(...)`, `Number(...)`) exactly as before.
 */
function asMapping(value: unknown): EntryMapping | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as EntryMapping;
}

/** `.toJSON()` off a node read out of a parsed document; a non-node item passes through. */
function plain(node: unknown): unknown {
  return isNode(node) ? node.toJSON() : node;
}

const LOCK_DIR = QUEUES_PATH + '.lock';
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

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await acquireLock();
  try {
    return await fn();
  } finally {
    await releaseLock();
  }
}

// Stable identity for an entry — MUST match queue_builder.queues.entry_key so the two
// writers address the same lines. `value` is a plain-JS entry (scalar or {ratingKey,title}).
export function entryKey(value: unknown): string | null {
  const m = asMapping(value);
  if (m) {
    if (m.ratingKey != null) return `rk:${m.ratingKey}`;
    // {collection: X} keys like a `Collection: X` string (matches Python queues.entry_key).
    if (m.collection) return `title:Collection: ${String(m.collection).trim()}`;
    if (m.title) return `title:${String(m.title).trim()}`;
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
export function entryDone(value: unknown): boolean {
  return Boolean(asMapping(value)?.done === true);
}

// The epoch-seconds timestamp the Python service stamps alongside `done: true` (queues.mark_done),
// or null when absent/non-numeric. queues.sweep_completed measures the TTL against this, so a
// hand-marked `done: true` with no timestamp reads as null and is never auto-removed.
export function entryDoneAt(value: unknown): number | null {
  const m = asMapping(value);
  if (m && m.done_at != null) {
    const n = Number(m.done_at);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// The global default completed-entry TTL, mirroring config.REMOVE_COMPLETED_AFTER (Python) —
// used when a set names no `remove_completed_after` override. Auto-removal is OPT-IN: the
// default is 'never' (keep finished entries forever, today's behavior), so anime channels are
// never surprise-swept; a movie queue opts in with `remove_completed_after: 24h` in sets.yaml.
// "24h"/"7d"/"90m" enables; "0"/"never" disables. Env-overridable so one app env feeds both.
export const DEFAULT_REMOVE_COMPLETED_AFTER = process.env.REMOVE_COMPLETED_AFTER || 'never';

const DURATION_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, '': 1 };

// Parse a duration string to whole seconds, or null when auto-removal is disabled. Accepts
// `24h`/`7d`/`90m`/`45` (bare = seconds); `0`/`never`/`off`/`none`/blank/unparseable → null.
// Mirrors queue_builder.queues.parse_duration so both processes agree on a set's window.
export function parseDuration(value: unknown): number | null {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  if (['', '0', 'never', 'off', 'none', 'disabled'].includes(s)) return null;
  const m = /^(\d+)\s*([smhdw]?)$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[1] ?? '', 10);
  if (!n) return null;
  // Both defaults are unreachable: group 1 is required and group 2 is optional-but-always-
  // captured (`''` when the unit is omitted), and `''` is itself a DURATION_UNITS key worth 1.
  // They exist only because `noUncheckedIndexedAccess` cannot know that.
  return n * (DURATION_UNITS[m[2] ?? ''] ?? 1);
}

async function readDoc(): Promise<Document> {
  let text = '';
  try {
    text = await fs.readFile(QUEUES_PATH, 'utf8');
  } catch (e) {
    if (!isNodeError(e) || e.code !== 'ENOENT') throw e;
  }
  const doc: Document = parseDocument(text);
  if (!doc.contents || typeof doc.get !== 'function') doc.contents = doc.createNode({});
  return doc;
}

function seqFor(doc: Document, setName: string): YAMLSeq {
  const seq = doc.get(setName);
  if (seq instanceof YAMLSeq) return seq;
  const fresh = new YAMLSeq();
  doc.set(setName, fresh);
  return fresh;
}

// Match the Python/ruamel writer's style so the file doesn't churn as the two writers
// alternate: `indentSeq: false` puts block dashes at the key's indent (ruamel offset=0),
// `lineWidth: 0` disables wrapping so long titles/comments stay on one line.
const YAML_OUT = { indentSeq: false, lineWidth: 0 };

async function writeDoc(doc: Document): Promise<void> {
  _allCache = null; // see listAll(): stat-keyed memo, busted explicitly on our own writes
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

function entriesOf(doc: Document, setName: string): QueueEntry[] {
  const seq = doc.get(setName);
  if (!(seq instanceof YAMLSeq)) return [];
  return seq.items
    .map((node) => {
      const value = plain(node);
      return { key: entryKey(value), value, done: entryDone(value), doneAt: entryDoneAt(value) };
    })
    .filter((e): e is QueueEntry => e.key !== null);
}

// Ordered raw entries for one set: [{ key, value }]. `value` is plain JS (scalar or object).
export async function listSet(setName: string): Promise<QueueEntry[]> {
  return entriesOf(await readDoc(), setName);
}

// EVERY set's entries in ONE parse: Map<setId, entries[]>.
//
// /api/queues used to call listSet() once per set, and each call re-read and re-parsed the
// whole file — ten full parses of one document to render ten shelves. The file is only 2-5 KB
// so this was never the 2.7 s (that is Plex I/O), but it is pure waste on the request path
// and it is what /api/shelves needs to answer in ~15 ms with no Plex call at all.
//
// Memoized on the file's (mtimeMs, size). Any writer — this process, an SMB hand-edit, the
// Python prune — moves at least one of those, so a stale hit is not reachable through a normal
// write. writeDoc() also busts it explicitly, because two writes inside the same millisecond
// that happen to produce the same length would otherwise collide on the key.
interface AllCache {
  mtimeMs: number;
  size: number;
  map: Map<string, QueueEntry[]>;
}
let _allCache: AllCache | null = null;

export async function listAll(): Promise<Map<string, QueueEntry[]>> {
  let st = null;
  try {
    st = await fs.stat(QUEUES_PATH);
  } catch {
    st = null; // no file yet: parse the empty document, don't memoize
  }
  if (st && _allCache && _allCache.mtimeMs === st.mtimeMs && _allCache.size === st.size) {
    return _allCache.map;
  }
  const doc = await readDoc();
  const map = new Map<string, QueueEntry[]>();
  const root: unknown[] = isCollection(doc.contents) ? doc.contents.items : [];
  for (const pair of root) {
    const key = isPair(pair) ? pair.key : null;
    const name = isScalar(key) && key.value != null ? String(key.value) : null;
    if (name == null) continue;
    map.set(name, entriesOf(doc, name));
  }
  if (st) _allCache = { mtimeMs: st.mtimeMs, size: st.size, map };
  return map;
}

// Remove EVERY done entry from a set's list (the "Remove all completed" button). Done entries
// are the ones the Python service kept + tagged after they finished; this is the ONLY path
// that drops them (never automatic). Returns the count removed.
export async function removeCompleted(setName: string): Promise<{ removed: number }> {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(setName);
    if (!(seq instanceof YAMLSeq)) return { removed: 0 };
    const before = seq.items.length;
    seq.items = seq.items.filter((n) => !entryDone(plain(n)));
    const removed = before - seq.items.length;
    if (removed) {
      if (seq.items.length === 0) seq.flow = true; // restore a compact `[]` when emptied
      await writeDoc(doc);
    }
    return { removed };
  });
}

/** `sweepCompleted()`'s options — the set's own consumption knobs, plus a clock for tests. */
export interface SweepOptions {
  keepCompleted?: boolean;
  reel?: boolean;
  removeCompletedAfter?: string | null;
  /** Epoch SECONDS; defaults to the wall clock. */
  now?: number;
}

// §B.3 TTL auto-remove: drop the entries this set finished longer ago than its window.
// session.js calls this after markDone. A done entry is eligible only once
// its `done_at` (epoch seconds) is >= ttl old; a `keep_completed`/`reel` set is exempt, as
// is a hand-marked `done:true` with no timestamp. `removeCompletedAfter` defaults to the
// global DEFAULT_REMOVE_COMPLETED_AFTER when a set names no override. Returns the count
// removed. `now` is epoch SECONDS (defaults to the wall clock), for deterministic tests.
export async function sweepCompleted(setName: string, opts: SweepOptions = {}): Promise<{ removed: number }> {
  const {
    keepCompleted = false,
    reel = false,
    removeCompletedAfter = DEFAULT_REMOVE_COMPLETED_AFTER,
    now,
  } = opts;
  if (keepCompleted || reel) return { removed: 0 };
  const ttl = parseDuration(removeCompletedAfter);
  if (ttl == null) return { removed: 0 };
  const nowSec = now == null ? Date.now() / 1000 : now;
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(setName);
    if (!(seq instanceof YAMLSeq)) return { removed: 0 };
    const before = seq.items.length;
    seq.items = seq.items.filter((n) => {
      const v = plain(n);
      const doneAt = entryDoneAt(v);
      return !(entryDone(v) && doneAt != null && nowSec - doneAt >= ttl);
    });
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
export async function addItem(
  setName: string,
  value: EntryValue,
  position: 'top' | 'bottom' = 'top',
): Promise<{ added: boolean; key: string }> {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = seqFor(doc, setName);
    const key = entryKey(value);
    if (!key) throw new Error('empty entry');
    if (seq.items.some((n) => entryKey(plain(n)) === key)) return { added: false, key };
    seq.flow = false; // a populated queue is always a block list, never `[ ... ]`
    // Force double-quoted title strings so a `:` (e.g. "Star Trek: ...") stays readable.
    let node: Node;
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

export async function removeItem(setName: string, key: string): Promise<{ removed: boolean }> {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(setName);
    if (!(seq instanceof YAMLSeq)) return { removed: false };
    const before = seq.items.length;
    seq.items = seq.items.filter((n) => entryKey(plain(n)) !== key);
    if (seq.items.length === before) return { removed: false };
    if (seq.items.length === 0) seq.flow = true; // restore a compact `[]` when emptied
    await writeDoc(doc);
    return { removed: true };
  });
}

function applyOrder(seq: YAMLSeq, keys: string[]): void {
  // Keyed by `string | null` because entryKey() returns null for an unidentifiable node, and
  // those must still sort (to the tail) rather than blow up the lookup.
  const rank = new Map<string | null, number>(keys.map((k, i) => [k, i]));
  const withKeys = seq.items.map((n, i) => ({ n, k: entryKey(plain(n)), i }));
  withKeys.sort((a, b) => {
    const ra = rank.get(a.k) ?? keys.length + a.i;
    const rb = rank.get(b.k) ?? keys.length + b.i;
    return ra - rb;
  });
  seq.items = withKeys.map((x) => x.n);
}

// Move an entry from one set to another (cross-queue drag), placing it per `toKeys` (the
// target set's desired key order incl. the moved entry). Same-set → a plain reorder. The
// actual YAML node is relocated, so its formatting/inline comment travels with it. Atomic:
// both sets live in one document, mutated under a single lock + one write.
export async function moveItem(
  fromSet: string,
  toSet: string,
  key: string,
  toKeys: string[],
): Promise<{ moved: boolean } | { reordered: boolean }> {
  if (fromSet === toSet) return reorder(toSet, toKeys);
  return withLock(async () => {
    const doc = await readDoc();
    const src = doc.get(fromSet);
    if (!(src instanceof YAMLSeq)) return { moved: false };
    const idx = src.items.findIndex((n) => entryKey(plain(n)) === key);
    if (idx < 0) return { moved: false };
    const [node] = src.items.splice(idx, 1);
    if (src.items.length === 0) src.flow = true; // source emptied → compact `[]`
    const dst = seqFor(doc, toSet);
    dst.flow = false;
    if (!dst.items.some((n) => entryKey(plain(n)) === key)) dst.items.push(node);
    applyOrder(dst, toKeys);
    await writeDoc(doc);
    return { moved: true };
  });
}

/** One `{fromSet, key}` addressing pair for the bulk operations. */
export interface BulkItem {
  fromSet: string;
  key: string;
}

// Bulk-move many entries (possibly from several source sets) into `toSet`, appended in the
// given order. One lock + one write, so a multi-select move is atomic. Entries already in
// `toSet` are left in place. `items` = [{fromSet, key}].
export async function moveBulk(items: BulkItem[], toSet: string): Promise<{ moved: number }> {
  return withLock(async () => {
    const doc = await readDoc();
    const dst = seqFor(doc, toSet);
    let moved = 0;
    for (const { fromSet, key } of items) {
      if (fromSet === toSet) continue;
      const src = doc.get(fromSet);
      if (!(src instanceof YAMLSeq)) continue;
      const i = src.items.findIndex((n) => entryKey(plain(n)) === key);
      if (i < 0) continue;
      const [node] = src.items.splice(i, 1);
      if (src.items.length === 0) src.flow = true;
      if (!dst.items.some((n) => entryKey(plain(n)) === key)) {
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
export async function removeBulk(items: BulkItem[]): Promise<{ removed: number }> {
  return withLock(async () => {
    const doc = await readDoc();
    let removed = 0;
    for (const { fromSet, key } of items) {
      const src = doc.get(fromSet);
      if (!(src instanceof YAMLSeq)) continue;
      const before = src.items.length;
      src.items = src.items.filter((n) => entryKey(plain(n)) !== key);
      if (src.items.length < before) {
        removed += 1;
        if (src.items.length === 0) src.flow = true;
      }
    }
    if (removed) await writeDoc(doc);
    return { removed };
  });
}

/**
 * `splitEntry()`'s result — `EntryIdentity` from types.ts with `ratingKey` widened.
 *
 * types.ts declares `ratingKey: string | null`, but a bare `- 12345` (or `ratingKey: 12345`)
 * parses as a NUMBER off the YAML and is carried through untouched — `entryNode()` even
 * re-numbers a numeric-looking string on the way back out. Reported rather than fixed: the
 * shared type is another agent's file, and coercing here would change what gets written.
 */
interface SplitEntry {
  ratingKey: string | number | null;
  title: string | null;
  extras: EntryExtras;
}

// An entry as {identity, extras}: `identity` is the ratingKey/title that makes the entry
// addressable, `extras` is every OTHER field the file carries (episodes, start, done, a
// hand-written `collection:`, …). Rewrites keep the extras, so setting one override never
// silently drops another writer's field.
function splitEntry(cur: unknown): SplitEntry {
  const m = asMapping(cur);
  if (m) {
    const { ratingKey = null, title = null, ...extras } = m;
    return { ratingKey, title, extras };
  }
  const s = String(cur).trim();
  if (/^\d+$/.test(s)) return { ratingKey: s, title: null, extras: {} };
  return { ratingKey: null, title: String(cur), extras: {} };
}

// Rebuild an entry node from its identity + extras, collapsing to the plainest form (a bare
// title string / ratingKey scalar) when there are no extras left to carry.
function entryNode(doc: Document, { ratingKey, title, extras }: SplitEntry): Node {
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
  const o: Record<string, unknown> = {};
  if (ratingKey != null) o.ratingKey = ratingKey;
  if (title != null) o.title = title;
  for (const k of keys) o[k] = extras[k];
  return doc.createNode(o);
}

// Replace one entry in a set, addressed by its stable key. `mutate({ratingKey,title,extras})`
// edits the split form in place; the node is rebuilt from the result.
async function rewriteEntry(setName: string, key: string, mutate: (e: SplitEntry) => void): Promise<boolean> {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(setName);
    if (!(seq instanceof YAMLSeq)) return false;
    const idx = seq.items.findIndex((node) => entryKey(plain(node)) === key);
    if (idx < 0) return false;
    const split = splitEntry(plain(seq.items[idx]));
    mutate(split);
    seq.items[idx] = entryNode(doc, split);
    seq.flow = false;
    await writeDoc(doc);
    return true;
  });
}


// Tag the given entry keys **done** in place — kept in the file, excluded from play.
// Port of queue_builder.queues.mark_done (D4). Scalar entries become mappings so they can
// carry `done` + `done_at` (epoch seconds). Match is by entryKey. Returns { changed: bool }.
export async function markDone(
  setName: string,
  keepKeys: (string | null | undefined)[] | null | undefined,
  nowSec: number | null = null,
): Promise<{ changed: boolean }> {
  const want = new Set((keepKeys || []).filter(Boolean));
  if (!want.size) return { changed: false };
  const now = nowSec == null ? Math.floor(Date.now() / 1000) : Math.floor(nowSec);
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(setName);
    if (!(seq instanceof YAMLSeq)) return { changed: false };
    let changed = false;
    for (let i = 0; i < seq.items.length; i += 1) {
      const cur = plain(seq.items[i]);
      const key = entryKey(cur);
      if (!want.has(key)) continue;
      const m = asMapping(cur);
      if (m) {
        if (m.done === true && m.done_at != null) continue;
        const split = splitEntry(cur);
        split.extras.done = true;
        split.extras.done_at = now;
        seq.items[i] = entryNode(doc, split);
        changed = true;
      } else {
        // Scalar → mapping carrying identity + done flags (mirrors Python CommentedMap wrap).
        const split = splitEntry(cur);
        split.extras.done = true;
        split.extras.done_at = now;
        seq.items[i] = entryNode(doc, split);
        changed = true;
      }
    }
    if (changed) {
      seq.flow = false;
      await writeDoc(doc);
    }
    return { changed };
  });
}

// Un-mark the given entry keys — strip `done` + `done_at` (stale-done recovery).
// Port of queue_builder.queues.clear_done (D4). Returns { changed: bool }.
export async function clearDone(
  setName: string,
  keepKeys: (string | null | undefined)[] | null | undefined,
): Promise<{ changed: boolean }> {
  const want = new Set((keepKeys || []).filter(Boolean));
  if (!want.size) return { changed: false };
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(setName);
    if (!(seq instanceof YAMLSeq)) return { changed: false };
    let changed = false;
    for (let i = 0; i < seq.items.length; i += 1) {
      const cur = plain(seq.items[i]);
      const m = asMapping(cur);
      if (!m) continue;
      if (!want.has(entryKey(cur))) continue;
      if (m.done == null && m.done_at == null) continue;
      const split = splitEntry(cur);
      delete split.extras.done;
      delete split.extras.done_at;
      seq.items[i] = entryNode(doc, split);
      changed = true;
    }
    if (changed) {
      seq.flow = false;
      await writeDoc(doc);
    }
    return { changed };
  });
}

// Set a series entry's per-show `episodes` (episodes queued per play). Rewrites the entry as
// a mapping carrying its ratingKey/title identity + `episodes` (or drops the field / reverts
// to a bare scalar when set back to 1). Entry identity (key) is unchanged.
export async function setEpisodes(
  setName: string,
  key: string,
  episodes: unknown,
): Promise<{ ok: true; episodes: number } | { ok: false }> {
  // Capped at the ENGINE's own hard cap rather than a second, smaller magic number: the editor
  // offers a free-typed count, and a value this accepted but resolve.js then clamped would have
  // the file disagreeing with what actually plays.
  const n = Math.max(1, Math.min(parseInt(String(episodes), 10) || 1, QUEUE_SERIES_LENGTH));
  const ok = await rewriteEntry(setName, key, (e) => {
    if (n > 1) e.extras.episodes = n;
    else delete e.extras.episodes;
  });
  return ok ? { ok: true, episodes: n } : { ok: false };
}

// Set a queue entry's WEIGHT — how many slots it takes per round when the set is randomized
// (see engine/weight.js). 1 is the default and DROPS the key, which is what keeps an untouched
// queue's YAML free of `weight: 1` noise and lets the entry collapse back to a bare scalar.
export async function setWeight(
  setName: string,
  key: string,
  weight: unknown,
): Promise<{ ok: true; weight: number } | { ok: false }> {
  const n = toWeight(weight);
  const ok = await rewriteEntry(setName, key, (e) => {
    if (n > 1) e.extras.weight = n;
    else delete e.extras.weight;
  });
  return ok ? { ok: true, weight: n } : { ok: false };
}

// Set (or clear) a series/collection entry's `batch_stops_at` override — WHERE this entry's
// batch may stop, independent of how many episodes it plays. "member"/"season" write the key;
// anything else (including "none") DROPS it, which is how the entry says "follow the set".
// Entry identity (key) is unchanged, and every other field it carries survives (extras).
export async function setBatchStop(
  setName: string,
  key: string,
  value: unknown,
): Promise<{ ok: true; batch_stops_at: string | null } | { ok: false }> {
  const s = value == null ? '' : String(value).trim().toLowerCase();
  const stop = ['member', 'season'].includes(s) ? s : null;
  const ok = await rewriteEntry(setName, key, (e) => {
    if (stop) e.extras.batch_stops_at = stop;
    else delete e.extras.batch_stops_at;
  });
  return ok ? { ok: true, batch_stops_at: stop } : { ok: false };
}

// Normalize a manual START point off the wire. A SHOW start is {season, episode}; a
// COLLECTION start also names the member to begin at — `series` is that member's ratingKey
// (a hand-written YAML entry may name it by title instead), and season/episode are optional
// (a movie member has neither). Anything without a series AND without an episode is "no
// start" — i.e. back to automatic next-unwatched.
export function normalizeStart(start: unknown): Start | null {
  if (!start || typeof start !== 'object') return null;
  const src = start as { series?: unknown; season?: unknown; episode?: unknown };
  const hasSeries = src.series != null && String(src.series).trim() !== '';
  if (!hasSeries && src.episode == null) return null;
  const s: Start = {};
  if (hasSeries) s.series = String(src.series).trim();
  if (src.episode != null) {
    s.season = Math.max(1, parseInt(String(src.season), 10) || 1);
    s.episode = Math.max(1, parseInt(String(src.episode), 10) || 1);
  }
  return s;
}

// Set (or clear) an entry's manual START floor — begin here, skipping earlier episodes (and,
// for a collection, earlier members) WITHOUT marking anything watched. Preserves the entry's
// identity and every other field it carries; pass start=null to revert to automatic.
export async function setStart(
  setName: string,
  key: string,
  start: unknown,
): Promise<{ ok: true; start: Start | null } | { ok: false }> {
  const s = normalizeStart(start);
  const ok = await rewriteEntry(setName, key, (e) => {
    if (s) e.extras.start = s;
    else delete e.extras.start;
  });
  return ok ? { ok: true, start: s } : { ok: false };
}

// Drop a deleted queue's whole YAML key (used by DELETE /api/sets/:id so a removed queue
// doesn't leave an orphaned list behind). Missing key = fine.
export async function deleteSetKey(setName: string): Promise<{ deleted: boolean }> {
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
export async function reorder(setName: string, keys: string[]): Promise<{ reordered: boolean }> {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(setName);
    if (!(seq instanceof YAMLSeq)) return { reordered: false };
    applyOrder(seq, keys);
    await writeDoc(doc);
    return { reordered: true };
  });
}
