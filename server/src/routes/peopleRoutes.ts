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
// is WP-6's rule, kept here unchanged rather than relaxed because a second screen turned up.
// A tray needs a NAME and a FACE, and the face is hashed from the id.
import { Hono } from 'hono';

import { errMessage } from '../errors.js';
import { slugify, storedGroups } from '../groups.js';
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
  deletePerson,
  getPerson,
  groupMembership,
  listPeople,
  minPresentByGroup,
  rosterMembersByGroup,
  setGroupMinPresent,
  setGroupPeople,
  upsertPerson,
} from '../store/db/people.js';
import {
  bumpQueuePeopleVersion,
  membersByQueue,
  orphanQueueMembers,
  queueMembers,
  setQueueMembers,
} from '../store/db/queuePeople.js';
import { readBody } from './readBody.js';

/**
 * The roster and every group's rule, in one call — what the Tonight checklist and the queue
 * editor's audience list is built from. Two endpoints would let the list paint a person
 * the rules no longer know about.
 *
 * `people` keeps the shape WP-6 shipped, so both screens hold one contract; WP-5 adds `groups`
 * and `orphans` beside it. `listPeople()` already answers in `position, id` order and THE ARRAY
 * ORDER IS THE CONTRACT — a roster order is somebody's decision, and re-sorting it in the
 * browser throws that away.
 *
 * Under `STORE_BACKEND=yaml` every table here is empty by design, so this answers empty lists
 * rather than failing. An empty roster is a real state on a fresh install too: the import is
 * gated and may simply not have been run.
 */
