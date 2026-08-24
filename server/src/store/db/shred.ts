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
import { Document, isMap, isNode, isScalar, isSeq, type Node, type Scalar } from 'yaml';

import { commentsOf, type RowComments } from './common.js';

/** The key-and-list presentation for one queue, comments EXCLUDED — those have columns of
 * their own on the `queues` table. Null when there is nothing to record. */
export function queuePresentation(pairKey: unknown, pairValue: unknown): string | null {
  const onKey = slot(pairKey, false);
  const onValue = slot(pairValue, false);
  if (!onKey && !onValue) return null;
  return JSON.stringify({ ...(onKey ? { k: onKey } : {}), ...(onValue ? { v: onValue } : {}) });
}

/** Apply it back. */
export function applyQueuePresentation(
  pairKey: unknown,
  pairValue: unknown,
  stored: string | null,
): void {
  if (stored == null) return;
  try {
    const parsed = JSON.parse(stored) as { k?: Presentation; v?: Presentation };
    unslot(pairKey, parsed.k);
    unslot(pairValue, parsed.v);
  } catch {
    /* a corrupt blob must not take a read down over a blank line */
  }
}

/** A top-level pair's presentation, kept only when it has any — an empty pair per key would
 * triple the size of the meta row for nothing. */
const recordKeyPresentation = (
  into: Record<string, { k?: Presentation; v?: PresentationTable }>,
  name: string,
  pairKey: unknown,
  pairValue: unknown,
): void => {
  const onKey = slot(pairKey);
  const onValue: PresentationTable = {};
  collectInner(pairValue, [], onValue, true);
  const hasValue = Object.keys(onValue).length > 0;
  if (!onKey && !hasValue) return;
  into[name] = { ...(onKey ? { k: onKey } : {}), ...(hasValue ? { v: onValue } : {}) };
};

/** One row on its way to or from a table: its ordinal, its JSON payload, its comments. */
export interface ShreddedRow extends RowComments {
  position: number;
  /** `JSON.stringify` of the node's plain value. */
  data: string;
  /** The plain value, so a caller can read its `id` without parsing the string it just made. */
  value: unknown;
  /**
   * Everything about the row that is not its VALUE: the comments inside its mapping, and how
   * each node was written. JSON, keyed by the path from the row's own node, or null when there
   * is nothing to say.
   *
   * TWO KINDS OF THING, and the column is named for what they have in common rather than for
   * either one, because a name that said "comments" would be a trap for whoever adds the third.
   *
   * COMMENTS. `comment_before` and `comment` cover the block above the row and the trailing one
   * on its own line. They do not cover a comment attached to a key WITHIN the mapping — and
   * those are the ones that carry the operational knowledge, because they explain a field:
   *
   *     requires_profile: sawtaytoes
   *     # The owner signs in as the plex.tv USERNAME, not the Plex Home title.
   *
   * Without this the live registry lost four such lines and `queues.yaml` one.
   *
   * STYLE. Whether a collection was written FLOW (`- {title: "X"}`) or block, and how a scalar
   * was quoted. Without it every entry in `queues.yaml` would be rewritten from the flow form
   * the household hand-typed into the block form the writer prefers, on the first save — a
   * 23 KB file reformatted end to end for no reason anybody asked for. It is also what makes
   * `history.ts`'s byte-for-byte restore true rather than nearly true;
   * `e2e/entry-objects-test.ts` is the gate that says so.
   */
  presentation: string | null;
}

/** One node's presentation. Short keys because this is stored per row: `b`/`c` are the two
 * comments, `f` is flow, `t` is a scalar's quoting style, `s` is a blank line above it. */
export interface Presentation {
  b?: string;
  c?: string;
  f?: true;
  t?: string;
  s?: true;
}

/** Every node inside a row that has something to say about itself, keyed by
 * `JSON.stringify(path)`. `k` is the pair's KEY node (where a comment above a field lands) and
 * `v` its VALUE node. */
type PresentationTable = Record<string, { k?: Presentation; v?: Presentation }>;

