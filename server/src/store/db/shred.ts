// Document ⇄ rows. One module, because the same three shapes appear in three stores and a
// second copy of this logic is where the two would drift.
//
// Three shapes:
//
//   LIST-UNDER-A-KEY   sets.yaml's `sets:` and groups.yaml's `groups:` — a sequence of
//                      mappings, each with an `id` that is a WIRE ID.
//   MAP-OF-LISTS       queues.yaml — every top-level key is a queue and its value is the
//                      ordered entry list.
//   THE LEFTOVERS      a top-level key that is neither (sets.yaml's `global:`), the document
//                      header comment and the document footer comment. They belong to no row,
//                      so they go to `store_meta` rather than being dropped.
//
// A row's `data` is `JSON.stringify(node.toJSON())` — the node's plain value, in the file's own
// key order, which `toJSON()` and `JSON.stringify` both preserve. That is the reconstruction
// source: a field this schema never heard of survives a full round trip, which is the property
// a column-per-field design does not have.
import { Document, isMap, isNode, isSeq, type Node } from 'yaml';

import { applyComments, commentsOf, type RowComments } from './common.js';

const hasAny = (comments: RowComments): boolean =>
  comments.comment_before != null || comments.comment != null;

/** A top-level pair's comments, kept only when it has any — an empty pair per key would
 * triple the size of the meta row for nothing. */
const recordKeyComments = (
  into: Record<string, { key?: RowComments; value?: RowComments }>,
  name: string,
  pairKey: unknown,
  pairValue: unknown,
): void => {
  const onKey = commentsOf(pairKey);
  const onValue = commentsOf(pairValue);
  if (!hasAny(onKey) && !hasAny(onValue)) return;
  into[name] = {
    ...(hasAny(onKey) ? { key: onKey } : {}),
    ...(hasAny(onValue) ? { value: onValue } : {}),
  };
};

/** One row on its way to or from a table: its ordinal, its JSON payload, its comments. */
export interface ShreddedRow extends RowComments {
  position: number;
  /** `JSON.stringify` of the node's plain value. */
  data: string;
  /** The plain value, so a caller can read its `id` without parsing the string it just made. */
  value: unknown;
  /**
   * The comments INSIDE the row's mapping, as JSON, or null when it has none.
   *
   * `comment_before` and `comment` cover the block above the row and the trailing one on its
   * own line. They do not cover a comment attached to a key WITHIN the mapping — and those are
   * the ones that carry the operational knowledge, because they explain a field:
   *
   *     requires_profile: sawtaytoes
   *     # The owner signs in as the plex.tv USERNAME, not the Plex Home title.
   *
   * Without this the live registry lost four such lines and `queues.yaml` one, and `history.ts`
   * lost its byte-for-byte restore with them. Keyed by the path from the row's own node, so a
   * comment reattaches to the field it explains even after the mapping is rebuilt.
   */
  inner_comments: string | null;
}

/** The two comment slots on one node, in their short stored form. */
interface StoredComments {
  b?: string;
  c?: string;
}

/** Every commented node inside a row, keyed by `JSON.stringify(path)`. `k` is the pair's KEY
 * node (where a comment above a field lands) and `v` its VALUE node. */
type InnerComments = Record<string, { k?: StoredComments; v?: StoredComments }>;

const slot = (node: unknown): StoredComments | undefined => {
  if (!isNode(node)) return undefined;
  const stored: StoredComments = {};
  if (node.commentBefore != null) stored.b = node.commentBefore;
  if (node.comment != null) stored.c = node.comment;
  return stored.b === undefined && stored.c === undefined ? undefined : stored;
};

const unslot = (node: unknown, stored: StoredComments | undefined): void => {
  if (!stored || !isNode(node)) return;
  if (stored.b != null) node.commentBefore = stored.b;
  if (stored.c != null) node.comment = stored.c;
};

/** Walk a row's node and record every comment below its root. The root's own comments are the
 * row's `comment_before` / `comment` and are deliberately not repeated here. */
