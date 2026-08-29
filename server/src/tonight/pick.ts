// WP-7 — the queue-first pick: given a tile and who is at the table, draw ONE queue.
//
// ── What this draws, and what it deliberately does not ───────────────────────────────────
//
// It draws a QUEUE. It does not draw an item, and that is a decision rather than a shortcut
// (`routing.ts WHY_QUEUE_FIRST` has the measurement behind it). The queue's own engine picks
// the item when it starts, and it is the only thing in the app that already knows what is
// left to watch, read or play. A second opinion here would be able to disagree with it —
// exactly the class of defect `routes/queuesRoutes.ts tagFinishedMovies` warns about in its
// own header, where a "cheap re-implementation" of a resolver rule is called out as a second
// rule that can drift.
//
// What it DOES resolve is "what would come up next", when the answer is already in this
// app's own store or is one call the provider was going to make anyway:
//
//   * a PULL queue (reading, board games, MiSTer, Steam) — the real head of `pullLineup()`,
//     which is the same lineup `GET /go/<id>` is about to build;
//   * a CURATED push queue (Plex) — the first entry that is not marked done, read straight
//     out of `queues.yaml` with no Plex call at all. That is the ENTRY, not the leaf episode,
//     and the card says so;
//   * a RULES pool — nothing, by name: its lineup does not exist until it is drawn.
//
// A null `upNext` always carries a `upNextReason`. A blank space where a title should be is
// the thing this file exists to avoid.
//
// ── One session talks to ONE backend ────────────────────────────────────────────────────
//
// `chooseBackend()` draws a BACKEND first and then draws inside it, so a reroll cannot walk
// from a Steam queue to a MiSTer one halfway through an evening. `boundBackend` on the
// request is how a reroll stays bound. A queue that draws from two providers is dropped from
// the candidates with a reason rather than guessed at.
//
// ── Randomness is injected ──────────────────────────────────────────────────────────────
//
// Every draw takes `random`, so `pick.test.ts` asserts the ORDER a given sequence produces
// instead of asserting that something came back.
//
// CODE here, DATA in `/config/queuepilot.sqlite`. Fixtures are Ada, Grace and Linus.
import { activityLabel } from '../activity.js';
import type { Activity } from '../activity.js';
import type { GroupMembership, QueueMember, ResolvedMember } from '../queuePeople.js';
import type { PlayItem } from '../types.js';

import { effectiveMinPresent, queueMatchesSelection, requiredRoster } from '../queuePeople.js';
import { type TonightTile, tileForSet } from './routing.js';

/** One queue a Tonight session could draw, reduced to what the draw and the card need. */
export interface TonightCandidate {
  setId: string;
  /** The label the queue carries today. WP-5's answer is that the ACTIVITY is the name and
   *  the people are the badges; until the shelf paints that everywhere, this is what a card
   *  can honestly show, falling back to the wire id. */
  setLabel: string;
  tile: TonightTile;
  queueActivity: Activity;
  /** The BACKEND's identity — a provider id, which is always present. `providerKind` can be
   *  the empty string for a provider this build has not configured, so the id is what the
   *  one-backend rule counts. */
  providerId: string;
  providerKind: string;
  /** The provider's PRODUCT name, off the set's own vocabulary. */
  providerLabel: string;
  delivery: 'pull' | 'push';
  /** `queue` = curated entries; `rotation` = a rules pool drawn at launch. */
  source: 'queue' | 'rotation';
}

/** What one drawn queue looks like on the result card. */
export interface TonightPick extends TonightCandidate {
  /** What would come up next, when it can be answered without starting anything. */
  upNext: { title: string; detail: string | null } | null;
  /** Why `upNext` is null. Never a silent absence. */
  upNextReason: string | null;
  /** Where Go goes for a PULL queue. `null` for a push queue, which opens the device menu. */
  launchUrl: string | null;
}

// ── The people filter ───────────────────────────────────────────────────────────────────

