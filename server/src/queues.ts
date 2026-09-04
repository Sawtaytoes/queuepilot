// Read/modify the shared queues.yaml with comment- and order-preserving round-trips
// (the `yaml` Document API), guarded by an advisory lock on `<queues.yaml>.lock`.
//
// ⚠️ THE SECOND WRITER IS GONE. The lock was built cross-process because a Python
// `queue_builder.queues.prune` edited the same file from a sibling process in the same
// container; `queue_builder/` was deleted in `7bf01e0` ("chore: delete queue_builder — Node is
// the only implementation") and only `cast_sidecar/` is tracked Python now, which never touches
// this file. The lock stays because it is still load-bearing for THIS process: every mutation
// below is an async read-modify-write over the whole document, several requests can interleave,
// and two of them parsing the same text would drop one edit. A mkdir lock is also the cheapest
// thing that survives a crash, which a language-level mutex is not.
//
// The FILE half of that — path, lock, parse, write — is `store/queues.ts`'s now. What is left
// here is the entry vocabulary and every mutation over the parsed document.
import { YAMLSeq, isCollection, isNode, isPair, isScalar } from 'yaml';
import type { Document, Node } from 'yaml';
import { store } from './store/index.js';
import { QUEUE_SERIES_LENGTH } from './env.js';
import { toWeight } from './engine/weight.js';
import { parsePromoteWindow } from './leadWindow.js';
import * as promote from './promote.js';
import * as sets from './sets.js';
import { entryIdOf, hasSection, mintEntryId, toEntryObject, toPositionMs } from './entryFormat.js';
import { normalizeEntryItemOrder } from './entryItemOrder.js';
import { normalizeWatchHistory } from './watchHistory.js';
import type { End, EntryExtras, EntryObject, EntryValue, QueueEntry, Start } from './types.js';

/**
 * The MAPPING form of an on-disk entry, as it comes back off a YAML node.
 *
 * `EntryValue` in types.ts is the union of that mapping and a bare scalar; this is just its
 * object arm, named so the four readers below (`entryKey`, `entryDone`, `entryDoneAt`,
 * `splitEntry`) narrow through ONE place instead of casting individually.
 */
type EntryMapping = EntryObject;

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

// Persistence lives in `store/queues.ts` now — the path, the mkdir lock (built cross-process
// for a Python writer that no longer exists; see the module header), and the comment-preserving
// round-trip. Aliased rather than re-wrapped so every call site below reads exactly as it did.
const { readDoc, withLock } = store.queues;

// Stable identity for one LINE of a queue. `value` is a plain-JS entry (scalar or a mapping).
//
// MUST agree with its twin in `engine/resolve.ts` — the read side keys the same lines the write
// side does, and `e2e/play-one-entry-test.ts` asserts the two answer alike. Change one, change
// the other in the same commit.
//
//     id:<opaque>   when the mapping carries a non-empty id
//     rk:<n>        otherwise, when it carries a ratingKey
//     title:<text>  otherwise
//
// The `id:` branch arrived 2026-09-01 so one queue can hold the same file more than once. It is
// FIRST and it is additive: an entry that carries no id keys exactly as it did before, byte for
// byte, so nothing on disk re-keys and no `queue_entry_history` or `lead_cooldown` row is
// orphaned ([decision] docs/decisions/2026-09-01-an-entry-can-carry-an-id-so-one-file-can-hold-two-lines.md).
export function entryKey(value: unknown): string | null {
  const m = asMapping(value);
  if (m) {
    const id = entryIdOf(m);
    if (id) return `id:${id}`;
    if (m.ratingKey != null) return `rk:${m.ratingKey}`;
    // {collection: X} keys like a `Collection: X` string — the older, string-encoded spelling
    // of the same entry, so re-shaping one into the other never moves a line.
    if (m.collection) return `title:Collection: ${String(m.collection).trim()}`;
    if (m.title) return `title:${String(m.title).trim()}`;
    return null;
  }
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return `rk:${s}`;
  return s ? `title:${s}` : null;
}

// --- the entry FORMAT (2026-08-21) ------------------------------------------- //
//
// The rule itself lives in `entryFormat.ts` — one module, so the engine can state it without
// importing this whole write-side. Re-exported here because this is where `entryKey()` lives
// and where every caller already looks for the entry vocabulary.
export {
  entryIdOf, hasSection, isLegacyScalarEntry, legacyEntryMessage, toEntryObject, toPositionMs,
} from './entryFormat.js';

