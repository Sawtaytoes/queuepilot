// The PEOPLE surface — the roster, a group's membership rule, and a queue's trays.
//
// WP-3 landed people as rows and served none of them. WP-5 is what puts them on a screen, so
// this is the first route file that reads the `people` table.
//
// ── Two things it refuses, and why each one is a refusal rather than a repair ────────────
//
//   1. **A member that names nobody.** A person id or group id that is not in the store is a
//      400, not a silently dropped row. The trays send back what they were given; an id the
//      server has never heard of means the two disagree about the household, and writing the
//      rest of the list would hide that.
//   2. **A group that cannot resolve to ONE provider profile.** This is the constraint the
//      whole group model exists to protect: a queue keyed on Older Kids signs into the Older
//      Kids Plex profile no matter which of the kids turned up. A group whose accounts offer
//      two answers would sign into whichever sorted first, so it is refused at the edge with
//      both candidates named — `queuePeople.ts groupPlayProfile()`.
//
// ── Personal data ────────────────────────────────────────────────────────────────────────
//
// Code here, names in `/config/queuepilot.sqlite`. Nothing in this file spells a household
// member.
//
// ⚠️ **`/people` PROJECTS, and widening it is a deliberate act.** The stored `Person` also
// carries provider accounts, a birth year, a maximum game weight and a beginner flag. None of
// those paints a checklist or a tray, and a birth year is household data with no business
// crossing the wire to do it. Three fields go out — id, display name, roster position — which
// is WP-6's rule and is kept here unchanged rather than relaxed because a second screen turned
// up. The trays need a NAME and a FACE, and the face is hashed from the id.
import { Hono } from 'hono';

import { errMessage } from '../errors.js';
import { storedGroups } from '../groups.js';
import * as sets from '../sets.js';
import {
  isMemberKind,
  isMemberRole,
  membershipProblems,
  groupPlayProfile,
  type GroupMembership,
  type GroupRosterMember,
  type MemberRole,
  type QueueMember,
} from '../queuePeople.js';
import { bookOfRecord } from '../store/db/open.js';
import {
  bumpPeopleVersion,
  groupMembership,
  listPeople,
  minPresentByGroup,
  rosterMembersByGroup,
  setGroupMinPresent,
  setGroupPeople,
} from '../store/db/people.js';
import {
  bumpQueuePeopleVersion,
  membersByQueue,
  orphanQueueMembers,
  queueMembers,
  setQueueMembers,
} from '../store/db/queuePeople.js';
import { readBody } from './readBody.js';

/** The roster and every group's rule, in one call — what the queue editor's three trays are
 *  built from. Two round trips would let the trays paint a person the rules no longer know. */
