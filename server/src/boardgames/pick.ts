import { COOLDOWN, FAMILIARITY, FITNESS_BONUS, GROUP_PLAY_WEIGHT, RATING_NUDGE } from './scoring.js';
import type {
  EmptyReason,
  Game,
  Group,
  KnownGame,
  PickCandidate,
  PickCriteria,
  PickResult,
  Play,
  Player,
} from './types.js';
import { isPlayerCountAllowed, PLAYER_COUNT_LIMITS } from './types.js';
import { fitsBoxRange, verdictFor } from './verdict.js';

/**
 * One `pick()` behind both modes. Mode 1 fills the criteria from
 * the form; mode 2 fills them from a group. The engine cannot
 * tell the difference and must not be able to.
 */

export interface PickInput {
  games: Game[];
  plays: Play[];
  players: Player[];
  groups: Group[];
  /**
   * Who can play what without the rulebook. Optional so every
   * existing caller and fixture keeps compiling; absent reads as
   * "nobody has said", which only matters when `rulesKnown` is
   * something other than `any`.
   */
  knownGames?: KnownGame[];
  criteria: PickCriteria;
  /** Injected so "played today" is testable. */
  now?: Date;
}

/**
 * `mulberry32`. A named, seedable generator rather than
 * `Math.random`, because a picker whose tests cannot pin the
 * draw is a picker whose scoring changes go unnoticed.
 */
