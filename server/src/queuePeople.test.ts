// The WP-5 model, tested on the rules the decision states — not on the code's shape.
//
// The cast is Ada, Grace and Linus (AGENTS.md). The household's own names never enter this
// repo, so "at least one of the kids" is exercised as "at least one of Ada or Grace, and Linus
// may join" — the same rule with invented people.
import { describe, expect, it } from 'vitest';

import type { Person } from './people.js';
import {
  describeMembership,
  effectiveMinPresent,
  groupPlayProfile,
  membershipProblems,
  numberDuplicates,
  optionalRoster,
  queueMatchesSelection,
  requiredRoster,
  type GroupMembership,
  type QueueMember,
  type ResolvedMember,
} from './queuePeople.js';

const person = (id: string, accounts: Record<string, string[]> = {}): Person => ({
  accounts,
  birthYear: null,
  createdAt: null,
  displayName: id,
  id,
  isBeginner: false,
  maxWeight: null,
  position: 0,
  source: null,
  sourceId: null,
});

/** "At least one of Ada or Grace; Linus may join" — the Older Kids rule, invented cast. */
const kids: GroupMembership = {
  groupId: 'kids',
  minPresent: 1,
  roster: [
    { personId: 'ada', position: 0, role: 'required' },
    { personId: 'grace', position: 1, role: 'required' },
    { personId: 'linus', position: 0, role: 'optional' },
  ],
};

describe('a group carries its own membership rule', () => {
  it('splits the roster into the people the count is over and the people who may join', () => {
    expect(requiredRoster(kids).map((m) => m.personId)).toEqual(['ada', 'grace']);
    expect(optionalRoster(kids).map((m) => m.personId)).toEqual(['linus']);
  });

  it('reads an absent minPresent as ALL of the required roster, never as one', () => {
    // The difference this pins: every group written before WP-5 meant "all of them", and
    // defaulting the absence to 1 would quietly loosen all of them at once.
    expect(effectiveMinPresent({ ...kids, minPresent: null })).toBe(2);
    expect(effectiveMinPresent(kids)).toBe(1);
  });

  it('refuses a rule that needs more people than are in Must be here', () => {
    expect(membershipProblems({ ...kids, minPresent: 3 })).toEqual([
      '"at least 3" needs 3 people in Must be here, and there are 2',
    ]);
  });

  it('refuses a number that is not a whole number of one or more', () => {
    expect(membershipProblems({ ...kids, minPresent: 0 })).toEqual([
      '"at least N" must be a whole number of 1 or more',
    ]);
  });

  it('refuses one person in the roster twice', () => {
    const twice: GroupMembership = {
      ...kids,
      roster: [...kids.roster, { personId: 'ada', position: 2, role: 'optional' }],
    };
    expect(membershipProblems(twice)).toContain('ada is in this group twice');
  });

  it('says the rule in one sentence, because the tray is what a person reads', () => {
    const name = (id: string) => id.toUpperCase();
    expect(describeMembership(kids, name)).toBe('At least one of ADA, GRACE. LINUS may join.');
    expect(describeMembership({ ...kids, minPresent: null }, name)).toBe(
      'All of ADA, GRACE. LINUS may join.',
    );
    expect(describeMembership({ ...kids, minPresent: 2, roster: kids.roster.slice(0, 2) }, name)).toBe(
      'All of ADA, GRACE',
    );
  });

  it('does not say "All of Ada" about a group of one', () => {
    // One person is not a quantity, and a group of one is most of them.
    expect(
      describeMembership(
        { groupId: 'solo', minPresent: null, roster: [{ personId: 'ada', position: 0, role: 'required' }] },
        (id) => id,
      ),
    ).toBe('ada');
  });
});

describe('a group still resolves to exactly ONE provider profile', () => {
  // This is the constraint the whole group model exists to protect. Two `requires_profile`
  // queues break the moment it stops holding.
  it("takes the group's own account, which does not vary with who turned up", () => {
    expect(groupPlayProfile('plex', { plex: ['kids-profile'] }, [
      person('ada', { plex: ['ada-plex'] }),
      person('grace', { plex: ['grace-plex'] }),
    ])).toEqual({ account: 'kids-profile', from: 'group', status: 'one' });
  });

  it('falls back to the roster only when the roster is unanimous', () => {
    expect(groupPlayProfile('plex', {}, [
      person('ada', { plex: ['shared'] }),
      person('grace', { plex: ['Shared'] }),
    ])).toEqual({ account: 'shared', from: 'roster', status: 'one' });
  });

  it('refuses to choose when the roster offers two answers', () => {
    const answer = groupPlayProfile('plex', {}, [
      person('ada', { plex: ['ada-plex'] }),
      person('grace', { plex: ['grace-plex'] }),
    ]);
    expect(answer).toEqual({ accounts: ['ada-plex', 'grace-plex'], status: 'ambiguous' });
  });

  it("refuses a GROUP that named two of its own, rather than taking the first", () => {
    expect(groupPlayProfile('plex', { plex: ['one', 'two'] }, [])).toEqual({
      accounts: ['one', 'two'],
      status: 'ambiguous',
    });
  });

  it('answers `none` for a kind nobody named — an ungated queue is legal', () => {
    expect(groupPlayProfile('kavita', { plex: ['x'] }, [])).toEqual({ status: 'none' });
  });
});

