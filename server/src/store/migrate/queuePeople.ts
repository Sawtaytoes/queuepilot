// MIGRATION DAY for WP-5 — the sixteen hand-typed queue labels become people and an activity.
//
// ── What the labels are, and what happens to them ────────────────────────────────────────
//
// A queue used to be a string somebody typed. WP-5 makes it required people + optional people
// + one activity, and the label is *data to migrate FROM, not a field to preserve*
// (decision 2026-08-25-a-queue-is-people-plus-an-activity §4). So this file's job is to
// recover the two facts, and its rule is that it recovers them from EVIDENCE or not at all.
//
// ── The activity is derived and this file does not touch it ──────────────────────────────
//
// Every provider serves exactly one activity, so `activity.ts` answers it as a lookup for
// every one of the sixteen. Nothing is written, nothing is stamped, `sets.yaml` is not opened.
// That is deliberate and it is the cheapest half of the migration: a stamped value would
// freeze today's provider→activity opinion into sixteen files and then disagree with the table
// the first time it moved.
//
// ── The people come from the GROUP CLAIM, which is a join and not a guess ────────────────
//
// A group already claims its sets by id — `groups.yaml`'s `sets:` list, the EXPLICIT half of
// membership that `groups.ts` says beats the derived half. So "which people is this queue
// for" has a real answer for every claimed set: the people of the groups that claim it. It is
// a primary-key join. Nobody parses "Family — Movies" and nobody matches a name.
//
// ⚠️ THE LABELS ARE NOT PARSED, AND THAT IS THE POINT. This is the same discipline the WP-3
// mapping file exists to hold: a heuristic willing to read people out of a label would have to
// invent four group rosters, and what it corrupts — who a queue is for, and therefore which
// profile it signs into — is silent. A queue no group claims gets NO ROWS and opens with
// everybody in "Everyone else", which is one drag to fix and impossible to get wrong.
//
// ── What it will not overwrite ───────────────────────────────────────────────────────────
//
// A queue that already has members is left alone, always, even on a forced re-run. The seed is
// a starting point for a screen the owner then edits; a migration that reasserted itself over
// his edits would undo them on every restart.
import { STORE_BACKEND } from '../../config.js';
import { errMessage } from '../../errors.js';
import type { QueueMember } from '../../queuePeople.js';
import { bookOfRecord, prepareChecked } from '../db/open.js';
import { setQueueMembers, bumpQueuePeopleVersion } from '../db/queuePeople.js';
import { readPeopleMeta, writePeopleMeta } from '../db/people.js';
import { ensureImported } from './yaml.js';

/** What one run did. Reported rather than logged only, so a test can assert on it. */
export interface QueuePeopleSeedReport {
  seeded: boolean;
  reason: string;
  /** Set ids that gained members, and how many each got. */
  seededSets: { setId: string; memberCount: number }[];
  /** Set ids a group claimed that are not in the registry — reported, never written. */
  unknownSetIds: string[];
  /** Queues no group claims. They are not a failure; they are the ones the owner drags. */
  unclaimedSetIds: string[];
  /** Queues left alone because somebody had already edited them. */
  skippedSetIds: string[];
}

const EMPTY: Omit<QueuePeopleSeedReport, 'seeded' | 'reason'> = {
  seededSets: [],
  skippedSetIds: [],
  unclaimedSetIds: [],
  unknownSetIds: [],
};

/** The marker that says this ran. Kept under the `people` store beside the mapping
 *  fingerprint, because a queue's audience is people data. */
const SEEDED_KEY = 'queue_people_seeded_at';

interface ClaimRow {
  group_id: string;
  set_id: string;
}

/**
 * Every (group, set) claim in the store, read out of the groups' JSON.
 *
 * `json_each` over `data -> '$.sets'` rather than a TypeScript loop, so the claim list is read
 * the same way the queryable columns are — from the payload, with no second copy to drift.
 * A group with no `sets:` key contributes nothing; `json_each` over a missing path is zero
 * rows, not an error.
 */
function claims(db = bookOfRecord()): ClaimRow[] {
  return prepareChecked<ClaimRow>(
    db,
    `SELECT g.id AS group_id, json_each.value AS set_id
       FROM groups g, json_each(g.data, '$.sets')
      WHERE json_type(g.data, '$.sets') = 'array'
      ORDER BY g.position, json_each.key`,
  ).all();
}

