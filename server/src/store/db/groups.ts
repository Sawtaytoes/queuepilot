// The groups, as rows. `groups` + the leftovers in `store_meta`.
//
// Same interface as `store/groups.ts` (GroupsStore), including its two peculiarities, which
// are the file's and not this implementation's:
//
//   * `readSync` SWALLOWS a failure and returns `{}`. groups.yaml is OPTIONAL and this process
//     also serves the web UI, so losing the whole app to a bad group file is the worse
//     failure. Kept, because the reason has not changed.
//   * There is no advisory lock, because no second process ever wrote this file. `withLock` is
//     not on `GroupsStore` at all — the mutations in `groups.ts` are already serialized by the
//     single writer they go through.
//
// `groups.id` is a WIRE ID and a URL: `/g/<id>` is bookmarked and shared. Verbatim, like the
// set ids.
//
// The `sets:` claim list and the `accounts:` provider map stay INSIDE the row's JSON rather
// than becoming child tables. WP-3 replaces this model outright — a group becomes a saved set
// of people — so `group_sets` and `group_accounts` built tonight would be tables WP-3 has to
// drop. The relational split waits for the shape that will survive it.
import type { Document } from 'yaml';

import { STORE_YAML_MIRROR } from '../../config.js';
import { errMessage } from '../../errors.js';
import * as yamlGroups from '../groups.js';
import type { GroupsStore } from '../index.js';
import {
  applyComments,
  bumpVersion,
  nodeAt,
  readJsonMeta,
  writeMeta,
} from './common.js';
import { bookOfRecord, prepareChecked } from './open.js';
import {
  applyInnerComments,
  assemble,
  documentFrom,
  shredListDocument,
  type DocumentLeftovers,
} from './shred.js';
import { ensureImported, noteMirrorWrite } from '../migrate/yaml.js';

export const path = yamlGroups.path;

const EMPTY_LEFTOVERS: DocumentLeftovers = {
  order: ['groups'],
  values: {},
  keyComments: {},
  commentBefore: null,
  comment: null,
};

interface GroupRow {
  id: string;
  position: number;
  data: string;
  comment_before: string | null;
  comment: string | null;
  inner_comments: string | null;
}

const rows = (): GroupRow[] =>
  prepareChecked<GroupRow>(
    bookOfRecord(),
    'SELECT id, position, data, comment_before, comment, inner_comments FROM groups ORDER BY position',
  ).all();

const leftovers = (): DocumentLeftovers =>
  readJsonMeta(bookOfRecord(), 'groups', 'leftovers', EMPTY_LEFTOVERS);

const count = (): number =>
  Number(
    (prepareChecked<{ n: number }>(bookOfRecord(), 'SELECT COUNT(*) AS n FROM groups').get()?.n) ?? 0,
  );

export function readSync(): Record<string, unknown> {
  try {
    ensureImported();
    return assemble(leftovers(), { groups: rows().map((row) => JSON.parse(row.data) as unknown) });
  } catch (e) {
    console.log(`[groups] could not read the store: ${errMessage(e)}`);
    return {};
  }
}

export async function exists(): Promise<boolean> {
  ensureImported();
  return count() > 0;
}

/** Write the starter groups. Returns false when somebody already got there — which here means
 * the table is not empty, the same "losing the race is not an error" the file's `wx` had. */
export async function seed(groups: readonly unknown[]): Promise<boolean> {
  ensureImported();
  if (count() > 0) return false;
  const doc = documentFrom({ groups: [...groups] }, EMPTY_LEFTOVERS);
  await writeDoc(doc);
  console.log(`[groups] seeded the store with ${groups.length} group(s) from the registry`);
  // The mirror is what keeps `groups.yaml` present for the rollback release; the seed header
  // is the YAML store's and only reaches the file through its own seeder.
  if (STORE_YAML_MIRROR) await yamlGroups.seed(groups);
  return true;
}

export async function readDoc(): Promise<Document> {
  ensureImported();
  const groupRows = rows();
  const meta = leftovers();
  const doc = documentFrom(
    assemble(meta, { groups: groupRows.map((row) => JSON.parse(row.data) as unknown) }),
    meta,
  );
  groupRows.forEach((row, index) => {
    const node = nodeAt(doc, ['groups', index]);
    applyComments(node, row);
    applyInnerComments(node, row.inner_comments);
  });
  return doc;
}

export async function writeDoc(doc: Document): Promise<void> {
  const db = bookOfRecord();
  const { rows: shredded, leftovers: meta } = shredListDocument(doc, 'groups');

  db.withTransaction(() => {
    prepareChecked(db, 'DELETE FROM groups').run();
    const insert = prepareChecked(
      db,
      'INSERT INTO groups (id, position, data, comment_before, comment, inner_comments) ' +
        'VALUES (:id, :position, :data, :comment_before, :comment, :inner_comments)',
    );
    for (const row of shredded) {
      const id = (row.value as { id?: unknown } | null)?.id;
      if (id == null || String(id) === '') continue;
      insert.run({
        id: String(id),
        position: row.position,
        data: row.data,
        comment_before: row.comment_before,
        comment: row.comment,
        inner_comments: row.inner_comments,
      });
    }
    writeMeta(db, 'groups', 'leftovers', JSON.stringify(meta));
    bumpVersion(db, 'groups');
  });

  if (STORE_YAML_MIRROR) {
    await yamlGroups.writeDoc(doc);
    // The files now hold what the rows hold. Recording that here is what stops the next
    // read treating our own mirror write as somebody else's hand-edit.
    noteMirrorWrite();
  }
}

export const store: GroupsStore = {
  path,
  readSync,
  exists,
  seed,
  readDoc,
  writeDoc,
};