describe('choosing people is a FILTER, not a claim about who is in the room', () => {
  const solo: ResolvedMember[] = [
    { id: 'ada', kind: 'person', minPresent: 1, people: ['ada'], position: 0, role: 'required' },
  ];
  const adaAndGrace: ResolvedMember[] = [
    { id: 'ada', kind: 'person', minPresent: 1, people: ['ada'], position: 0, role: 'required' },
    { id: 'grace', kind: 'person', minPresent: 1, people: ['grace'], position: 1, role: 'required' },
  ];
  const adaWithGraceOptional: ResolvedMember[] = [
    { id: 'ada', kind: 'person', minPresent: 1, people: ['ada'], position: 0, role: 'required' },
    { id: 'grace', kind: 'person', minPresent: 1, people: ['grace'], position: 0, role: 'optional' },
  ];

  it('shows everything when nobody is selected', () => {
    expect(queueMatchesSelection(solo, [])).toBe(true);
  });

  /**
   * ⚠️ THE OTHER EMPTY, and it is not the same one.
   *
   * A queue nobody is filed on is offered to everybody. Several live queues legitimately have
   * no members — a queue no group claimed comes up empty by design — and "every selected
   * person is on the queue" is false against an empty roster, so without this branch one tick
   * makes every one of them unreachable from Pick and from the Which queue? list alike.
   */
  it('shows a queue NOBODY is filed on, whoever is selected', () => {
    expect(queueMatchesSelection([], [])).toBe(true);
    expect(queueMatchesSelection([], ['ada'])).toBe(true);
    expect(queueMatchesSelection([], ['ada', 'grace', 'linus'])).toBe(true);
  });

  it('hides a queue a selected person is not on', () => {
    // "Picking [two people] … hides the one-person queue — because the second is not on it."
    expect(queueMatchesSelection(solo, ['ada', 'grace'])).toBe(false);
  });

  it('hides a queue whose required person is not selected', () => {
    expect(queueMatchesSelection(adaAndGrace, ['ada'])).toBe(false);
    expect(queueMatchesSelection(adaAndGrace, ['ada', 'grace'])).toBe(true);
  });

  it('lets an OPTIONAL person be selected without removing the queue — the hatch', () => {
    expect(queueMatchesSelection(adaWithGraceOptional, ['ada', 'grace'])).toBe(true);
    expect(queueMatchesSelection(adaWithGraceOptional, ['ada'])).toBe(true);
  });

  it('counts a GROUP member by its own minPresent, so either of the kids is enough', () => {
    const withKids: ResolvedMember[] = [
      {
        id: 'kids',
        kind: 'group',
        minPresent: 1,
        people: ['ada', 'grace'],
        position: 0,
        role: 'required',
      },
    ];
    expect(queueMatchesSelection(withKids, ['ada'])).toBe(true);
    expect(queueMatchesSelection(withKids, ['grace'])).toBe(true);
    expect(queueMatchesSelection(withKids, ['ada', 'grace'])).toBe(true);
    // …and a group that means ALL of them still needs all of them.
    expect(queueMatchesSelection([{ ...withKids[0]!, minPresent: 2 }], ['ada'])).toBe(false);
  });

  it('needs NO ADULT on a kids queue — one kid is enough', () => {
    const kidsOnly: ResolvedMember[] = [
      {
        id: 'kids',
        kind: 'group',
        minPresent: 1,
        people: ['ada', 'grace', 'linus'],
        position: 0,
        role: 'required',
      },
    ];
    expect(queueMatchesSelection(kidsOnly, ['linus'])).toBe(true);
  });
});

describe('duplicates are legal and get a number', () => {
  const member = (id: string): QueueMember => ({ id, kind: 'person', position: 0, role: 'required' });

  it('leaves the first of its kind unnumbered and numbers the rest', () => {
    const numbers = numberDuplicates([
      { activity: 'watching', id: 'a', members: [member('ada')] },
      { activity: 'watching', id: 'b', members: [member('ada')] },
      { activity: 'watching', id: 'c', members: [member('ada')] },
    ]);
    expect([...numbers.values()]).toEqual([null, 2, 3]);
  });

  it('does not collide two queues that differ by activity or by people', () => {
    const numbers = numberDuplicates([
      { activity: 'watching', id: 'a', members: [member('ada')] },
      { activity: 'reading', id: 'b', members: [member('ada')] },
      { activity: 'watching', id: 'c', members: [member('grace')] },
    ]);
    expect([...numbers.values()]).toEqual([null, null, null]);
  });

  it('treats the same people in a different order as the same card', () => {
    // They read identically on screen, so they must collide — otherwise two cards look the
    // same and only one of them carries a number.
    const numbers = numberDuplicates([
      { activity: 'watching', id: 'a', members: [member('ada'), member('grace')] },
      { activity: 'watching', id: 'b', members: [member('grace'), member('ada')] },
    ]);
    expect([...numbers.values()]).toEqual([null, 2]);
  });
});
