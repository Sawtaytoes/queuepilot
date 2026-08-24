// The Document ⇄ rows round trip, which is what the whole store rests on.
//
// The fixture is written to be awkward on purpose: a top-level key beside the list, a flow
// sequence, a nested mapping, a comment in each of the three positions a comment can hold, and
// an entry with every override. If the shredder can carry these back out, it can carry the
// live registry.
//
// The cast is Bob / Alice / Carol — this repo's existing placeholders. It is public.
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

import { applyComments, nodeAt } from './common.js';
import {
  applyPresentation,
  assemble,
  documentFrom,
  shredListDocument,
  shredMapOfListsDocument,
} from './shred.js';

const SETS = `# HEAD: the registry. id is IMMUTABLE.
global:
  excluded_sections: [2, 7]
sets:
- id: bob                 # INNER: attached to \`id:\`'s VALUE, not to the set — see below
  label: Bob — Movies
  sections: [1, 14]
# BLOCK: the reel is non-consuming.
- id: demo
  label: Demo Reel
  keep_completed: true
  profiles:
  - plex_user: Carol
    watch_count_accounts: [700001]
`;

const QUEUES = `# HEAD: top plays next.
bob:
- {ratingKey: "265786", title: "Movie A (2009)"}   # INLINE: rides on the entry
- {ratingKey: 361504, title: "Movie B (1999)"}
- {collection: "A Collection"}
- {ratingKey: "453078", title: "Show Alpha", episodes: 3, weight: 4, start: {season: 2, episode: 5}}

# BLOCK: the reel.
demo:
- {ratingKey: "192289", title: "Logo Sting"}
empty: []
`;