// A finished entry is KEPT and tagged `done: true` on its mapping rather than pruned (that is
// the decision; `markDone` below is what writes it, and the Python service that used to is
// gone). A plain string, a bare ratingKey, or a mapping without `done:true` is NOT done.
// Handles both on-disk shapes so a legacy plain entry simply reads as not-done.
export function entryDone(value: unknown): boolean {
  return Boolean(asMapping(value)?.done === true);
}

// The epoch-seconds timestamp `markDone` stamps alongside `done: true`, or null when absent or
// non-numeric. `sweepCompleted` measures the TTL against this, so a hand-marked `done: true`
// with no timestamp reads as null and is never auto-removed.
export function entryDoneAt(value: unknown): number | null {
  const m = asMapping(value);
  if (m && m.done_at != null) {
    const n = Number(m.done_at);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// The global default completed-entry TTL, read from the app env as REMOVE_COMPLETED_AFTER —
// used when a set names no `remove_completed_after` override. Auto-removal is OPT-IN: the
// default is 'never' (keep finished entries forever, today's behavior), so anime channels are
// never surprise-swept; a movie queue opts in with `remove_completed_after: 24h` in sets.yaml.
// "24h"/"7d"/"90m" enables; "0"/"never" disables. Env-overridable from the app's own env.
export const DEFAULT_REMOVE_COMPLETED_AFTER = process.env.REMOVE_COMPLETED_AFTER || 'never';

const DURATION_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, '': 1 };

// Parse a duration string to whole seconds, or null when auto-removal is disabled. Accepts
// `24h`/`7d`/`90m`/`45` (bare = seconds); `0`/`never`/`off`/`none`/blank/unparseable → null.
// One parser, so a set's window means the same thing to the sweep and to the editor.
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

/**
 * WHOSE entries a set id names.
 *
 * A FILTERED queue holds none of its own — it is a narrower view of another queue, and its
 * whole point is that the run continues across both (`filteredQueues.ts`). So every read and
 * every per-entry write below resolves the id first: adding a series from the filtered queue's
 * page adds it to the parent, and finishing one finishes it for both.
 *
 * ONE HOP. A filter of a filter is refused at the registry, and resolving it here anyway would
 * quietly give a refused set somebody else's entries.
 *
 * The three ORDER-changing operations — `reorder`, `moveItem`, `moveBulk` — deliberately do
 * NOT call this. A filtered queue shows a SUBSET, so the key list it would send names only the
 * items it can see, and `applyOrder` sorts everything else to the tail: reordering two webtoons
 * would sweep every manga in the parent to the bottom. `routes/queuesRoutes.ts` refuses those
 * three on a filtered queue instead, and the UI does not offer the drag.
 */
export async function entryOwner(setName: string): Promise<string> {
  const s = await sets.getSet(setName);
  return s?.filtered_from || setName;
}

function seqFor(doc: Document, setName: string): YAMLSeq {
  const seq = doc.get(setName);
  if (seq instanceof YAMLSeq) return seq;
  const fresh = new YAMLSeq();
  doc.set(setName, fresh);
  return fresh;
}

async function writeDoc(doc: Document): Promise<void> {
  _allCache = null; // see listAll(): stat-keyed memo, busted explicitly on our own writes
  await store.queues.writeDoc(doc);
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
  return entriesOf(await readDoc(), await entryOwner(setName));
}

// EVERY set's entries in ONE parse: Map<setId, entries[]>.
//
// /api/queues used to call listSet() once per set, and each call re-read and re-parsed the
// whole file — ten full parses of one document to render ten shelves. The file is only 2-5 KB
// so this was never the 2.7 s (that is Plex I/O), but it is pure waste on the request path
// and it is what /api/shelves needs to answer in ~15 ms with no Plex call at all.
//
// Memoized on the file's (mtimeMs, size). Any writer — this process, or an SMB hand-edit, which
// is the only other one left — moves at least one of those, so a stale hit is not reachable
// through a normal write. writeDoc() also busts it explicitly, because two writes inside the same millisecond
// that happen to produce the same length would otherwise collide on the key.
interface AllCache {
  mtimeMs: number;
  size: number;
  map: Map<string, QueueEntry[]>;
}
let _allCache: AllCache | null = null;

export async function listAll(): Promise<Map<string, QueueEntry[]>> {
  // null = no file yet: parse the empty document, don't memoize.
  const st = await store.queues.stat();
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
  // A FILTERED queue has no key in this file. It is still asked for by id — every caller does
  // `all.get(set.id)` — so it is ALIASED onto its parent's list here rather than each caller
  // learning the rule. The caller then applies the filter itself, because what narrows the
  // list (a Kavita library id) is not in this file.
  //
  // Deliberately NOT memoized differently: the alias is derived from `sets.yaml` and the memo
  // above is keyed on `queues.yaml`'s stat, so the aliases are rebuilt on the next set edit
  // only if the queue file also moved. `getSet()` is a Map lookup on a registry memoized on
  // ITS own file, so re-deriving them every call is cheaper than a second cache key.
  for (const s of (await sets.getRegistry()).sets) {
    if (!s.filtered_from) continue;
    const parent = map.get(s.filtered_from);
    if (parent) map.set(s.id, parent);
  }
  if (st) _allCache = { mtimeMs: st.mtimeMs, size: st.size, map };
  return map;
}

// Remove EVERY done entry from a set's list (the "Remove all completed" button). Done entries
// are the ones `markDone` kept and tagged after they finished; this is the ONLY path that drops
// them (never automatic). Returns the count removed.
export async function removeCompleted(setName: string): Promise<{ removed: number }> {
  const owner = await entryOwner(setName);
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(owner);
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

// TTL auto-remove: drop the entries this set finished longer ago than its window.
// session.ts calls this after markDone. A done entry is eligible only once
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
  const owner = await entryOwner(setName);
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(owner);
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

/**
 * Every `id` any entry in the WHOLE document already carries.
 *
 * The key is per set, so uniqueness within the set is what `entryKey` needs — but `moveItem`
 * and `moveBulk` relocate a node between sets, and a minted id that was unique only in its
 * birth queue would collide on arrival. Scanning the file costs one already-parsed walk of a
 * few hundred lines, so the wider set is free and the move stays a pure relocation.
 */
function takenEntryIds(doc: Document): Set<string> {
  const taken = new Set<string>();
  const root: unknown[] = isCollection(doc.contents) ? doc.contents.items : [];
  for (const pair of root) {
    const seq = isPair(pair) ? pair.value : null;
    if (!(seq instanceof YAMLSeq)) continue;
    for (const node of seq.items) {
      const id = entryIdOf(plain(node));
      if (id) taken.add(id);
    }
  }
  return taken;
}

/** `addItem()`'s knobs. `position` stays a positional argument — every caller passes it. */
export interface AddItemOptions {
  /**
   * Add a SECOND line for something this queue already holds, instead of refusing.
   *
   * OFF by default, and that default is the product rule rather than caution: an accidental
   * second copy of a film in a watch queue is a bug, and the refusal is what caught it. This
   * is the opt-in for the case where a second line is the POINT — the demo reel that plays
   * three windows of one film at three positions. Saying yes mints an `id` for the new line,
   * which is what makes the two independently addressable.
   */
  allowDuplicate?: boolean;
}

// Add a new entry. `value` is a string (title), a number (ratingKey), or a mapping — the API
// still takes all three, and `toEntryObject` turns it into the mapping that lands on disk.
// `position` is 'top' (default — top plays next) or 'bottom'. Set-name validity is the
// caller's (`routes/queuesRoutes.ts`) job — it checks against the live sets.yaml registry.
//
// A key already in the queue is REFUSED (`{added: false, key}`) unless the caller asked for a
// duplicate, which is what `allowDuplicate` and a section on the value both say. Then the new
// line is minted an `id` and lands beside the one it repeats.
export async function addItem(
  setName: string,
  value: EntryValue,
  position: 'top' | 'bottom' = 'top',
  { allowDuplicate = false }: AddItemOptions = {},
): Promise<{ added: boolean; key: string }> {
  const owner = await entryOwner(setName);
  return withLock(async () => {
    const doc = await readDoc();
    const seq = seqFor(doc, owner);
    // Keyed off the NORMALIZED value. `toEntryObject` is identity-preserving, so this is the
    // same key the raw value has always produced — spelled once, from what actually gets
    // written, rather than trusting the two to agree.
    const entry = toEntryObject(value);
    // Every new entry gets one honest queue-arrival timestamp. `queued_at` already drives
    // provider progress, so it is also the durable answer for the queue view's "Recently
    // added" sort. Preserve an explicit stamp for imports/tests; ordinary API adds omit it.
    if (entry.queued_at == null) entry.queued_at = Math.floor(Date.now() / 1000);
    let key = entryKey(entry);
    if (!key) throw new Error('empty entry');
    if (seq.items.some((n) => entryKey(plain(n)) === key)) {
      // An add that names a WINDOW is asking for a line, not for the item, so it says "yes"
      // on its own — the same reasoning that lets it past `entryIdentity.findDuplicateItem`.
      if (!allowDuplicate && !hasSection(entry)) return { added: false, key };
      // MINTED HERE AND NOWHERE ELSE. This is the only refusal an id removes, which is what
      // keeps every existing line's key byte-identical: an entry that was never going to be
      // refused never gains one.
      entry.id = mintEntryId(takenEntryIds(doc));
      key = entryKey(entry) as string;
    }
    seq.flow = false; // a populated queue is always a block list, never `[ ... ]`
    const node: Node = doc.createNode(entry);
    if (position === 'bottom') seq.items.push(node);
    else seq.items.unshift(node);
    await writeDoc(doc);
    return { added: true, key };
  });
}

export async function removeItem(setName: string, key: string): Promise<{ removed: boolean }> {
  const owner = await entryOwner(setName);
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(owner);
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
// Exported for providers/launcher.ts, which needs an entry's stored id + its `episodes:`
// override to build a PULL provider's lineup — the same decomposition every writer here uses.
export function splitEntry(cur: unknown): SplitEntry {
  const m = asMapping(cur);
  if (m) {
    const { ratingKey = null, title = null, ...extras } = m;
    return { ratingKey, title, extras };
  }
  const s = String(cur).trim();
  if (/^\d+$/.test(s)) return { ratingKey: s, title: null, extras: {} };
  return { ratingKey: null, title: String(cur), extras: {} };
}

// Rebuild an entry node from its identity + extras.
//
// It used to COLLAPSE to the plainest form — a bare title string or a bare ratingKey scalar —
// whenever the last extra was cleared, so `setWeight(key, 1)` turned `{title: X, weight: 2}`
// back into `- "X"`. That collapse is gone: the file holds mappings now, and a writer that
// re-created the legacy shape on an unrelated edit would have undone the migration one entry
// at a time.
function entryNode(doc: Document, { ratingKey, title, extras }: SplitEntry): Node {
  const keys = Object.keys(extras).filter((k) => extras[k] != null);
  const o: Record<string, unknown> = {};
  // `id` LEADS when the entry carries one. It is what keys the line, and this file is read and
  // edited by hand over SMB — the identity belongs above the payload. Setting the key here and
  // again in the loop below is harmless: an existing key keeps its position.
  if (extras.id != null) o.id = extras.id;
  if (ratingKey != null) o.ratingKey = ratingKey;
  if (title != null) o.title = title;
  for (const k of keys) o[k] = extras[k];
  return doc.createNode(o);
}

// Replace one entry in a set, addressed by its stable key. `mutate({ratingKey,title,extras})`
// edits the split form in place; the node is rebuilt from the result.
async function rewriteEntry(
  setName: string,
  key: string,
  // Returning `false` REFUSES the write: the file is left exactly as it was found and the
  // entry is still reported as located. A mutator needs that because the entry it is handed is
  // the only place two of its own fields are visible at once — `setEnd` cannot know whether an
  // `end` is legal until it has read the `start` sitting beside it, and by then it is inside
  // the lock. Every other mutator returns void and is unaffected.
  mutate: (e: SplitEntry) => void | false,
): Promise<boolean> {
  // ONE resolution for every per-entry setter — a filtered queue writes on its parent's line.
  const owner = await entryOwner(setName);
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(owner);
    if (!(seq instanceof YAMLSeq)) return false;
    const idx = seq.items.findIndex((node) => entryKey(plain(node)) === key);
    if (idx < 0) return false;
    const split = splitEntry(plain(seq.items[idx]));
    if (mutate(split) === false) return true;
    seq.items[idx] = entryNode(doc, split);
    seq.flow = false;
    await writeDoc(doc);
    return true;
  });
}

/**
 * Give every entry that currently INHERITS its lane an explicit placement.
 *
 * Call this before changing a queue's `add_as`. The setting is the lane for NEW entries,
 * not a bulk move: without this materialisation, every sparse entry changes lanes merely
 * because the fallback it reads changed. One locked rewrite keeps the existing queue intact
 * while later additions inherit the new default.
 */
export async function preserveInheritedPlacements(
  setName: string,
  placement: 'priority' | 'random',
): Promise<{ changed: number }> {
  const owner = await entryOwner(setName);
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(owner);
    if (!(seq instanceof YAMLSeq)) return { changed: 0 };
    let changed = 0;
    for (let i = 0; i < seq.items.length; i += 1) {
      const split = splitEntry(plain(seq.items[i]));
      if (split.extras.placement === 'priority' || split.extras.placement === 'random') continue;
      split.extras.placement = placement;
      if (placement === 'random') {
        delete split.extras.lead;
        delete split.extras.promote_window;
      }
      seq.items[i] = entryNode(doc, split);
      changed += 1;
    }
    if (changed) {
      seq.flow = false;
      await writeDoc(doc);
    }
    return { changed };
  });
}