function collectInner(node: unknown, path: (string | number)[], into: InnerComments): void {
  if (isMap(node)) {
    for (const pair of node.items) {
      const name = String((pair.key as Node | undefined)?.toJSON?.() ?? pair.key);
      const at = [...path, name];
      const entry = { k: slot(pair.key), v: slot(pair.value) };
      if (entry.k || entry.v) into[JSON.stringify(at)] = entry;
      collectInner(pair.value, at, into);
    }
    return;
  }
  if (isSeq(node)) {
    node.items.forEach((item, index) => {
      const at = [...path, index];
      const entry = { v: slot(item) };
      if (entry.v) into[JSON.stringify(at)] = entry;
      collectInner(item, at, into);
    });
  }
}

/** The same walk, putting them back. */
function restoreInner(node: unknown, path: (string | number)[], from: InnerComments): void {
  if (isMap(node)) {
    for (const pair of node.items) {
      const name = String((pair.key as Node | undefined)?.toJSON?.() ?? pair.key);
      const at = [...path, name];
      const entry = from[JSON.stringify(at)];
      if (entry) {
        unslot(pair.key, entry.k);
        unslot(pair.value, entry.v);
      }
      restoreInner(pair.value, at, from);
    }
    return;
  }
  if (isSeq(node)) {
    node.items.forEach((item, index) => {
      const at = [...path, index];
      unslot(item, from[JSON.stringify(at)]?.v);
      restoreInner(item, at, from);
    });
  }
}

/** Put a row's inner comments back on the node rebuilt from its `data`. */
export function applyInnerComments(node: unknown, stored: string | null): void {
  if (stored == null) return;
  try {
    restoreInner(node, [], JSON.parse(stored) as InnerComments);
  } catch {
    // A corrupt meta blob must not take a read down over a comment.
  }
}

/** What belongs to the document rather than to any row. */
export interface DocumentLeftovers {
  /** Every top-level key in file order, including the one that became rows. */
  order: string[];
  /** The top-level keys that did NOT become rows, by key. */
  values: Record<string, unknown>;
  /**
   * The comments on the top-level pairs — `key` for the key node, `value` for the value.
   *
   * This is where the file header actually lives, and it is not where you would look. The
   * `yaml` parser hands a leading comment block to `doc.commentBefore` only when a blank line
   * separates it from the first key; `sets.yaml`'s 1,733-character header has no such break,
   * so it is `global:`'s `commentBefore`. Recording only the document-level pair dropped the
   * whole header on the first write — silently, and the projection still looked right.
   *
   * BOTH slots, because a comment between a key and its list belongs to the LIST:
   *
   *     demo:
   *     # --- Lights down: logos & Atmos ambience ---
   *     - { ratingKey: 230859, … }
   */
  keyComments: Record<string, { key?: RowComments; value?: RowComments }>;
  commentBefore: string | null;
  comment: string | null;
}

const asRow = (item: unknown, position: number): ShreddedRow => {
  const value = (item as Node | undefined)?.toJSON?.() ?? item;
  const inner: InnerComments = {};
  collectInner(item, [], inner);
  return {
    position,
    data: JSON.stringify(value ?? null),
    value,
    inner_comments: Object.keys(inner).length === 0 ? null : JSON.stringify(inner),
    ...commentsOf(item),
  };
};

/**
 * Split a `key: [ … ]` document into its rows and its leftovers.
 *
 * A document with no such key, or with a non-sequence under it, yields no rows and keeps the
 * value as a leftover — which is how a hand-edit that broke the shape survives a round trip
 * instead of being deleted by it.
 */
export function shredListDocument(doc: Document, key: string): {
  rows: ShreddedRow[];
  leftovers: DocumentLeftovers;
} {
  const contents = doc.contents;
  const order: string[] = [];
  const values: Record<string, unknown> = {};
  const keyComments: Record<string, { key?: RowComments; value?: RowComments }> = {};
  let rows: ShreddedRow[] = [];

  if (isMap(contents)) {
    for (const pair of contents.items) {
      const name = String((pair.key as Node | undefined)?.toJSON?.() ?? pair.key);
      order.push(name);
      recordKeyComments(keyComments, name, pair.key, pair.value);
      if (name === key && isSeq(pair.value)) {
        rows = pair.value.items.map(asRow);
      } else {
        values[name] = (pair.value as Node | undefined)?.toJSON?.() ?? pair.value;
      }
    }
  }

  return {
    rows,
    leftovers: {
      order,
      values,
      keyComments,
      commentBefore: doc.commentBefore ?? null,
      comment: doc.comment ?? null,
    },
  };
}