describe('shredListDocument', () => {
  it('splits the list into rows and keeps everything else as leftovers', () => {
    const { rows, leftovers } = shredListDocument(parseDocument(SETS), 'sets');

    expect(rows.map((row) => (row.value as { id: string }).id)).toEqual(['bob', 'demo']);
    expect(rows[1]?.comment_before).toContain('BLOCK');
    expect(leftovers.order).toEqual(['global', 'sets']);
    expect(leftovers.values).toEqual({ global: { excluded_sections: [2, 7] } });
  });

  it('carries a comment attached to a key INSIDE the mapping, which no row owns', () => {
    // `comment_before` and `comment` are the block above the row and the trailing one on its
    // own line. Neither covers a comment on a FIELD — `requires_profile: x  # …`, or (as here)
    // the trailing comment on a block item's first line, which the parser gives to that key's
    // VALUE node. Those are the comments that carry the operational knowledge, so they get
    // their own column keyed by the path from the row's node.
    //
    // Measured on the live files on 2026-08-23 with this in place: sets.yaml 34 comment lines
    // in and 34 out, queues.yaml 45 in and 45 out. Without it the count was 30 and 44.
    const { rows } = shredListDocument(parseDocument(SETS), 'sets');
    expect(rows[0]?.comment).toBeNull();
    expect(rows[0]?.presentation).toContain('INNER');
  });

  it('records HOW a node was written, not only what it holds', () => {
    // Style is in the same column as the inner comments, because it is the same kind of thing:
    // everything about the row that is not its value. Without it every hand-typed
    // `- {title: "X"}` in queues.yaml would be rewritten as a block mapping on the first save,
    // and `history.ts`'s byte-for-byte restore would be nearly-byte-for-byte.
    const { groups } = shredMapOfListsDocument(parseDocument(QUEUES));
    // `- {ratingKey: "265786", …}` is a FLOW mapping, and `f` at the row's own root is what
    // brings it back as one.
    expect(groups[0]?.rows[0]?.presentation).toContain('"f":true');
    // …and a blank line above a queue key is not a comment, so it has its own flag.
    expect(groups.find((group) => group.name === 'demo')?.presentation).toContain('"s":true');
  });

  it('keeps the FILE HEADER, which lives on the first key and not on the document', () => {
    // The trap this test exists for: `yaml` only puts a leading comment block on
    // `doc.commentBefore` when a blank line separates it from the first key. sets.yaml's
    // 1,733-character header has no such break, so it belongs to `global:`. Recording only the
    // document-level pair dropped the whole header on the first write, silently, and the
    // projection still looked right.
    const { leftovers } = shredListDocument(parseDocument(SETS), 'sets');
    expect(leftovers.keyPresentation.global?.k?.b).toContain('HEAD');
  });

  it('round-trips to a document that parses back to the same value', () => {
    const original = parseDocument(SETS);
    const { rows, leftovers } = shredListDocument(original, 'sets');
    const rebuilt = documentFrom(assemble(leftovers, { sets: rows.map((row) => row.value) }), leftovers);
    // The stores put the ROW comments back after building the document, because only they know
    // which row is at which index. Mirrored here so the round trip under test is the real one.
    rows.forEach((row, index) => {
      applyComments(nodeAt(rebuilt, ['sets', index]), row);
    });

    expect(rebuilt.toJSON()).toEqual(original.toJSON());
    const text = rebuilt.toString({ indentSeq: false, lineWidth: 0 });
    expect(text).toContain('# HEAD');
    expect(text).toContain('# BLOCK');
  });

  it('restores an inner comment onto the field it explains', () => {
    const original = parseDocument(SETS);
    const { rows, leftovers } = shredListDocument(original, 'sets');
    const rebuilt = documentFrom(assemble(leftovers, { sets: rows.map((row) => row.value) }), leftovers);
    rows.forEach((row, index) => {
      const node = nodeAt(rebuilt, ['sets', index]);
      applyComments(node, row);
      applyPresentation(node, row.presentation);
    });

    expect(rebuilt.toString({ indentSeq: false, lineWidth: 0 })).toMatch(/id: bob\s+# INNER/);
  });

  it('keeps a nested mapping and a nested list of mappings intact', () => {
    const { rows } = shredListDocument(parseDocument(SETS), 'sets');
    expect(rows[1]?.value).toEqual({
      id: 'demo',
      label: 'Demo Reel',
      keep_completed: true,
      profiles: [{ plex_user: 'Carol', watch_count_accounts: [700001] }],
    });
  });

  it('keeps a top-level key that is NOT the list rather than dropping it', () => {
    const { leftovers } = shredListDocument(parseDocument('other: 3\nsets: []\n'), 'sets');
    expect(leftovers.values).toEqual({ other: 3 });
  });
});

describe('shredMapOfListsDocument', () => {
  it('gives every top-level key its own group, in file order', () => {
    const { groups } = shredMapOfListsDocument(parseDocument(QUEUES));
    expect(groups.map((group) => group.name)).toEqual(['bob', 'demo', 'empty']);
    expect(groups.map((group) => group.position)).toEqual([0, 1, 2]);
  });

  it('keeps the EMPTY queue, which is the one an entries-only design would delete', () => {
    const { groups } = shredMapOfListsDocument(parseDocument(QUEUES));
    expect(groups.find((group) => group.name === 'empty')?.rows).toEqual([]);
  });

  it('keeps a numeric ratingKey a number and a string one a string', () => {
    // The file has both, and the JSON payload is what preserves the difference. A column would
    // have had to pick one.
    const { groups } = shredMapOfListsDocument(parseDocument(QUEUES));
    const entries = groups[0]?.rows.map((row) => row.value) ?? [];
    expect(entries[0]).toEqual({ ratingKey: '265786', title: 'Movie A (2009)' });
    expect(entries[1]).toEqual({ ratingKey: 361504, title: 'Movie B (1999)' });
  });

  it('keeps every per-entry override, including a nested `start`', () => {
    const { groups } = shredMapOfListsDocument(parseDocument(QUEUES));
    expect(groups[0]?.rows[3]?.value).toEqual({
      ratingKey: '453078',
      title: 'Show Alpha',
      episodes: 3,
      weight: 4,
      start: { season: 2, episode: 5 },
    });
  });

  it('carries the comments on the queue KEY and on the entry', () => {
    const { groups } = shredMapOfListsDocument(parseDocument(QUEUES));
    expect(groups[0]?.rows[0]?.comment).toContain('INLINE');
    expect(groups.find((group) => group.name === 'demo')?.comments.comment_before).toContain('BLOCK');
  });

  it('round-trips to the same value', () => {
    const original = parseDocument(QUEUES);
    const { groups, leftovers } = shredMapOfListsDocument(original);
    const byQueue = Object.fromEntries(
      groups.map((group) => [group.name, group.rows.map((row) => row.value)]),
    );
    expect(documentFrom(assemble(leftovers, byQueue), leftovers).toJSON()).toEqual(original.toJSON());
  });
});

describe('assemble', () => {
  it('puts the top-level keys back in FILE order, not insertion order', () => {
    const leftovers = {
      order: ['global', 'sets'],
      values: { global: { excluded_sections: [] } },
      keyPresentation: {},
      commentBefore: null,
      comment: null,
    };
    expect(Object.keys(assemble(leftovers, { sets: [] }))).toEqual(['global', 'sets']);
  });

  it('appends a key the recorded order has never seen rather than losing it', () => {
    const leftovers = { order: ['sets'], values: {}, keyPresentation: {}, commentBefore: null, comment: null };
    expect(Object.keys(assemble(leftovers, { sets: [], newcomer: [] }))).toEqual(['sets', 'newcomer']);
  });
});