export const slot = (node: unknown, withComments = true): Presentation | undefined => {
  if (!isNode(node)) return undefined;
  const stored: Presentation = {};
  if (withComments && node.commentBefore != null) stored.b = node.commentBefore;
  if (withComments && node.comment != null) stored.c = node.comment;
  // A blank line above a node. It is how the household separates one queue from the next in a
  // 782-line file, and it is not a comment — the `yaml` API keeps it on its own flag.
  if (node.spaceBefore) stored.s = true;
  if ((isMap(node) || isSeq(node)) && node.flow) stored.f = true;
  // A PLAIN scalar is the writer's own default, so recording it would double the size of this
  // blob to say nothing.
  if (isScalar(node) && node.type != null && node.type !== 'PLAIN') stored.t = node.type;
  return Object.keys(stored).length === 0 ? undefined : stored;
};

export const unslot = (node: unknown, stored: Presentation | undefined): void => {
  if (!stored || !isNode(node)) return;
  if (stored.b != null) node.commentBefore = stored.b;
  if (stored.c != null) node.comment = stored.c;
  if (stored.s) node.spaceBefore = true;
  if (stored.f && (isMap(node) || isSeq(node))) node.flow = true;
  if (stored.t != null && isScalar(node)) node.type = stored.t as Scalar['type'];
};

/** Walk a row's node and record everything below its root — plus the ROOT's own style, which
 * is how a flow-written entry stays flow. Its comments are the row's own two columns and are
 * deliberately not repeated. */
export function collectInner(
  node: unknown,
  path: (string | number)[],
  into: PresentationTable,
  rootComments = false,
): void {
  if (path.length === 0) {
    const root = slot(node, rootComments);
    if (root) into['[]'] = { v: root };
  }

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
export function restoreInner(node: unknown, path: (string | number)[], from: PresentationTable): void {
  if (path.length === 0) unslot(node, from['[]']?.v);

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

/** Put a row's presentation back on the node rebuilt from its `data`. */
export function applyPresentation(node: unknown, stored: string | null): void {
  if (stored == null) return;
  try {
    restoreInner(node, [], JSON.parse(stored) as PresentationTable);
  } catch {
    // A corrupt blob must not take a read down over a comment or a quote mark.
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
   *
   * The value's side is the RECURSIVE table, not one slot:
   * `global: {excluded_sections: [ 2, 7, 8 ]}` puts the flow list one level DOWN from the
   * top-level value, and recording only the value node brings it back as a block list.
   */
  keyPresentation: Record<string, { k?: Presentation; v?: PresentationTable }>;
  commentBefore: string | null;
  comment: string | null;
}

const asRow = (item: unknown, position: number): ShreddedRow => {
  const value = (item as Node | undefined)?.toJSON?.() ?? item;
  const presentation: PresentationTable = {};
  collectInner(item, [], presentation);
  return {
    position,
    data: JSON.stringify(value ?? null),
    value,
    presentation: Object.keys(presentation).length === 0 ? null : JSON.stringify(presentation),
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
  const keyPresentation: Record<string, { k?: Presentation; v?: PresentationTable }> = {};
  let rows: ShreddedRow[] = [];

  if (isMap(contents)) {
    for (const pair of contents.items) {
      const name = String((pair.key as Node | undefined)?.toJSON?.() ?? pair.key);
      order.push(name);
      recordKeyPresentation(keyPresentation, name, pair.key, pair.value);
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
      keyPresentation,
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
    /** Everything about those two nodes that is not a comment — chiefly the BLANK LINE above
     * `demo:`, which is how a 782-line file separates one queue from the next. */
    presentation: string | null;
    rows: ShreddedRow[];
  }[];
  leftovers: DocumentLeftovers;
} {
  const contents = doc.contents;
  const order: string[] = [];
  const values: Record<string, unknown> = {};
  const keyPresentation: Record<string, { k?: Presentation; v?: PresentationTable }> = {};
  const groups: {
    name: string;
    position: number;
    comments: RowComments;
    listComments: RowComments;
    presentation: string | null;
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
          presentation: queuePresentation(pair.key, pair.value),
          rows: pair.value.items.map(asRow),
        });
      } else {
        values[name] = (pair.value as Node | undefined)?.toJSON?.() ?? pair.value;
        // A queue's comments ride on its own row; only a leftover key needs them here.
        recordKeyPresentation(keyPresentation, name, pair.key, pair.value);
      }
    });
  }

  return {
    groups,
    leftovers: {
      order,
      values,
      keyPresentation,
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
      const presentation = leftovers.keyPresentation?.[name];
      unslot(pair.key, presentation?.k);
      if (presentation?.v) restoreInner(pair.value, [], presentation.v);
    }
  }

  return doc;
}