/**
 * Split a `key: [ … ]` map-of-lists document — queues.yaml — into one group per top-level key.
 *
 * A top-level key whose value is not a sequence keeps its value as a leftover, same rule as
 * above and for the same reason.
 */
export function shredMapOfListsDocument(doc: Document): {
  groups: {
    name: string;
    position: number;
    /** On the KEY node — the block above `demo:` and the trailing comment on that line. */
    comments: RowComments;
    /** On the LIST node — a comment between `demo:` and its first entry. */
    listComments: RowComments;
    rows: ShreddedRow[];
  }[];
  leftovers: DocumentLeftovers;
} {
  const contents = doc.contents;
  const order: string[] = [];
  const values: Record<string, unknown> = {};
  const keyComments: Record<string, { key?: RowComments; value?: RowComments }> = {};
  const groups: {
    name: string;
    position: number;
    comments: RowComments;
    listComments: RowComments;
    rows: ShreddedRow[];
  }[] = [];

  if (isMap(contents)) {
    contents.items.forEach((pair, index) => {
      const name = String((pair.key as Node | undefined)?.toJSON?.() ?? pair.key);
      order.push(name);
      if (isSeq(pair.value)) {
        groups.push({
          name,
          position: index,
          // Both nodes carry comments and they are different comments: `kevin:  # a note` and
          // the block above `kevin:` hang off the KEY, while a comment on the line after
          // `kevin:` and before the first entry hangs off the LIST.
          comments: commentsOf(pair.key),
          listComments: commentsOf(pair.value),
          rows: pair.value.items.map(asRow),
        });
      } else {
        values[name] = (pair.value as Node | undefined)?.toJSON?.() ?? pair.value;
        // A queue's comments ride on its own row; only a leftover key needs them here.
        recordKeyComments(keyComments, name, pair.key, pair.value);
      }
    });
  }

  return {
    groups,
    leftovers: {
      order,
      values,
      keyComments,
      commentBefore: doc.commentBefore ?? null,
      comment: doc.comment ?? null,
    },
  };
}

/** The plain object a document reconstructs from, with the top-level keys back in file order
 * and any key the leftovers know about restored beside the rows. */
export function assemble(
  leftovers: DocumentLeftovers,
  rowsByKey: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // File order first, then anything the rows have that the recorded order does not — a key
  // added since the leftovers were written must still appear, at the end, rather than vanish.
  for (const name of leftovers.order) {
    if (name in rowsByKey) out[name] = rowsByKey[name];
    else if (name in leftovers.values) out[name] = leftovers.values[name];
  }
  for (const [name, value] of Object.entries(rowsByKey)) {
    if (!(name in out)) out[name] = value;
  }
  for (const [name, value] of Object.entries(leftovers.values)) {
    if (!(name in out)) out[name] = value;
  }
  return out;
}

/** Build the document, then put the document-level and top-level-key comments back on it. */
export function documentFrom(
  value: Record<string, unknown>,
  leftovers: DocumentLeftovers,
): Document {
  const doc = new Document(value);
  if (leftovers.commentBefore != null) doc.commentBefore = leftovers.commentBefore;
  if (leftovers.comment != null) doc.comment = leftovers.comment;

  const contents = doc.contents;
  if (isMap(contents)) {
    for (const pair of contents.items) {
      const name = String((pair.key as Node | undefined)?.toJSON?.() ?? pair.key);
      const comments = leftovers.keyComments?.[name];
      if (comments?.key) applyComments(pair.key, comments.key);
      if (comments?.value) applyComments(pair.value, comments.value);
    }
  }

  return doc;
}
