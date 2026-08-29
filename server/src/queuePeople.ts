// QueuePilot QUEUE PEOPLE — a queue is required people + optional people + one activity.
//
// ── What WP-5 changed ────────────────────────────────────────────────────────────────────
//
// A queue used to be a hand-typed label. It is now DATA
// (decision 2026-08-25-a-queue-is-people-plus-an-activity):
//
//   * `Must be here`   the queue does not come up without them            role 'required'
//   * `Nice to have`   welcome, but not needed                            role 'optional'
//   * `Everyone else`  no row at all
//
// There is NO NAME. Every movies queue is called "Movies" and the faces on the card are what
// tell two of them apart — *"No need to add extra names where they're irrelevant."* So this
// file has no generated-name function, no override, no revert and no separator; all four were
// drawn in the mockup and none of them ship. Two queues that share people and activity are
// legal, and the second one gets a NUMBER, which is `numberDuplicates()` at the bottom and is
// a display rule rather than a naming one.
//
// ── The constraint that outranks everything else here ────────────────────────────────────
//
// A GROUP MUST STILL RESOLVE TO EXACTLY ONE PROVIDER PROFILE. A queue keyed on Older Kids
// signs into the Older Kids Plex profile no matter which of the kids turned up, and the two
// live `requires_profile` queues break the moment that stops being true. `groupPlayProfile()`
// is that resolution, it can answer AMBIGUOUS, and `PUT /api/sets/:id/people` refuses a
// member that does.
//
// ── Why "at least N of them" is two facts and not one ────────────────────────────────────
//
//   "For those queues, none of the kids are required, but at least 1 is. There's no way right
//    now in the system … where you can say 'at least one of these 3 is required'."
//
// A kids group is "at least one of two people, and a third may join". That is a set (the
// required roster), a number (`min_present`) and a spare (the optional roster) — three
// things, and collapsing any two of them loses the rule. The roster carries the role and the
// group carries the number, which is why `group_people.role` and `group_membership` landed in
// the same migration.
//
// ── Personal data ────────────────────────────────────────────────────────────────────────
//
// CODE here, DATA in `/config/queuepilot.sqlite`. Fixtures are Ada, Grace and Linus.
import type { Activity } from './activity.js';
import type { ProfileAccounts } from './groups.js';
import { mergeAccounts, norm, type Person } from './people.js';

/** Which tray a member sits in. `Everyone else` is the ABSENCE of a member, never a value. */
export type MemberRole = 'required' | 'optional';

/** A queue member is a person, or a whole saved group carrying its own count. */
export type MemberKind = 'person' | 'group';

export const MEMBER_ROLES: readonly MemberRole[] = ['required', 'optional'];

export const isMemberRole = (value: unknown): value is MemberRole =>
  value === 'required' || value === 'optional';

export const isMemberKind = (value: unknown): value is MemberKind =>
  value === 'person' || value === 'group';

/** One row of `queue_people`. */
export interface QueueMember {
  kind: MemberKind;
  id: string;
  role: MemberRole;
  /** Order within its tray. Not an identity. */
  position: number;
}

/** One row of `group_people`, plus the group-level number it is counted by. */
export interface GroupRosterMember {
  personId: string;
  role: MemberRole;
  position: number;
}

/** A group's membership RULE — the roster and how many of it are enough. */
export interface GroupMembership {
  groupId: string;
  /**
   * How many of the REQUIRED roster must be there. `null` = all of them, which is what every
   * group written before WP-5 meant and is why the absence is not silently 1.
   */
  minPresent: number | null;
  roster: GroupRosterMember[];
}

/** The required half of a roster, in roster order. */
export const requiredRoster = (membership: GroupMembership): GroupRosterMember[] =>
  membership.roster.filter((member) => member.role === 'required');

/** The optional half — the "may join" people. */
export const optionalRoster = (membership: GroupMembership): GroupRosterMember[] =>
  membership.roster.filter((member) => member.role === 'optional');

/**
 * How many of the required roster actually have to be present.
 *
 * `null` resolves to "all of them" HERE rather than at the storage edge, so the difference
 * between "the owner said all" and "the owner said three" survives a round trip and can still
 * be shown back to him as two different sentences.
 */
export function effectiveMinPresent(membership: GroupMembership): number {
  const required = requiredRoster(membership).length;
  if (membership.minPresent == null) return required;
  return Math.max(0, Math.min(membership.minPresent, required));
}

