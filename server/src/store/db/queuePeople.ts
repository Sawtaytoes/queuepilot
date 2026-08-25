// `queue_people` as rows — WP-5's half of the book of record.
//
// The model and every rule it holds are in `server/src/queuePeople.ts`; this file is the SQL
// and nothing else. Two things it inherits from its neighbours and must not lose:
//
//   * **Every write goes through `prepareChecked`.** node:sqlite binds NULL for a named
//     parameter the caller forgot, where better-sqlite3 throws (driver difference #6). On
//     this table an omitted `:role` is a person silently demoted out of Must be here, which
//     changes which queues come up and reports nothing.
//   * **A member id is never matched by NAME.** It arrives already decided, from the trays or
//     from the migration's group-claim join. There is no `findMemberByLabel` here and there
//     must not be one.
import { bumpVersion } from './common.js';
import { bookOfRecord, prepareChecked } from './open.js';
import {
  isMemberKind,
  isMemberRole,
  type MemberKind,
  type MemberRole,
  type QueueMember,
} from '../../queuePeople.js';
import type { SqliteDatabase } from '../sqlite.js';

interface MemberRow {
  set_id: string;
  member_kind: string;
  member_id: string;
  role: string;
  position: number;
}

const toMember = (row: MemberRow): QueueMember => ({
  id: row.member_id,
  kind: isMemberKind(row.member_kind) ? row.member_kind : 'person',
  position: row.position,
  role: isMemberRole(row.role) ? row.role : 'required',
});

/**
 * Order is `role` first and `position` second, so a read comes back tray by tray and the
 * caller never sorts. 'optional' sorts before 'required' alphabetically, which is the wrong
 * way round for a screen that reads Must be here first — hence the CASE.
 */
const MEMBER_ORDER = "ORDER BY CASE role WHEN 'required' THEN 0 ELSE 1 END, position, member_id";

/** One queue's members, Must-be-here first. */
export function queueMembers(setId: string, db: SqliteDatabase = bookOfRecord()): QueueMember[] {
  return prepareChecked<MemberRow>(
    db,
    `SELECT set_id, member_kind, member_id, role, position FROM queue_people WHERE set_id = :set_id ${MEMBER_ORDER}`,
  )
    .all({ set_id: setId })
    .map(toMember);
}

/** Every queue's members at once, keyed by set id — two statements for the whole page rather
 *  than one per shelf. */
export function membersByQueue(db: SqliteDatabase = bookOfRecord()): Map<string, QueueMember[]> {
  const out = new Map<string, QueueMember[]>();
  for (const row of prepareChecked<MemberRow>(
    db,
    `SELECT set_id, member_kind, member_id, role, position FROM queue_people ${MEMBER_ORDER.replace('ORDER BY', 'ORDER BY set_id,')}`,
  ).all()) {
    out.set(row.set_id, [...(out.get(row.set_id) ?? []), toMember(row)]);
  }
  return out;
}

/**
 * Replace one queue's members. The list IS the trays and the order within them.
 *
 * All-or-nothing on purpose, exactly like `setPersonAccounts`: passing `[]` empties the
 * queue's audience, which is the only way the editor can express "move everybody back to
 * Everyone else". A per-member merge would make removing somebody impossible through this
 * door.
 *
 * Not transactional by itself — `routes/peopleRoutes.ts` wraps it, so a refused member never
 * leaves half a roster behind.
 */
export function setQueueMembers(
  setId: string,
  members: readonly QueueMember[],
  db: SqliteDatabase = bookOfRecord(),
): void {
  prepareChecked(db, 'DELETE FROM queue_people WHERE set_id = :set_id').run({ set_id: setId });

  const insert = prepareChecked(
    db,
    'INSERT OR REPLACE INTO queue_people (set_id, member_kind, member_id, role, position) ' +
      'VALUES (:set_id, :member_kind, :member_id, :role, :position)',
  );

  // Position is re-numbered PER TRAY from the incoming order, so a caller that hands over two
  // lists concatenated does not have to invent a global index that then means nothing.
  const next: Record<MemberRole, number> = { optional: 0, required: 0 };
  for (const member of members) {
    const id = String(member.id ?? '').trim();
    if (!id) throw new Error(`queue '${setId}' has a member with no id`);
    const role: MemberRole = isMemberRole(member.role) ? member.role : 'required';
    const kind: MemberKind = isMemberKind(member.kind) ? member.kind : 'person';
    insert.run({
      member_id: id,
      member_kind: kind,
      position: next[role]++,
      role,
      set_id: setId,
    });
  }
}

/** Forget a queue's audience. Called when the SET is deleted — there is no cascade, on
 *  purpose (see the schema), so the delete path names it explicitly. */
export function deleteQueueMembers(setId: string, db: SqliteDatabase = bookOfRecord()): number {
  const result = prepareChecked(db, 'DELETE FROM queue_people WHERE set_id = :set_id').run({
    set_id: setId,
  });
  return Number(result.changes);
}

/** Remove one person or group from EVERY queue — what a person's deletion means, since the
 *  table cannot carry a foreign key to two different parents. */
export function forgetMember(
  kind: MemberKind,
  memberId: string,
  db: SqliteDatabase = bookOfRecord(),
): number {
  const result = prepareChecked(
    db,
    'DELETE FROM queue_people WHERE member_kind = :member_kind AND member_id = :member_id',
  ).run({ member_id: memberId, member_kind: kind });
  return Number(result.changes);
}

/**
 * Members naming a person or group that no longer exists — the report standing in for the two
 * foreign keys this table deliberately does not have.
 *
 * ⚠️ Under `STORE_BACKEND=yaml` the `groups` and `sets` tables are empty by design, so every
 * group member looks orphaned there. A non-empty answer is a thing to LOOK AT, never a thing
 * to delete. Same warning `orphanGroupIds()` carries, and for the same reason.
 */
export function orphanQueueMembers(db: SqliteDatabase = bookOfRecord()): QueueMember[] {
  return prepareChecked<MemberRow>(
    db,
    `SELECT qp.set_id, qp.member_kind, qp.member_id, qp.role, qp.position FROM queue_people qp
       LEFT JOIN people p ON qp.member_kind = 'person' AND p.id = qp.member_id
       LEFT JOIN groups g ON qp.member_kind = 'group'  AND g.id = qp.member_id
      WHERE p.id IS NULL AND g.id IS NULL
      ORDER BY qp.set_id, qp.member_kind, qp.member_id`,
  )
    .all()
    .map(toMember);
}

/** Record that the queue audience changed. Call INSIDE the transaction that wrote the rows —
 *  `people` is the store these rows belong to, the way `group_people` does. */
export const bumpQueuePeopleVersion = (db: SqliteDatabase = bookOfRecord()): void =>
  bumpVersion(db, 'people');