/**
 * Seed `queue_people` from the group claims. Idempotent, and safe to call on every start.
 *
 * `force` re-runs after the marker is set — a deliberate re-seed — but never overwrites a
 * queue that already has members. There is no flag that does; see the header.
 */
export function seedQueuePeople({ force = false } = {}): QueuePeopleSeedReport {
  if (STORE_BACKEND === 'yaml') {
    return { ...EMPTY, reason: 'STORE_BACKEND=yaml has no queue_people table', seeded: false };
  }

  ensureImported();
  const db = bookOfRecord();

  if (!force && readPeopleMeta(SEEDED_KEY, db)) {
    return { ...EMPTY, reason: 'already seeded', seeded: false };
  }

  const registrySetIds = new Set(
    prepareChecked<{ id: string }>(db, 'SELECT id FROM sets').all().map((row) => row.id),
  );
  const withMembers = new Set(
    prepareChecked<{ set_id: string }>(db, 'SELECT DISTINCT set_id FROM queue_people')
      .all()
      .map((row) => row.set_id),
  );

  const bySet = new Map<string, string[]>();
  const unknownSetIds: string[] = [];

  for (const claim of claims(db)) {
    const setId = String(claim.set_id ?? '').trim();
    if (!setId) continue;
    if (!registrySetIds.has(setId)) {
      // A group claiming a set that no longer exists is a real state the app has always
      // tolerated — `groups.ts` resolves membership against the registry and simply does not
      // find it. Reported so somebody can look, never repaired here.
      if (!unknownSetIds.includes(setId)) unknownSetIds.push(setId);
      continue;
    }
    const groups = bySet.get(setId) ?? [];
    if (!groups.includes(claim.group_id)) groups.push(claim.group_id);
    bySet.set(setId, groups);
  }

  const seededSets: { setId: string; memberCount: number }[] = [];
  const skippedSetIds: string[] = [];

  db.withTransaction(() => {
    for (const [setId, groupIds] of bySet) {
      if (withMembers.has(setId)) {
        skippedSetIds.push(setId);
        continue;
      }
      // The GROUP is the member, not its people. That is what carries "at least one of them"
      // through to the queue — flattening here would turn "either of the kids" into "both".
      const members: QueueMember[] = groupIds.map((groupId, position) => ({
        id: groupId,
        kind: 'group',
        position,
        role: 'required',
      }));
      setQueueMembers(setId, members, db);
      seededSets.push({ memberCount: members.length, setId });
    }
    writePeopleMeta(SEEDED_KEY, new Date().toISOString(), db);
    bumpQueuePeopleVersion(db);
  });

  const unclaimedSetIds = [...registrySetIds].filter((id) => !bySet.has(id)).sort();

  return {
    reason: force ? 'forced' : 'first run',
    seeded: true,
    seededSets,
    skippedSetIds: skippedSetIds.sort(),
    unclaimedSetIds,
    unknownSetIds: unknownSetIds.sort(),
  };
}

let hasRun = false;

/**
 * The boot hook. Runs once per process and swallows its own failure.
 *
 * Swallowed on purpose: this is a convenience seed for a screen, not a correctness step. An
 * app that will not start because a group claimed a set id with a typo in it is a worse
 * outcome than an app whose trays open empty.
 */
export function ensureQueuePeopleSeeded(): QueuePeopleSeedReport {
  if (hasRun) return { ...EMPTY, reason: 'already run in this process', seeded: false };
  hasRun = true;

  try {
    const report = seedQueuePeople();
    if (report.seeded && report.seededSets.length) {
      const places = report.seededSets.reduce((sum, row) => sum + row.memberCount, 0);
      console.log(
        `[queue-people] seeded ${report.seededSets.length} queue(s) with ${places} member(s) from the group claims` +
          (report.unclaimedSetIds.length
            ? `; ${report.unclaimedSetIds.length} queue(s) are claimed by no group and open with everybody in Everyone else`
            : ''),
      );
    }
    if (report.unknownSetIds.length) {
      console.log(
        `[queue-people] ${report.unknownSetIds.length} claimed set id(s) are not in the registry: ${report.unknownSetIds.join(', ')}`,
      );
    }
    return report;
  } catch (e) {
    console.log(`[queue-people] seed skipped: ${errMessage(e)}`);
    return { ...EMPTY, reason: errMessage(e), seeded: false };
  }
}

/** For tests: forget that this process already ran. */
export function resetQueuePeopleSeedState(): void {
  hasRun = false;
}