/**
 * Refuse a membership rule that cannot be satisfied, and say why in words.
 *
 * Returns the problems rather than throwing on the first one: the editor shows a person the
 * whole list at once, and an API that reports one error per save makes fixing two mistakes
 * two round trips.
 */
export function membershipProblems(membership: GroupMembership): string[] {
  const problems: string[] = [];
  const required = requiredRoster(membership).length;

  if (membership.minPresent != null) {
    if (!Number.isInteger(membership.minPresent) || membership.minPresent < 1) {
      problems.push('"at least N" must be a whole number of 1 or more');
    } else if (membership.minPresent > required) {
      problems.push(
        `"at least ${membership.minPresent}" needs ${membership.minPresent} people in Must be here, and there are ${required}`,
      );
    }
  }

  const seen = new Set<string>();
  for (const member of membership.roster) {
    if (seen.has(member.personId)) problems.push(`${member.personId} is in this group twice`);
    seen.add(member.personId);
  }

  return problems;
}

/** Say the rule in one sentence, for the tray heading. Words rather than a formula, because
 *  the tray is what a person reads before they trust it. */
export function describeMembership(membership: GroupMembership, nameOf: (id: string) => string): string {
  const required = requiredRoster(membership);
  const optional = optionalRoster(membership);
  const minimum = effectiveMinPresent(membership);
  const names = required.map((member) => nameOf(member.personId));

  let sentence: string;
  if (required.length === 0) sentence = 'Anybody in this group';
  // One person is not a quantity. "All of Ada" reads as a mistake, and it is what a group of
  // one — which is most of them — would otherwise say on every card.
  else if (required.length === 1) sentence = String(names[0]);
  else if (minimum >= required.length) sentence = `All of ${joinNames(names, 'and')}`;
  else if (minimum === 1) sentence = `At least one of ${joinNames(names, 'or')}`;
  else sentence = `At least ${minimum} of ${joinNames(names, 'or')}`;

  if (optional.length === 0) return sentence;
  return `${sentence}. ${joinNames(optional.map((member) => nameOf(member.personId)), 'and')} may join.`;
}

