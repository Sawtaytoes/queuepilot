// One request body → one `PickCriteria`, or a reason it is not one.
//
// Kept out of the route so the parsing has unit tests of its own, and kept out of
// `boardgames/types.ts` so the ported engine's files stay byte-comparable with their origin.
//
// ── Why this rejects rather than defaults ────────────────────────────────────────────────
//
// A picker that quietly reads `fitness: "bestOnley"` as `any` answers a question nobody asked
// and looks like it worked. Every enumerated field is checked against its closed set and a
// wrong value is a 400. The two fields that legitimately mean "no filter" say so with `null`,
// which is not the same as absent — same discipline as `pending.libraries`.
//
// ── The wire says PERSON, the engine says PLAYER ─────────────────────────────────────────
//
// Same boundary `store/db/boardgames.ts` documents: this app settled on "person" in WP-3, and
// the ported engine's own vocabulary is not this package's to renegotiate. The rename happens
// here and nowhere else.
import type {
  InteractionType,
  PickCriteria,
  PlayerCountFitness,
  RulesKnown,
} from './types.js';

const FITNESS: readonly PlayerCountFitness[] = ['bestOnly', 'bestOrRecommended', 'any'];
const RULES: readonly RulesKnown[] = ['any', 'someone', 'everyone'];
const INTERACTIONS: readonly InteractionType[] = [
  'competitive',
  'cooperative',
  'semiCooperative',
  'solo',
  'team',
  'traitor',
];

/** How many cards the shortlist control may reveal. Three — the decision says three. */
export const SHORTLIST_SIZE = 3;

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * `null` for "no ceiling", a number for a real one, and an error for anything else.
 *
 * `undefined` and `null` are both "no filter" here, unlike `pending.libraries`: a body that
 * omits the complexity ceiling has said nothing about complexity, and there is no third state
 * for it to mean.
 */
const optionalNumber = (
  value: unknown,
  field: string,
): { value: number | null } | { error: string } => {
  if (value === undefined || value === null || value === '') return { value: null };
  const n = Number(value);
  if (!Number.isFinite(n)) return { error: `${field} must be a number or null` };
  return { value: n };
};

export function parsePickCriteria(
  body: Record<string, unknown>,
): { criteria: PickCriteria } | { error: string } {
  const playerCount = Number(body.playerCount);
  if (!Number.isInteger(playerCount) || playerCount < 1) {
    return { error: 'playerCount must be a whole number of 1 or more' };
  }

  const fitness = body.fitness ?? 'bestOrRecommended';
  if (!FITNESS.includes(fitness as PlayerCountFitness)) {
    return { error: `fitness must be one of ${FITNESS.join(', ')}` };
  }

  const rulesKnown = body.rulesKnown ?? 'any';
  if (!RULES.includes(rulesKnown as RulesKnown)) {
    return { error: `rulesKnown must be one of ${RULES.join(', ')}` };
  }

  const rawInteraction = body.interactionType;
  const interactionType =
    rawInteraction === undefined || rawInteraction === null || rawInteraction === ''
      ? null
      : (rawInteraction as InteractionType);
  if (interactionType !== null && !INTERACTIONS.includes(interactionType)) {
    return { error: `interactionType must be null or one of ${INTERACTIONS.join(', ')}` };
  }

  const maxWeight = optionalNumber(body.maxWeight, 'maxWeight');
  if ('error' in maxWeight) return maxWeight;
  const maxPlaytime = optionalNumber(body.maxPlaytime, 'maxPlaytime');
  if ('error' in maxPlaytime) return maxPlaytime;

  const seed = body.seed === undefined ? undefined : Number(body.seed);
  if (seed !== undefined && !Number.isFinite(seed)) return { error: 'seed must be a number' };

  // `personIds: []` and an absent `personIds` are the SAME answer, and both mean "nobody
  // named". The engine reads `playerIds: null` as that; an empty array would be read as "a
  // table of nought people", which no game fits.
  const personIds = stringsOf(body.personIds);

  return {
    criteria: {
      categories: stringsOf(body.categories),
      excludedGameIds: stringsOf(body.excludedGameIds),
      fitness: fitness as PlayerCountFitness,
      groupId: null,
      interactionType,
      maxPlaytime: maxPlaytime.value,
      maxWeight: maxWeight.value,
      playerCount,
      playerIds: personIds.length > 0 ? personIds : null,
      rulesKnown: rulesKnown as RulesKnown,
      ...(seed === undefined ? {} : { seed }),
    },
  };
}