/**
 * Turn a queue's stored members into the shape `queueMatchesSelection()` reads.
 *
 * A PERSON member is themself and counts as one. A GROUP member carries its complete roster,
 * with its required roster kept separately for `effectiveMinPresent` — "at least one of the
 * kids" is a set, a number and a spare, and flattening a group to its people would lose the
 * number.
 *
 * A group nothing knows about resolves to an EMPTY roster, and an empty required member can
 * never be satisfied, so the queue drops out of the filter rather than passing it by
 * accident. That is the safe direction: a queue that should have been offered and was not is
 * visible on the screen; a queue offered to people it is not for is not.
 */
export function toResolvedMembers(
  members: readonly QueueMember[],
  membershipFor: (groupId: string) => GroupMembership | null,
): ResolvedMember[] {
  return members.map((member) => {
    if (member.kind === 'person') {
      return { ...member, minPresent: 1, people: [member.id], requiredPeople: [member.id] };
    }
    const membership = membershipFor(member.id);
    if (!membership) return { ...member, minPresent: 1, people: [], requiredPeople: [] };
    const required = requiredRoster(membership).map((row) => row.personId);
    return {
      ...member,
      minPresent: effectiveMinPresent(membership),
      people: membership.roster.map((row) => row.personId),
      requiredPeople: required,
    };
  });
}

/** One set, as much of it as the candidate filter reads. Structural on purpose: the two
 *  registry shapes (`QueueSet` / `RotationSet`) both satisfy it and neither is imported. */
export interface CandidateSet {
  id: string;
  /** The registry's, so it falls back to the id. Read `has_explicit_label` before showing it. */
  label: string;
  /** Whether a name was TYPED. Absent on a hand-built fixture, which reads as "no name". */
  has_explicit_label?: boolean;
  enabled: boolean;
  activity: Activity;
  behavior?: string | null;
  provider_kind: string;
  delivery: 'pull' | 'push';
  source: 'queue' | 'rotation';
  vocabulary?: { name?: string };
}

export interface CandidateInput {
  tile: TonightTile;
  personIds: readonly string[];
  sets: readonly CandidateSet[];
  /** Every queue's members, keyed on set id — one statement, not one per set. */
  membersByQueue: ReadonlyMap<string, QueueMember[]>;
  membershipFor: (groupId: string) => GroupMembership | null;
  /** The BACKEND behind a set: its provider id, or `null` when the set is mixed or broken. */
  providerIdFor: (setId: string) => string | null;
  /** Set ids already turned down this evening — the reroll's memory. */
  excludedSetIds?: readonly string[];
  /** Once a session has drawn a backend, it stays on it. */
  boundBackend?: string | null;
}

/**
 * The queues this session could draw, before anything is chosen.
 *
 * In order: the tile, then who is at the table, then what has already been turned down, then
 * the bound backend. A disabled queue never appears, and neither does one whose provider this
 * build cannot name.
 */
export function candidatesFor({
  boundBackend = null,
  excludedSetIds = [],
  membershipFor,
  membersByQueue,
  personIds,
  providerIdFor,
  sets,
  tile,
}: CandidateInput): TonightCandidate[] {
  const excluded = new Set(excludedSetIds);
  const out: TonightCandidate[] = [];

  for (const set of sets) {
    if (!set.enabled) continue;
    if (excluded.has(set.id)) continue;
    if (tileForSet(set) !== tile) continue;

    const providerId = providerIdFor(set.id);
    // A mixed queue is a push target and a pull URL at once, and what it hands off is an open
    // decision. `launchDescriptor` refuses one with a 501; offering it here would draw a card
    // whose Go cannot work.
    if (!providerId) continue;
    if (boundBackend && providerId !== boundBackend) continue;

    const members = membersByQueue.get(set.id) ?? [];
    if (!queueMatchesSelection(toResolvedMembers(members, membershipFor), personIds)) continue;

    out.push({
      delivery: set.delivery,
      providerId,
      providerKind: set.provider_kind,
      providerLabel: set.vocabulary?.name ?? '',
      queueActivity: set.activity,
      setId: set.id,
      // The queue's own name when it has one, its ACTIVITY when it has not. `set.label`
      // falls back to the ID, so a nameless queue used to arrive at the result card as
      // `movies_shows` (decision
      // `2026-08-26-a-queue-name-is-optional-and-the-activity-fills-in`). No NUMBER here:
      // this is one card for one draw, not a list where two could sit side by side.
      setLabel: set.has_explicit_label ? set.label : activityLabel(set.activity),
      source: set.source,
      tile,
    });
  }

  return out;
}