function joinNames(names: readonly string[], conjunction: 'and' | 'or'): string {
  if (names.length < 2) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} ${conjunction} ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, ${conjunction} ${names[names.length - 1]}`;
}

// ── The one provider profile ──────────────────────────────────────────────────────────── //

/** What a group plays as, for one provider kind. */
export type GroupProfile =
  | { status: 'one'; account: string; from: 'group' | 'roster' }
  /** Nobody named an account for this kind. Legal — the queue is simply ungated. */
  | { status: 'none' }
  /** Two or more candidates and no way to choose. A `requires_profile` queue keyed on this
   *  group would sign into whichever one sorted first, which is the bug this refuses. */
  | { status: 'ambiguous'; accounts: string[] };

/**
 * Resolve the ONE provider profile a group plays as.
 *
 * The group's OWN `accounts:` wins outright, and that is the whole trick. It is a fixed fact
 * about the group rather than a function of who turned up, so "at least one of the kids"
 * cannot change which Plex profile the Shield signs into — which is exactly what the
 * `requires_profile` gate needs and what a roster union could not promise. Carol holds two
 * Plex accounts (Older Kids and Younger Kids), so a union over a three-person roster can
 * genuinely offer three answers.
 *
 * The roster union is the FALLBACK, for a group that never named an account of its own, and
 * it answers only when it is unanimous. Anything else is `ambiguous`, reported and refused.
 *
 * ⚠️ This is NOT the same question as `people.ts accountsForGroup()`, and the two must not be
 * merged. That one is MEMBERSHIP — every account a group stands for, unioned, because
 * dropping either half loses sets out of a group silently. This one is IDENTITY — the single
 * account a session signs in as. A group legitimately stands for three accounts and plays as
 * one.
 */
export function groupPlayProfile(
  kind: string,
  groupAccounts: ProfileAccounts,
  roster: readonly Person[],
): GroupProfile {
  const key = String(kind ?? '').trim().toLowerCase();
  const own = dedupeAccounts((groupAccounts ?? {})[key] ?? []);
  if (own.length === 1) return { account: own[0] as string, from: 'group', status: 'one' };
  if (own.length > 1) return { accounts: own, status: 'ambiguous' };

  const union = dedupeAccounts((mergeAccounts(...roster.map((person) => person.accounts))[key] ?? []));
  if (union.length === 1) return { account: union[0] as string, from: 'roster', status: 'one' };
  if (union.length > 1) return { accounts: union, status: 'ambiguous' };
  return { status: 'none' };
}

/** Case-insensitively de-duplicated, first spelling wins — the same comparison `groups.ts`
 *  has always used, because these names are typed by hand into a YAML file. */
function dedupeAccounts(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const name = String(raw ?? '').trim();
    if (name && !out.some((existing) => norm(existing) === norm(name))) out.push(name);
  }
  return out;
}

// ── The filter ────────────────────────────────────────────────────────────────────────── //

/** What a caller has to know about one member to decide whether a queue matches. */
export interface ResolvedMember extends QueueMember {
  /** For a group: the required roster and the number. For a person: just themself. */
  people: string[];
  /** How many of `people` count as this member being present. 1 for a person. */
  minPresent: number;
}

/**
 * Does this queue survive the people filter?
 *
 * CHOOSING PEOPLE IS A FILTER, NOT A CLAIM ABOUT WHO IS IN THE ROOM
 * (decision §5). Nothing detects presence and nothing here pretends to —
 *
 *   "These queues are hand-chosen. There's nothing saying who is or isn't in the room. I
 *    might be with [somebody], but she says she just wants to lay down, so I'd click my own
 *    name … It helps you narrow down choices as a sort of filter/search field."
 *
 * Two halves, and BOTH have to hold:
 *
 *   1. Every selected person is ON the queue — required or optional. Picking two people hides
 *      a queue that only one of them is on.
 *   2. Every required member is selected. A group member counts as selected when
 *      `minPresent` of its required roster are.
 *
 * Optional people are the hatch: somebody in Nice to have never removes the queue, which is
 * what makes "Ada, and Grace is in the room not paying attention" a queue you can still
 * find.
 *
 * TWO empties are not the same empty, and both branches are load-bearing:
 *
 *   * **Nobody selected is NO FILTER AT ALL.** Read strictly, "every required member is
 *     selected" is false against an empty selection, so an empty form would hide every queue
 *     that names anybody — a search field showing no results before you have typed. (The
 *     correction at the end of §5 of the decision.)
 *   * **A queue NOBODY is filed on is never filtered out.** Several live queues legitimately
 *     have nobody on them — a queue no group claimed comes up empty by design, which
 *     `store/migrate/queuePeople.ts` calls the honest answer — and rule 1 above is false
 *     against an empty roster, so one tick would make every one of them unreachable. Both
 *     the draw and the Which queue? list read this function, so the branch has to be here
 *     rather than at either caller.
 *
 * ⚠️ A FILTER IS NEVER THE ONLY WAY IN. Scanning an NFC card goes straight to its queue and
 * never comes near this function.
 */
export function queueMatchesSelection(
  members: readonly ResolvedMember[],
  selectedPersonIds: readonly string[],
): boolean {
  if (members.length === 0) return true;

  const selected = new Set(selectedPersonIds);
  if (selected.size === 0) return true;

  const onQueue = new Set<string>();
  for (const member of members) for (const personId of member.people) onQueue.add(personId);

  for (const personId of selected) if (!onQueue.has(personId)) return false;

  for (const member of members) {
    if (member.role !== 'required') continue;
    const present = member.people.filter((personId) => selected.has(personId)).length;
    if (present < member.minPresent) return false;
  }

  return true;
}

// ── Duplicates get a number ───────────────────────────────────────────────────────────── //

/** One queue, reduced to the two things that name it. */
export interface NameableQueue {
  id: string;
  activity: Activity;
  members: readonly QueueMember[];
}

/**
 * The number a queue wears after its activity, or `null` for the first of its kind.
 *
 * "Allow, and add a number." Two queues may share people and activity, and with names gone
 * this is the only thing telling two otherwise identical cards apart. Keyed on the order the
 * caller hands over, so the number is stable: the first `watching` queue for Ada is unnumbered
 * forever, and creating a second one never renumbers the first.
 *
 * The signature is the activity plus the SORTED member list, so two queues that list the same
 * people in a different tray order are the same card and do collide — which is right, because
 * they read identically.
 */
export function numberDuplicates(queues: readonly NameableQueue[]): Map<string, number | null> {
  const seen = new Map<string, number>();
  const out = new Map<string, number | null>();

  for (const queue of queues) {
    const signature = [
      queue.activity,
      ...queue.members
        .map((member) => `${member.role}:${member.kind}:${member.id}`)
        .sort(),
    ].join('|');
    const count = (seen.get(signature) ?? 0) + 1;
    seen.set(signature, count);
    out.set(queue.id, count === 1 ? null : count);
  }

  return out;
}