export function peopleRoutes(): Hono {
  const app = new Hono();

  app.get('/people', (c) => {
    try {
      const rosters = rosterMembersByGroup();
      const minimums = minPresentByGroup();
      return c.json({
        // A GROUP is a saved set of people, so it rides along here rather than in a second
        // call: the trays show people and groups side by side, as one pool of cards.
        groups: storedGroups().map((group) => ({
          id: group.id,
          label: group.label,
          minPresent: minimums.get(group.id) ?? null,
          roster: rosters.get(group.id) ?? [],
        })),
        // THE PROJECTION — see the header. Three fields, and no accounts, birth year, weight
        // ceiling or beginner flag.
        people: listPeople().map((person) => ({
          displayName: person.displayName,
          id: person.id,
          position: person.position,
        })),
        // Members naming somebody who is gone. Reported, never deleted — the table carries no
        // foreign key on purpose and this is the report that stands in for it.
        orphans: orphanQueueMembers(),
      });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 500);
    }
  });

  /** Every queue's trays at once, so the shelf list paints faces without one call per shelf. */
  app.get('/queue-people', (c) => {
    try {
      return c.json({ queues: Object.fromEntries(membersByQueue()) });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 500);
    }
  });

  app.get('/sets/:id/people', (c) => {
    try {
      return c.json({ members: queueMembers(c.req.param('id')) });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 500);
    }
  });

  /**
   * Replace one queue's trays. Body: `{members: [{kind, id, role}]}`.
   *
   * All-or-nothing, and `[]` is a legitimate body meaning "everybody back to Everyone else".
   * That is the only way the editor can express an empty audience, so it must not be confused
   * with a missing field — a body with no `members` key is a 400.
   */
  app.put('/sets/:id/people', async (c) => {
    const setId = c.req.param('id');
    try {
      const body = await readBody(c);
      if (!Array.isArray(body.members)) return c.json({ error: 'members[] required' }, 400);

      const members = body.members.map((raw, index) => toMember(raw, index));
      const problems = await memberProblems(members);
      if (problems.length) return c.json({ error: problems.join('; '), problems }, 400);

      const db = bookOfRecord();
      db.withTransaction(() => {
        setQueueMembers(setId, members, db);
        bumpQueuePeopleVersion(db);
      });
      return c.json({ members: queueMembers(setId), ok: true });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  /**
   * ADD a person. Body: `{displayName}`.
   *
   * Until this route the roster could only arrive through `store/migrate/people.ts` — the
   * owner-confirmed mapping file in `/config` — so adding somebody meant editing YAML on the
   * appliance and restarting the app. That is the same complaint the groups editor was built
   * to answer: *"All those configs are managed by you, not inside the app."*
   *
   * The mapping file KEEPS working and is not touched here. It owns only the rows it names
   * (`store/migrate/people.ts`: "a person in the database the file has never heard of is
   * untouched"), which is precisely what makes a hand-added person safe beside it.
   *
   * ⚠️ **The id is generated once from the name and is immutable after.** A person id is a
   * WIRE ID — `queue_people` and `group_people` both store it — so it follows `slugify`'s
   * contract, not the display name's. Renaming somebody never moves their id, which is also
   * what keeps their colour: `PersonFace` hashes the ID into a hue exactly so a rename does
   * not repaint them.
   */
  app.post('/people', async (c) => {
    try {
      const displayName = String((await readBody(c)).displayName ?? '').trim();
      if (!displayName) return c.json({ error: 'a person needs a name' }, 400);

      const base = slugify(displayName);
      if (!base)
        return c.json({ error: `'${displayName}' has no letters or digits to make an id from` }, 400);

      const roster = listPeople();
      const taken = new Set(roster.map((person) => person.id));
      // Two people may legitimately share a name, so the ID de-duplicates rather than the save
      // failing — the same answer `createGroup` gives, and for the same reason.
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;

      const db = bookOfRecord();
      db.withTransaction(() => {
        upsertPerson(
          {
            displayName,
            id,
            // Appended, never inserted. `listPeople()` answers in `position, id` order and
            // THAT ORDER IS THE CONTRACT the trays and the checklist paint in, so a new
            // person goes on the end rather than renumbering everybody who was already there.
            position: roster.reduce((max, person) => Math.max(max, person.position), -1) + 1,
            source: 'app',
          },
          db,
        );
        bumpPeopleVersion(db);
      });

      return c.json({ ok: true, person: projected(id) }, 201);
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  /**
   * RENAME a person. Body: `{displayName}`.
   *
   * A rename and nothing else. The stored `Person` also carries provider accounts, a birth
   * year, a maximum game weight and a beginner flag; none of those is projected out of
   * `/people` (see the header), so a route that accepted them would be writing household data
   * this surface has deliberately never shown. Those belong to the mapping file and to the
   * board-game picker, which is where they are read.
   */
  app.patch('/people/:id', async (c) => {
    const id = c.req.param('id');
    try {
      if (!getPerson(id)) return c.json({ error: `no such person '${id}'` }, 404);

      const body = await readBody(c);
      if (!('displayName' in body)) return c.json({ error: 'displayName required' }, 400);

      const displayName = String(body.displayName ?? '').trim();
      // Not a repair. `display_name` is NOT NULL with a `''` default, and a blank one paints a
      // nameless card with a "?" for a face — so it is refused here rather than allowed to
      // become a row nobody can identify on any screen.
      if (!displayName) return c.json({ error: 'a person needs a name' }, 400);

      const db = bookOfRecord();
      db.withTransaction(() => {
        upsertPerson({ displayName, id }, db);
        bumpPeopleVersion(db);
      });

      return c.json({ ok: true, person: projected(id) });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  /**
   * REMOVE a person, and every tray and roster that names them.
   *
   * `deletePerson()` already cascades all three tables — `person_accounts` and `group_people`
   * by foreign key, `queue_people` through its own `forgetMember` — so this is one call and
   * not a repair loop. The answer NAMES what went with them, because that is the part the
   * caller cannot see: removing somebody from the roster silently changes which queues come
   * up, and a bare `{ok: true}` would not say so.
   *
   * The un-filing is counted BEFORE the delete. Afterwards the rows are gone and the same
   * scan would answer "nothing", which is true and useless.
   */
  app.delete('/people/:id', (c) => {
    const id = c.req.param('id');
    try {
      if (!getPerson(id)) return c.json({ error: `no such person '${id}'` }, 404);

      const queues = [...membersByQueue()]
        .filter(([, members]) =>
          members.some((member) => member.kind === 'person' && member.id === id),
        )
        .map(([setId]) => setId);
      const groups = [...rosterMembersByGroup()]
        .filter(([, roster]) => roster.some((member) => member.personId === id))
        .map(([groupId]) => groupId);

      const db = bookOfRecord();
      db.withTransaction(() => {
        deletePerson(id, db);
        bumpPeopleVersion(db);
        // `queue_people` rows went too, so the trays payload changed and every shelf and
        // landing card reading it has to be told.
        bumpQueuePeopleVersion(db);
      });

      return c.json({ ok: true, unfiled: { groups, queues } });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  /**
   * One group's membership RULE. Body: `{minPresent, roster: [{personId, role}]}`.
   *
   * `minPresent: null` clears it back to "all of them"; omitting the key leaves it alone. The
   * two are different answers and this route keeps them different.
   */
  app.put('/groups/:id/membership', async (c) => {
    const groupId = c.req.param('id');
    try {
      const body = await readBody(c);
      const known = new Set(storedGroups().map((group) => group.id));
      if (!known.has(groupId)) return c.json({ error: `no such group '${groupId}'` }, 404);

      const roster: GroupRosterMember[] | null = Array.isArray(body.roster)
        ? body.roster.map((raw, position) => ({
            personId: String((raw as { personId?: unknown })?.personId ?? '').trim(),
            position,
            role: roleOf(raw),
          }))
        : null;

      const next: GroupMembership = {
        groupId,
        minPresent:
          'minPresent' in body
            ? body.minPresent == null
              ? null
              : Number(body.minPresent)
            : groupMembership(groupId).minPresent,
        roster: roster ?? groupMembership(groupId).roster,
      };

      const problems = membershipProblems(next);
      if (problems.length) return c.json({ error: problems.join('; '), problems }, 400);

      const db = bookOfRecord();
      db.withTransaction(() => {
        if (roster) setGroupPeople(groupId, roster, db);
        // Written AFTER the roster, always: `min_present` is validated against the required
        // half, so setting the number first and the people second could commit a rule that
        // needs three people over a roster of two.
        if ('minPresent' in body) setGroupMinPresent(groupId, next.minPresent, db);
        bumpPeopleVersion(db);
      });

      return c.json({ membership: groupMembership(groupId), ok: true });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  return app;
}

/** One person in the shape `/people` projects — three fields, so a write answers with exactly
 *  what a read would have said. Widening this widens the read too; see the file header. */
function projected(id: string): { displayName: string; id: string; position: number } | null {
  const person = getPerson(id);
  return person
    ? { displayName: person.displayName, id: person.id, position: person.position }
    : null;
}

const roleOf = (raw: unknown): MemberRole => {
  const role = (raw as { role?: unknown })?.role;
  return isMemberRole(role) ? role : 'required';
};

function toMember(raw: unknown, position: number): QueueMember {
  const value = (raw ?? {}) as { id?: unknown; kind?: unknown };
  const kind = value.kind;
  return {
    id: String(value.id ?? '').trim(),
    kind: isMemberKind(kind) ? kind : 'person',
    position,
    role: roleOf(raw),
  };
}

/**
 * Everything wrong with a proposed member list, in the order found.
 *
 * The whole list rather than the first one, because the editor shows a person all of it at
 * once and an API that reports one problem per save makes fixing two mistakes two round trips.
 * Same shape `membershipProblems()` returns and `validateMapping()` returns.
 */
async function memberProblems(members: readonly QueueMember[]): Promise<string[]> {
  const problems: string[] = [];
  const peopleIds = new Set(listPeople().map((person) => person.id));
  const groups = new Map(storedGroups().map((group) => [group.id, group]));
  const roster = new Map(listPeople().map((person) => [person.id, person]));
  const rosters = rosterMembersByGroup();

  // Which provider kinds a group has to be unambiguous FOR. Only the kinds actually in play,
  // so a group with two Kavita accounts does not block a Plex queue that never asks.
  let kinds: string[] = [];
  try {
    const registry = await sets.getRegistry();
    kinds = [...new Set(registry.sets.map((set) => set.provider_kind).filter(Boolean))];
  } catch {
    // The registry is unreadable — Plex down, a bad file. Refusing the save would make a
    // people edit depend on a provider being up, which it does not.
    kinds = [];
  }

  const seen = new Set<string>();
  for (const member of members) {
    const where = `${member.kind} '${member.id}'`;
    if (!member.id) {
      problems.push('a member has no id');
      continue;
    }
    const key = `${member.kind}:${member.id}`;
    if (seen.has(key)) problems.push(`${where} is listed twice`);
    seen.add(key);

    if (member.kind === 'person') {
      if (!peopleIds.has(member.id)) problems.push(`${where}: no such person`);
      continue;
    }

    const group = groups.get(member.id);
    if (!group) {
      problems.push(`${where}: no such group`);
      continue;
    }

    // THE CONSTRAINT. A group on a queue must name exactly one account per provider kind, or
    // `requires_profile` has nothing deterministic to sign in as.
    const people = (rosters.get(group.id) ?? [])
      .map((entry) => roster.get(entry.personId))
      .filter((person): person is NonNullable<typeof person> => person != null);
    for (const kind of kinds) {
      const profile = groupPlayProfile(kind, group.accounts, people);
      if (profile.status === 'ambiguous') {
        problems.push(
          `${where}: it offers ${profile.accounts.length} ${kind} profiles (${profile.accounts.join(', ')}) — ` +
            `a queue signs in as exactly one, so name it on the group`,
        );
      }
    }
  }

  return problems;
}
