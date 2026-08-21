// THE MIGRATION ITSELF — every queues.yaml entry becomes an object, over a parsed `yaml`
// Document. The CLI that runs it, and the report it prints, are in `migrate-entry-objects.ts`.
//
// Split from the CLI so the migration can be driven OFFLINE with an injected resolver, which is
// what `e2e/entry-objects-test.ts` does. The rating-key backfill is the half that needs a
// library to talk to, and a gate that could not exercise it would be testing the easy half.
//
// WHAT IT WRITES
//
//   an item        `{ratingKey: "<key>", title: "<the entry's own text>"}` — the shape the
//                  majority of the file already used. The title text is the OWNER's, verbatim:
//                  his `(year)` and `[guid]` hints are how he reads the file, and the resolver
//                  does not need them once the rating key is there.
//   a collection   `{collection: "<name>"}`. A collection has no per-item rating key; it is
//                  resolved by NAME per section, so there is nothing to backfill. `entryKey()`
//                  returns `title:Collection: <name>` for this, for the `"Collection: <name>"`
//                  string it replaces AND for the `{title: "Collection: <name>"}` mapping — all
//                  three address the same line, so nothing is re-keyed.
//   an unresolved  `{title: "<text>"}`. A rating key cannot be invented and a title must not be
//   title          guessed at, so the entry becomes an object like every other line and is
//                  REPORTED for the owner to fix by hand. It is never deleted.
//
// EVERY SIBLING FIELD SURVIVES — `start`, `done`, `done_at`, `weight`, `episodes`, `volumes`,
// `batch_stops_at`, `queued_at`, and anything a future writer adds. Losing one silently would
// be worse than the bug this fixes.
//
// IDEMPOTENT: a second pass reports no changes and rewrites no node.
import { parseDocument, YAMLSeq, isNode, isPair, isScalar, isCollection } from 'yaml';
import type { Document, Node } from 'yaml';

import { COLLECTION_PREFIX_RE } from '../entryFormat.js';
import type { EntryObject } from '../types.js';

/** What happened to one entry. */
export type Verdict =
  | 'keep' // already the target shape — not rewritten, so its formatting is untouched
  | 'backfilled' // a title gained its rating key
  | 'reshaped' // a scalar became a mapping, with nothing to look up
  | 'collection' // a collection became `{collection: …}`
  | 'unresolved'; // a title nothing answers to — still an object, and reported

export interface Change {
  set: string;
  index: number;
  verdict: Verdict;
  before: unknown;
  after: EntryObject;
  /**
   * Was the NODE actually replaced?
   *
   * False for the one change that is a report rather than an edit: an already-object entry
   * whose title nothing answers to. It is named on every run — it is still broken — but there
   * is nothing to rewrite about it, which is why a file that holds one is still idempotent.
   */
  rewritten: boolean;
  /** Why an entry could not be resolved, in one line. */
  why?: string;
}

export interface MigrateResult {
  changes: Change[];
  kept: Change[];
  /** Per set, in file order: the label the report prints beside the set's name. */
  labels: Map<string, string>;
}

/**
 * How one set is treated.
 *
 * `resolve` is null when this queue's titles must NOT be looked up — a queue served by
 * something other than Plex (`manga_webtoons` is Kavita, and its rating keys are Kavita series
 * ids), or a run told not to talk to anything. `why` then explains it in the report.
 */
export interface SetPolicy {
  label: string;
  resolve: ((value: unknown) => Promise<string | null>) | null;
  why?: string;
}

/** How the caller decides a set's policy. Called once per top-level key, in file order. */
export type PolicyFor = (setName: string) => SetPolicy;

/** The identity fields of an entry, split from everything else it carries. */
function splitValue(value: unknown): { identity: EntryObject; extras: Record<string, unknown> } {
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    const { ratingKey, title, collection, ...extras } = value as Record<string, unknown>;
    const identity: EntryObject = {};
    if (ratingKey != null) identity.ratingKey = ratingKey as string | number;
    if (collection != null) identity.collection = String(collection);
    // `{title: "Collection: <name>"}` is the older mapping spelling of a collection — the
    // prefix lives in the title's TEXT. `describe()` has always read it as a collection, so
    // this is a spelling change and not a semantic one, and `entryKey()` returns the same
    // `title:Collection: <name>` either way. Only when the line names no rating key: a mapping
    // that carries one is an item whose title merely starts with the word.
    else if (ratingKey == null && title != null) {
      const named = COLLECTION_PREFIX_RE.exec(String(title))?.[1];
      if (named !== undefined) return { identity: { collection: named.trim() }, extras };
    }
    if (title != null) identity.title = title as string;
    return { identity, extras };
  }
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return { identity: { ratingKey: s }, extras: {} };
  const coll = COLLECTION_PREFIX_RE.exec(s)?.[1];
  if (coll !== undefined) return { identity: { collection: coll.trim() }, extras: {} };
  return { identity: { title: String(value) }, extras: {} };
}

/**
 * `identity` + `extras` as one mapping, in a stable field order.
 *
 * Identity first, then everything the line already carried, in ITS order — which is the order
 * the entries that were already objects use, so a migrated line reads like the ones beside it.
 */
