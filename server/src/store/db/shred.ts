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
import { Document, isMap, isSeq, type Node } from 'yaml';

import { applyComments, commentsOf, type RowComments } from './common.js';

/** A key's comments, kept only when it has any — an empty pair per key would triple the size
 * of the meta row for nothing. */
const recordKeyComments = (
  into: Record<string, RowComments>,
  name: string,
  key: unknown,
): void => {
  const comments = commentsOf(key);
  if (comments.comment_before != null || comments.comment != null) into[name] = comments;
};

/** One row on its way to or from a table: its ordinal, its JSON payload, its two comments. */
export interface ShreddedRow extends RowComments {
  position: number;
  /** `JSON.stringify` of the node's plain value. */
  data: string;
  /** The plain value, so a caller can read its `id` without parsing the string it just made. */
  value: unknown;
}

/** What belongs to the document rather than to any row. */
export interface DocumentLeftovers {
  /** Every top-level key in file order, including the one that became rows. */
  order: string[];
  /** The top-level keys that did NOT become rows, by key. */
  values: Record<string, unknown>;
  /**
   * The comments on the top-level KEY nodes.
   *
   * This is where the file header actually lives, and it is not where you would look. The
   * `yaml` parser hands a leading comment block to `doc.commentBefore` only when a blank line
   * separates it from the first key; `sets.yaml`'s 1,733-character header has no such break,
   * so it is `global:`'s `commentBefore`. Recording only the document-level pair dropped the
   * whole header on the first write — silently, and the projection still looked right.
   */
  keyComments: Record<string, RowComments>;
  commentBefore: string | null;
  comment: string | null;
}

const asRow = (item: unknown, position: number): ShreddedRow => {
  const value = (item as Node | undefined)?.toJSON?.() ?? item;
  return { position, data: JSON.stringify(value ?? null), value, ...commentsOf(item) };
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
  const keyComments: Record<string, RowComments> = {};
  let rows: ShreddedRow[] = [];

  if (isMap(contents)) {
    for (const pair of contents.items) {
      const name = String((pair.key as Node | undefined)?.toJSON?.() ?? pair.key);
      order.push(name);
      recordKeyComments(keyComments, name, pair.key);
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
  groups: { name: string; position: number; comments: RowComments; rows: ShreddedRow[] }[];
  leftovers: DocumentLeftovers;
} {
  const contents = doc.contents;
  const order: string[] = [];
  const values: Record<string, unknown> = {};
  const keyComments: Record<string, RowComments> = {};
  const groups: { name: string; position: number; comments: RowComments; rows: ShreddedRow[] }[] = [];

  if (isMap(contents)) {
    contents.items.forEach((pair, index) => {
      const name = String((pair.key as Node | undefined)?.toJSON?.() ?? pair.key);
      order.push(name);
      if (isSeq(pair.value)) {
        groups.push({
          name,
          position: index,
          // The comments belong to the KEY node, not the value: `kevin:  # a note` and the
          // block above `kevin:` are both addressed off the pair's key.
          comments: commentsOf(pair.key),
          rows: pair.value.items.map(asRow),
        });
      } else {
        values[name] = (pair.value as Node | undefined)?.toJSON?.() ?? pair.value;
        // A queue key's comments ride on its own row; only a leftover key needs them here.
        recordKeyComments(keyComments, name, pair.key);
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
      if (comments) applyComments(pair.key, comments);
    }
  }

  return doc;
}