const makeRandom = (seed: number | undefined): (() => number) => {
  if (seed === undefined) return Math.random;

  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const familiarityFor = (plays: number): number => {
  if (plays <= 0) return FAMILIARITY.unplayed;
  if (plays < FAMILIARITY.learnedAtPlays) return FAMILIARITY.learning;
  return FAMILIARITY.learned;
};

/**
 * How much a logged play counts towards "we know this game".
 *
 * Mode 2 asks about a specific set of people. A play with
 * exactly those people is full evidence; a play that also had
 * four others at the table is weaker; a play missing one of them
 * is not evidence about this group at all.
 */
const playWeightFor = (play: Play, groupPlayerIds: string[] | null): number => {
  if (groupPlayerIds === null) return 1;

  const present = new Set(play.playerIds);
  const hasEveryone = groupPlayerIds.every((id) => present.has(id));
  if (!hasEveryone) return 0;

  return play.playerIds.length === groupPlayerIds.length
    ? GROUP_PLAY_WEIGHT.exactGroup
    : GROUP_PLAY_WEIGHT.supersetOfGroup;
};

export interface PickDebugRow {
  candidate: PickCandidate;
}

/**
 * The eligible set plus its scores, without drawing. The dry-run
 * CLI and the API both want this; only the API wants a winner.
 */
export const evaluate = (
  input: PickInput,
): {
  candidates: PickCandidate[];
  emptyReason: EmptyReason;
  suggestion: string | null;
} => {
  const { games, plays, players, groups, criteria } = input;
  const knownGames = input.knownGames ?? [];
  const now = input.now ?? new Date();

  // Who's at the table this session — an ad-hoc set of people wins
  // over a saved group, and a saved group is just a shortcut that
  // supplies the same list of ids. Either way the engine only ever
  // sees a set of player ids.
  const group =
    criteria.groupId === null
      ? null
      : (groups.find((entry) => entry.id === criteria.groupId) ?? null);

  const sessionPlayerIds =
    criteria.playerIds && criteria.playerIds.length > 0
      ? criteria.playerIds
      : (group?.playerIds ?? null);

  const sessionPlayers =
    sessionPlayerIds === null
      ? []
      : players.filter((player) => sessionPlayerIds.includes(player.id));

  // The session ceiling is its most-cautious member's ceiling: a
  // complicated game is not what you put in front of a beginner.
  const playerCeilings = sessionPlayers
    .map((player) => player.maxWeight)
    .filter((weight): weight is number => weight !== null);

  const sessionCeiling = [
    criteria.maxWeight,
    playerCeilings.length > 0 ? Math.min(...playerCeilings) : null,
  ].filter((weight): weight is number => weight !== null);

  const weightCeiling = sessionCeiling.length > 0 ? Math.min(...sessionCeiling) : null;

  // Filters run in order and each one records what it removed,
  // so an empty result can name the culprit instead of shrugging.
  let survivors = games.filter((game) => !game.isExcluded);
  if (survivors.length === 0) {
    return {
      candidates: [],
      emptyReason: 'noGames',
      suggestion: null,
    };
  }

  // Request validation, BEFORE any game is filtered: the kind of
  // game constrains how many people can sensibly be asking, and
  // "a co-op game needs at least 2" is a far more useful answer
  // than "nothing in the collection plays with 1". Enforced here
  // as well as in the UI, because a rule that lives only in a
  // component is one API call away from not existing.
  if (
    criteria.interactionType !== null &&
    !isPlayerCountAllowed(criteria.interactionType, criteria.playerCount)
  ) {
    const { min, max } = PLAYER_COUNT_LIMITS[criteria.interactionType];
    return {
      candidates: [],
      emptyReason: 'interactionType',
      suggestion:
        max === min
          ? `A solo game is for exactly ${min}.`
          : `That kind of game needs at least ${min} players.`,
    };
  }

  const afterPlayerCount = survivors.filter((game) => fitsBoxRange(game, criteria.playerCount));
  if (afterPlayerCount.length === 0) {
    return {
      candidates: [],
      emptyReason: 'playerCount',
      suggestion: `Nothing in the collection plays with ${criteria.playerCount}.`,
    };
  }
  survivors = afterPlayerCount;

  const afterFitness = survivors.filter((game) => {
    const verdict = verdictFor(game, criteria.playerCount);
    if (criteria.fitness === 'any') return true;
    if (criteria.fitness === 'bestOnly') return verdict === 'best';
    return verdict !== 'notRecommended';
  });
  if (afterFitness.length === 0) {
    return {
      candidates: [],
      emptyReason: 'fitness',
      suggestion:
        criteria.fitness === 'bestOnly'
          ? 'Allow games that merely play well at this count, not only the best ones.'
          : "Ignore the community's player-count verdict and use the box range.",
    };
  }
  survivors = afterFitness;

  if (criteria.interactionType !== null) {
    const wanted = criteria.interactionType;
    const afterInteraction = survivors.filter((game) => game.interactionTypes.includes(wanted));
    if (afterInteraction.length === 0) {
      return {
        candidates: [],
        emptyReason: 'interactionType',
        suggestion: `No ${criteria.interactionType} game fits — try any type.`,
      };
    }
    survivors = afterInteraction;
  }

  if (criteria.categories.length > 0) {
    const wanted = criteria.categories;
    const afterCategories = survivors.filter((game) =>
      wanted.every((category) => game.ownerCategories.includes(category)),
    );
    if (afterCategories.length === 0) {
      return {
        candidates: [],
        emptyReason: 'category',
        suggestion: `Nothing is tagged ${wanted.join(' + ')} — drop a category.`,
      };
    }
    survivors = afterCategories;
  }

  if (weightCeiling !== null) {
    // An unknown weight is NOT filtered out. Over half a typical
    // collection has no complexity rating, and dropping those
    // would make the dial look broken.
    const afterWeight = survivors.filter(
      (game) => game.weight === null || game.weight <= weightCeiling,
    );
    if (afterWeight.length === 0) {
      return {
        candidates: [],
        emptyReason: 'weight',
        suggestion: `Nothing at complexity ${weightCeiling.toFixed(1)} or below — raise the ceiling.`,
      };
    }
    survivors = afterWeight;
  }

  if (criteria.maxPlaytime !== null) {
    const cap = criteria.maxPlaytime;
    const afterPlaytime = survivors.filter(
      (game) => game.minPlaytime === null || game.minPlaytime <= cap,
    );
    if (afterPlaytime.length === 0) {
      return {
        candidates: [],
        emptyReason: 'playtime',
        suggestion: `Nothing finishes inside ${cap} minutes — allow more time.`,
      };
    }
    survivors = afterPlaytime;
  }

  // "We want to start playing, not start reading." Last of the
  // filters on purpose: it is the only one that can be satisfied
  // by going and learning a game, so every reason that is a
  // property of the collection gets to name itself first.
  if (criteria.rulesKnown !== 'any') {
    // Whose knowledge counts. With people ticked it is theirs;
    // with nobody ticked it is the household's, exactly as the
    // familiarity bonus falls back to household-wide plays.
    //
    // `everyone` needs a table to be about, so with nobody ticked
    // it degrades to `someone` rather than demanding that every
    // person in the database knows the same game.
    const knowersByGame = new Map<string, Set<string>>();
    for (const claim of knownGames) {
      const knowers = knowersByGame.get(claim.gameId) ?? new Set<string>();
      knowers.add(claim.playerId);
      knowersByGame.set(claim.gameId, knowers);
    }

    const isEveryone = criteria.rulesKnown === 'everyone' && sessionPlayerIds !== null;

    const askedAbout = sessionPlayerIds ?? players.map((player) => player.id);

    const afterRulesKnown = survivors.filter((game) => {
      const knowers = knowersByGame.get(game.id);
      if (knowers === undefined) return false;

      return isEveryone
        ? askedAbout.every((id) => knowers.has(id))
        : askedAbout.some((id) => knowers.has(id));
    });

    if (afterRulesKnown.length === 0) {
      return {
        candidates: [],
        emptyReason: 'rulesKnown',
        suggestion: isEveryone
          ? "Nothing that fits is known by everyone here — try 'someone knows it', so one of you teaches."
          : "Nobody here knows a game that fits without the rulebook — allow one you'd have to read up on.",
      };
    }
    survivors = afterRulesKnown;
  }

  const beforeReroll = survivors.length;
  survivors = survivors.filter((game) => !criteria.excludedGameIds.includes(game.id));
  if (survivors.length === 0) {
    return {
      candidates: [],
      emptyReason: beforeReroll > 0 ? 'allRerolled' : 'noGames',
      suggestion:
        beforeReroll > 0
          ? 'You have rerolled past every game that fits. Clear the list to start over.'
          : null,
    };
  }

  const recentCutoff = now.getTime() - COOLDOWN.recentPlayWindowHours * 60 * 60 * 1000;

  const candidates = survivors.map((game): PickCandidate => {
    const gamePlays = plays.filter((play) => play.gameId === game.id);

    const weightedPlays = gamePlays.reduce(
      (total, play) => total + playWeightFor(play, sessionPlayerIds),
      0,
    );

    const playedRecently = gamePlays.some((play) => Date.parse(play.playedAt) >= recentCutoff);

    const verdict = verdictFor(game, criteria.playerCount);

    const familiarity = familiarityFor(weightedPlays);
    const cooldown = playedRecently ? COOLDOWN.recentPlayMultiplier : 1;
    const fitnessBonus =
      verdict === 'best'
        ? FITNESS_BONUS.best
        : verdict === 'unknown'
          ? FITNESS_BONUS.unknown
          : FITNESS_BONUS.recommended;
    const ratingNudge =
      game.rating === null
        ? 1
        : Math.min(RATING_NUDGE.max, Math.max(RATING_NUDGE.min, game.rating / RATING_NUDGE.divisor));

    return {
      game,
      verdict,
      playCount: gamePlays.length,
      score: {
        familiarity,
        cooldown,
        fitnessBonus,
        ratingNudge,
        total: familiarity * cooldown * fitnessBonus * ratingNudge,
      },
    };
  });

  return {
    candidates,
    emptyReason: 'noGames',
    suggestion: null,
  };
};

export const pick = (input: PickInput): PickResult => {
  const { candidates, emptyReason, suggestion } = evaluate(input);

  if (candidates.length === 0) {
    return {
      outcome: 'empty',
      reason: emptyReason,
      suggestion,
    };
  }

  const random = makeRandom(input.criteria.seed);
  const total = candidates.reduce((sum, candidate) => sum + candidate.score.total, 0);

  let target = random() * total;
  for (const candidate of candidates) {
    target -= candidate.score.total;
    if (target <= 0) {
      return {
        outcome: 'picked',
        candidate,
        eligibleCount: candidates.length,
      };
    }
  }

  // Floating-point drift only — the last candidate is as correct
  // an answer as any.
  //
  // The `!` is this repo's `noUncheckedIndexedAccess` and nothing else: the length check above
  // already proved the array is non-empty, and the compiler cannot see it. Same shape as
  // `engine/preview.ts`'s weighted draw.
  const last = candidates[candidates.length - 1]!;
  return {
    outcome: 'picked',
    candidate: last,
    eligibleCount: candidates.length,
  };
};