function compose(identity: EntryObject, extras: Record<string, unknown>): EntryObject {
  const out: EntryObject = {};
  if (identity.collection != null) out.collection = identity.collection;
  if (identity.ratingKey != null) out.ratingKey = identity.ratingKey;
  if (identity.title != null) out.title = identity.title;
  for (const [k, v] of Object.entries(extras)) out[k] = v;
  return out;
}

const isMapping = (value: unknown): boolean =>
  value != null && typeof value === 'object' && !Array.isArray(value);

/**
 * The replacement node, carrying the old node's comments.
 *
 * `comment` (trailing), `commentBefore` (the lines above) and `spaceBefore` (a blank line that
 * groups entries) are all things a human typed, and replacing a node drops every one of them
 * unless they are copied across.
 */
function rebuild(doc: Document, old: unknown, value: EntryObject): Node {
  const node = doc.createNode(value) as Node;
  if (isNode(old)) {
    if (old.commentBefore != null) node.commentBefore = old.commentBefore;
    if (old.comment != null) {
      // A scalar's TRAILING comment has nowhere to sit on a block mapping — which of its lines
      // would it end? — so it moves to the line ABOVE, where it still reads as belonging to
      // this entry. Appended to any existing head comment rather than replacing it.
      node.commentBefore = node.commentBefore ? `${node.commentBefore}\n${old.comment}` : old.comment;
    }
    if (old.spaceBefore) node.spaceBefore = true;
  }
  return node;
}

/**
 * Rewrite every entry in `doc` to the object form, in place.
 *
 * Only the entries that actually CHANGE are replaced, so an already-migrated file comes out of
 * `doc.toString()` byte-identical — which is what makes a second run a no-op rather than a
 * reformat.
 */
export async function migrateDocument(doc: Document, policyFor: PolicyFor): Promise<MigrateResult> {
  const changes: Change[] = [];
  const kept: Change[] = [];
  const labels = new Map<string, string>();

  const root: unknown[] = isCollection(doc.contents) ? doc.contents.items : [];
  for (const pair of root) {
    if (!isPair(pair)) continue;
    const name = isScalar(pair.key) && pair.key.value != null ? String(pair.key.value) : null;
    if (name == null) continue;
    const seq = pair.value;
    if (!(seq instanceof YAMLSeq)) continue;

    const policy = policyFor(name);
    labels.set(name, policy.label);

    for (let i = 0; i < seq.items.length; i += 1) {
      const node = seq.items[i];
      const before: unknown = isNode(node) ? node.toJSON() : node;
      if (before == null) continue;
      const { identity, extras } = splitValue(before);

      let verdict: Verdict;
      let why: string | undefined = policy.resolve ? undefined : policy.why;

      if (identity.collection != null) {
        // A collection resolves by NAME, per section. There is no per-item rating key to
        // backfill, so the only question is whether it is already spelled `{collection: …}`.
        verdict = isMapping(before) && (before as EntryObject).collection != null ? 'keep' : 'collection';
        why = undefined;
      } else if (identity.ratingKey != null) {
        // A bare `- 12345` carries no human label. Ask for one — it is the only field this
        // migration ever invents, and it is a caption, not an identity.
        if (identity.title == null && policy.resolve) {
          const resolvedTitle = await policy.resolve(before);
          if (resolvedTitle) identity.title = resolvedTitle;
        }
        verdict = isMapping(before) ? 'keep' : 'reshaped';
        why = undefined;
      } else if (identity.title != null) {
        if (!policy.resolve) {
          // Reshaped if it was a scalar, otherwise left exactly as it is — but REPORTED either
          // way, because a title with no rating key is what this migration exists to remove.
          verdict = isMapping(before) ? 'unresolved' : 'reshaped';
        } else {
          const ratingKey = await policy.resolve(before);
          if (ratingKey) {
            identity.ratingKey = ratingKey;
            verdict = 'backfilled';
          } else {
            verdict = 'unresolved';
            why = policy.why ?? 'nothing in this queue’s libraries answers to this title';
          }
        }
      } else {
        // No identity at all. `entryKey()` returns null for this and every reader already drops
        // it, so it is left exactly as it is rather than invented into a shape.
        continue;
      }

      // An `unresolved` MAPPING is reported without being rewritten — there is nothing to
      // change about it, and rewriting it would move its comments for no reason.
      const rewritten = verdict !== 'keep' && !(verdict === 'unresolved' && isMapping(before));
      const after = compose(identity, extras);
      const change: Change = { set: name, index: i, verdict, before, after, rewritten, ...(why ? { why } : {}) };
      if (verdict === 'keep') {
        kept.push(change);
        continue;
      }
      changes.push(change);
      if (rewritten) seq.items[i] = rebuild(doc, node, after);
    }
  }
  return { changes, kept, labels };
}

/**
 * `migrateDocument` over TEXT: parse, migrate, print back.
 *
 * The same `indentSeq: false` / `lineWidth: 0` the app writes with, so a migrated file does not
 * churn against the app's own next write. Exported for `e2e/entry-objects-test.ts`, which has
 * no `yaml` of its own to parse with — and it keeps the round-trip settings in ONE place
 * rather than repeated at each caller.
 */
export async function migrateText(
  text: string,
  policyFor: PolicyFor,
): Promise<MigrateResult & { text: string }> {
  const doc = parseDocument(text);
  const result = await migrateDocument(doc, policyFor);
  return { ...result, text: doc.toString({ indentSeq: false, lineWidth: 0 }) };
}