// ── The draw ────────────────────────────────────────────────────────────────────────────

/** A uniform draw from `[0, size)`. Injected `random` is `Math.random`'s contract. */
const indexOf = (size: number, random: () => number): number =>
  Math.min(size - 1, Math.max(0, Math.floor(random() * size)));

/**
 * Which backend this session runs on.
 *
 * Deliberately NOT "refuse when there are two". Video Games genuinely has Steam queues and
 * MiSTer queues, and an evening that could be either is a normal evening. The rule is that
 * the moment one is drawn the session is BOUND to it — so the backend is drawn from the
 * candidates rather than from a fixed order, and every later step stays inside it.
 */
export function chooseBackend(
  candidates: readonly TonightCandidate[],
  random: () => number,
): string | null {
  const backends = [...new Set(candidates.map((one) => one.providerId))];
  if (backends.length === 0) return null;
  if (backends.length === 1) return backends[0] ?? null;
  return backends[indexOf(backends.length, random)] ?? null;
}

/**
 * The order the queues are offered in — a shuffle, so the first one is the answer and the
 * next two are the shortlist.
 *
 * Fisher-Yates rather than `sort(() => random() - 0.5)`, which is not a shuffle and biases
 * towards the input order on every engine that uses an insertion sort for short arrays.
 */
export function orderCandidates(
  candidates: readonly TonightCandidate[],
  random: () => number,
): TonightCandidate[] {
  const out = [...candidates];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = indexOf(i + 1, random);
    const a = out[i] as TonightCandidate;
    const b = out[j] as TonightCandidate;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/**
 * The whole draw: bind a backend, then order that backend's queues.
 *
 * Returns the queues in offer order. The caller resolves `upNext` for as many as it is going
 * to show — resolving it for every candidate would make a pick cost one provider round trip
 * per queue in the house.
 */
export function drawQueues(
  candidates: readonly TonightCandidate[],
  random: () => number,
): { backend: string | null; ordered: TonightCandidate[] } {
  const backend = chooseBackend(candidates, random);
  if (!backend) return { backend: null, ordered: [] };
  return {
    backend,
    ordered: orderCandidates(
      candidates.filter((one) => one.providerId === backend),
      random,
    ),
  };
}

// ── What comes up next ──────────────────────────────────────────────────────────────────

/**
 * One lineup item, said in words.
 *
 * The `PlayItem` union has no discriminant on purpose — each provider's item is its own
 * shape — so this reads the field that identifies each one. A shape nothing recognises still
 * answers with its title rather than throwing: an unnamed card is a worse failure than a
 * slightly thin one.
 */
export function playItemLabel(item: PlayItem): { title: string; detail: string | null } {
  const row = item as unknown as Record<string, unknown>;
  const title = typeof row.title === 'string' && row.title ? row.title : '';

  // Plex: a show carries its series name separately, and the episode number is what a person
  // is actually looking for.
  if ('ratingKey' in row) {
    const show = typeof row.show === 'string' ? row.show : '';
    const season = typeof row.season === 'number' ? row.season : null;
    const episode = typeof row.episode === 'number' ? row.episode : null;
    const code = season != null && episode != null
      ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
      : null;
    if (show) return { detail: [code, title].filter(Boolean).join(' · ') || null, title: show };
    return { detail: code, title: title || 'Next up' };
  }

  // Kavita: `number` is the chapter or the volume, and `unit` says which.
  if ('chapterId' in row) {
    const unit = row.unit === 'volume' ? 'Vol' : 'Ch';
    const number = row.number == null ? null : String(row.number);
    return { detail: number ? `${unit} ${number}` : null, title: title || 'Next up' };
  }

  return { detail: null, title: title || 'Next up' };
}

/** The first entry a curated queue has not finished with — the head of its lineup, read out
 *  of this app's own store rather than out of the provider. */
export function firstUnfinishedEntry(
  entries: readonly { done: boolean; display: string }[],
): string | null {
  for (const entry of entries) {
    if (!entry.done && entry.display) return entry.display;
  }
  return null;
}