/**
 * Stamp `queued_at` (epoch seconds) on one entry, unless it already carries one.
 *
 * Only providers that count LIFETIME progress on their own side need this — see
 * `Provider.stampsQueuedAt`. Board Game Picker's play log is the household's book of
 * record and goes back years; without a stamp, a game with twenty plays behind it and a
 * batch of three is finished the instant it is queued.
 *
 * Never overwrites: the first stamp is the truthful one, and re-stamping on every launch
 * would reset progress every night.
 *
 * Returns the stamp the entry now carries, or null when there is no such entry.
 */
export async function stampQueuedAt(
  setName: string,
  key: string,
  nowSec: number | null = null,
): Promise<number | null> {
  const now = nowSec == null ? Math.floor(Date.now() / 1000) : Math.floor(nowSec);
  let stamped: number | null = null;
  const ok = await rewriteEntry(setName, key, (split) => {
    const existing = Number(split.extras.queued_at);
    if (Number.isFinite(existing) && existing > 0) {
      stamped = existing;
      return;
    }
    split.extras.queued_at = now;
    stamped = now;
  });
  return ok ? stamped : null;
}

// Tag the given entry keys **done** in place — kept in the file, excluded from play.
// Scalar entries become mappings so they can carry `done` + `done_at` (epoch seconds). Match is
// by entryKey, which names ONE line, so "every match" here is the same single line a
// `rewriteEntry` setter's first match would find. Returns { changed: bool }.
export async function markDone(
  setName: string,
  keepKeys: (string | null | undefined)[] | null | undefined,
  nowSec: number | null = null,
): Promise<{ changed: boolean }> {
  const want = new Set((keepKeys || []).filter(Boolean));
  if (!want.size) return { changed: false };
  const now = nowSec == null ? Math.floor(Date.now() / 1000) : Math.floor(nowSec);
  const owner = await entryOwner(setName);
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(owner);
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
        // Scalar → mapping carrying identity + done flags, the shape every entry holds now.
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

// Un-mark the given entry keys — strip `done` + `done_at` (stale-done recovery). Match is by
// entryKey, one key one line, exactly as `markDone`. Returns { changed: bool }.
export async function clearDone(
  setName: string,
  keepKeys: (string | null | undefined)[] | null | undefined,
): Promise<{ changed: boolean }> {
  const want = new Set((keepKeys || []).filter(Boolean));
  if (!want.size) return { changed: false };
  const owner = await entryOwner(setName);
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get(owner);
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

/** This set's stored default for `field`, or the engine floor of 1. */
async function setCountDefault(
  setName: string,
  field: 'episodes' | 'volumes',
): Promise<number> {
  const s = await sets.getSet(setName);
  if (!s || s.source !== 'queue') return 1;
  const n = s[field];
  return n != null && n >= 1 ? n : 1;
}

/**
 * A stored per-entry count, or null when the entry follows the set.
 *
 * Absent / unparseable / < 1 is "follow the set" — never coerced to 1. 1 is a real
 * override when this set's default is not 1.
 */
export function storedCount(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

// Set a series entry's per-show `episodes` (episodes queued per play). Rewrites the entry as
// a mapping carrying its ratingKey/title identity + `episodes` (or drops the field / reverts
// to a bare scalar when the value equals THIS SET's default). Entry identity (key) is unchanged.
export async function setEpisodes(
  setName: string,
  key: string,
  episodes: unknown,
): Promise<{ ok: true; episodes: number } | { ok: false }> {
  // Capped at the ENGINE's own hard cap rather than a second, smaller magic number: the editor
  // offers a free-typed count, and a value this accepted but resolve.js then clamped would have
  // the file disagreeing with what actually plays.
  const n = Math.max(1, Math.min(parseInt(String(episodes), 10) || 1, QUEUE_SERIES_LENGTH));
  const setDefault = await setCountDefault(setName, 'episodes');
  const ok = await rewriteEntry(setName, key, (e) => {
    if (n === setDefault) delete e.extras.episodes;
    else e.extras.episodes = n;
  });
  return ok ? { ok: true, episodes: n } : { ok: false };
}

/**
 * Set the order of playable leaves inside one show or Collection. `shuffle` is the only
 * stored value; everything else removes the key and restores next-unwatched, in-order play.
 */
export async function setItemOrder(
  setName: string,
  key: string,
  value: unknown,
): Promise<{ ok: true; item_order: 'shuffle' | null } | { ok: false }> {
  const order = normalizeEntryItemOrder(value);
  const ok = await rewriteEntry(setName, key, (entry) => {
    if (order === 'shuffle') entry.extras.item_order = 'shuffle';
    else delete entry.extras.item_order;
  });
  return ok ? { ok: true, item_order: order === 'shuffle' ? 'shuffle' : null } : { ok: false };
}

// How many VOLUMES a volume-based series contributes per visit. Independent of
// `episodes` — a volume is a collection of chapters, so the chapter count must
// not apply. Equals-the-set-default drops the key, same sparse rule as setEpisodes.
export async function setVolumes(
  setName: string,
  key: string,
  volumes: unknown,
): Promise<{ ok: true; volumes: number } | { ok: false }> {
  const n = Math.max(1, Math.min(parseInt(String(volumes), 10) || 1, QUEUE_SERIES_LENGTH));
  const setDefault = await setCountDefault(setName, 'volumes');
  const ok = await rewriteEntry(setName, key, (e) => {
    if (n === setDefault) delete e.extras.volumes;
    else e.extras.volumes = n;
  });
  return ok ? { ok: true, volumes: n } : { ok: false };
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

// PROMOTE / DEMOTE — move one entry between a Picks queue's two lanes.
//
// "priority" / "random" write the key; anything else DROPS it, which is how an entry says
// "follow the set's `add_as`" and is what every entry written before this feature says.
// Sparse on purpose: a queue nobody has promoted anything in carries no `placement:` at all
// and resolves exactly as it did (decision `2026-08-23-kind-is-picks-or-rules` §2).
//
// A DEMOTE also clears the entry's lead cooldown. The window is the memory of a promise this
// entry no longer makes, and leaving it behind means a re-promote an hour later silently does
// nothing — the entry would be suppressed by a window it is no longer in the lane for.
export async function setPlacement(
  setName: string,
  key: string,
  value: unknown,
): Promise<{ ok: true; placement: string | null } | { ok: false }> {
  const v = value == null ? '' : String(value).trim().toLowerCase();
  const placement = v === 'priority' || v === 'random' ? v : null;
  const ok = await rewriteEntry(setName, key, (e) => {
    if (placement) e.extras.placement = placement;
    else delete e.extras.placement;
    // `lead` and `promote_window` only mean anything inside the Priority lane. Leaving them
    // on a demoted entry is dead YAML that reads as a setting.
    if (placement !== 'priority') {
      delete e.extras.lead;
      delete e.extras.promote_window;
    }
  });
  if (ok && placement !== 'priority') await promote.clearLead(setName, key);
  return ok ? { ok: true, placement } : { ok: false };
}

// How often a Priority entry LEADS: "always" (sticky head every sitting) or "once" (at most
// one contribution per window). Anything else drops the key — which is not the same as either,
// because the default depends on how the entry got into the lane (see `kind.normalizeLead`).
//
// `window` is optional and travels with it: a duration (`24h`, `7d`) or blank/`never`/`0` to
// clear the override and follow the set. Switching to "always" drops the window with it —
// a sticky entry has no cooldown to name.
export async function setLead(
  setName: string,
  key: string,
  lead: unknown,
  window?: unknown,
): Promise<{ ok: true; lead: string | null; promote_window: string | null } | { ok: false }> {
  const v = lead == null ? '' : String(lead).trim().toLowerCase();
  const mode = v === 'once' || v === 'always' ? v : null;
  const w = window == null ? '' : String(window).trim().toLowerCase();
  const win = mode === 'once' && w && !['0', 'never', 'off', 'none', 'disabled'].includes(w)
    && parsePromoteWindow(w) != null
    ? w
    : null;
  const ok = await rewriteEntry(setName, key, (e) => {
    if (mode) e.extras.lead = mode;
    else delete e.extras.lead;
    if (win) e.extras.promote_window = win;
    else delete e.extras.promote_window;
  });
  // Going sticky, or widening the window, should take effect NOW rather than after the old
  // window expires — the owner just told the queue what to do.
  if (ok && mode !== 'once') await promote.clearLead(setName, key);
  return ok ? { ok: true, lead: mode, promote_window: win } : { ok: false };
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
// (a movie member has neither). A start may also name a POSITION inside the unit it picked,
// and a MOVIE SECTION is a position ALONE — no series, no episode, because a film has neither
// (decision `2026-09-01-a-start-point-carries-a-position-and-end-is-its-mirror`).
//
// ⚠️ That last clause is why the "no start" test reads all THREE fields. It used to read two
// (`!hasSeries && src.episode == null`), which was right while a start could only pick a unit
// and would have discarded every film section silently — the position arrived, the guard saw
// no series and no episode, and the whole start came back null with nothing logged.
// `e2e/yaml-roundtrip-test.ts` pins the movie case for exactly that reason.
//
// Sparse throughout: an absent, blank, negative or non-numeric value drops its own key, and a
// start left with none of the three is null rather than an empty mapping.
export function normalizeStart(start: unknown): Start | null {
  if (!start || typeof start !== 'object') return null;
  const src = start as {
    series?: unknown; season?: unknown; episode?: unknown; position_ms?: unknown;
    history?: unknown;
  };
  const hasSeries = src.series != null && String(src.series).trim() !== '';
  const positionMs = toPositionMs(src.position_ms);
  if (!hasSeries && src.episode == null && positionMs == null) return null;
  const s: Start = {};
  if (hasSeries) s.series = String(src.series).trim();
  if (src.episode != null) {
    s.season = Math.max(1, parseInt(String(src.season), 10) || 1);
    s.episode = Math.max(1, parseInt(String(src.episode), 10) || 1);
  }
  if (positionMs != null) s.position_ms = positionMs;
  if (src.history === 'queue' || src.history === 'provider') s.history = src.history;
  return s;
}

// Normalize an END point off the wire — where the first played unit STOPS. `start`'s mirror,
// and deliberately a mapping with one key rather than a bare number, so that a later "stop
// after season 2 episode 6" is an addition here instead of a second key on the entry.
//
// An `end` with no usable position is null (the key is dropped), never `{}` — the same sparse
// rule `normalizeStart` follows and the same one every other per-entry override follows.
export function normalizeEnd(end: unknown): End | null {
  if (!end || typeof end !== 'object') return null;
  const positionMs = toPositionMs((end as { position_ms?: unknown }).position_ms);
  return positionMs == null ? null : { position_ms: positionMs };
}

/**
 * The complaint an inverted or zero-length window earns, naming both offsets.
 *
 * REFUSED BY NAME, never swapped and never clamped. A zero-length section plays nothing, and a
 * swap would hide the typo that produced it — the owner asked for a window and would get a
 * different one with no complaint (decision
 * `2026-09-01-a-start-point-carries-a-position-and-end-is-its-mirror`).
 */
function sectionOrderMessage(startMs: number, endMs: number): string {
  return `end.position_ms (${endMs}) must be strictly after start.position_ms (${startMs}). `
    + 'A section that ends where it begins plays nothing, so this write is refused rather than '
    + 'swapped — check which of the two offsets is the typo.';
}

/**
 * Would this pair of offsets be an invalid window? Null when there is nothing to compare.
 *
 * THE CROSS-FIELD CHECK LIVES ON THE WRITERS, and it has to: only `setStart` and `setEnd` see
 * both sides of one entry, and only inside the YAML lock. A route-level check reads one side
 * off the request and the other off a file it has not locked, so two valid-looking writes
 * could still land an inverted window — set `end: 90s`, then set `start: 120s`, and each
 * request on its own looks fine. Both writers ask this, so neither direction has a door.
 *
 * When only one side is set there is nothing to compare and the write is accepted: three of
 * the four optionality states carry no pair at all.
 */
function sectionRefusal(startMs: number | null, endMs: number | null): string | null {
  if (startMs == null || endMs == null) return null;
  return endMs > startMs ? null : sectionOrderMessage(startMs, endMs);
}

/** `{ok: false}` plus the named reason, when a write was located but refused. */
export interface EntryWriteRefusal {
  ok: false;
  /** Absent when the entry itself was not found; present when the value was refused. */
  error?: string;
}

// Set (or clear) an entry's manual START floor — begin here, skipping earlier episodes (and,
// for a collection, earlier members) WITHOUT marking anything watched. Preserves the entry's
// identity and every other field it carries; pass start=null to revert to automatic.
//
// REFUSES a start that would invert an `end` already on the entry. Without that this writer is
// the second half of a two-step route to an invalid file, and it is the half nobody would
// think to check.
export async function setStart(
  setName: string,
  key: string,
  start: unknown,
): Promise<{ ok: true; start: Start | null } | EntryWriteRefusal> {
  const s = normalizeStart(start);
  let refused: string | null = null;
  const ok = await rewriteEntry(setName, key, (e) => {
    refused = sectionRefusal(s?.position_ms ?? null, e.extras.end?.position_ms ?? null);
    if (refused) return false;
    // Promote the first model's `start.history` to the entry. History is independent of the
    // floor now, so clearing or moving a start must not silently change its source.
    const source = normalizeWatchHistory(s?.history)
      ?? normalizeWatchHistory(e.extras.start?.history);
    if (source && !normalizeWatchHistory(e.extras.watch_history)) {
      e.extras.watch_history = source;
    }
    if (s) {
      const next = { ...s };
      delete next.history;
      e.extras.start = next;
    }
    else delete e.extras.start;
    return undefined;
  });
  if (refused) return { ok: false, error: refused };
  return ok ? { ok: true, start: s } : { ok: false };
}

// Set (or clear) an entry's END point — stop the first played unit here and advance to the
// next queue entry. `setStart`'s mirror in every way that matters: same sparse rule, same
// identity preservation, same "every other field survives", and the same refusal.
//
// Pass end=null (or anything with no usable position) to play to the end of the unit again.
export async function setEnd(
  setName: string,
  key: string,
  end: unknown,
): Promise<{ ok: true; end: End | null } | EntryWriteRefusal> {
  const e = normalizeEnd(end);
  let refused: string | null = null;
  const ok = await rewriteEntry(setName, key, (split) => {
    refused = sectionRefusal(split.extras.start?.position_ms ?? null, e?.position_ms ?? null);
    if (refused) return false;
    if (e) split.extras.end = e;
    else delete split.extras.end;
    return undefined;
  });
  if (refused) return { ok: false, error: refused };
  return ok ? { ok: true, end: e } : { ok: false };
}

/** Set an entry's history source, or clear it so the entry follows its queue. */
export async function setWatchHistory(
  setName: string,
  key: string,
  value: unknown,
): Promise<{ ok: true; watch_history: 'provider' | 'queue' | null } | { ok: false }> {
  const source = normalizeWatchHistory(value);
  const ok = await rewriteEntry(setName, key, (e) => {
    if (source) e.extras.watch_history = source;
    else delete e.extras.watch_history;
    // One source of truth after this entry is edited. The compatibility read remains for
    // untouched rows, but a new writer never leaves the old nested override behind.
    if (e.extras.start?.history) {
      const next = { ...e.extras.start };
      delete next.history;
      e.extras.start = next;
    }
  });
  return ok ? { ok: true, watch_history: source } : { ok: false };
}

/** Set a collection entry's member order. An empty list restores Plex order. */
export async function setCollectionOrder(
  setName: string,
  key: string,
  value: unknown,
): Promise<{ ok: true; collection_order: string[] | null } | { ok: false }> {
  const order = Array.isArray(value)
    ? [...new Set(value.map(String).map((v) => v.trim()).filter(Boolean))]
    : [];
  const ok = await rewriteEntry(setName, key, (e) => {
    if (order.length) e.extras.collection_order = order;
    else delete e.extras.collection_order;
  });
  return ok ? { ok: true, collection_order: order.length ? order : null } : { ok: false };
}

// Drop a deleted queue's whole YAML key (used by DELETE /api/sets/:id so a removed queue
// doesn't leave an orphaned list behind). Missing key = fine.
/**
 * Drop a set's whole entry list — what `sets.deleteSet()` calls once the set itself is gone.
 *
 * NOT routed through `entryOwner()`, and that is the point: a filtered queue has no key in
 * this file, so deleting one is a no-op here. Resolving to the parent would delete the
 * PARENT's entries as a side effect of removing a view of them.
 */
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
