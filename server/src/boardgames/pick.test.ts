import { describe, expect, it } from 'vitest';
import { evaluate, pick } from './pick.js';
import type { Game, KnownGame, PickCriteria, Play, Player } from './types.js';

const player = (overrides: Partial<Player> = {}): Player => ({
  id: 'p',
  displayName: 'Person',
  birthYear: null,
  maxWeight: null,
  isBeginner: false,
  ...overrides,
});

/**
 * Invented games and invented people. Nothing in this repo — not
 * a fixture, not a story, not a test — carries the owner's data.
 */
const game = (overrides: Partial<Game> = {}): Game => ({
  id: 'sample',
  name: 'Sample',
  minPlayers: 2,
  maxPlayers: 5,
  bestWith: [3, 4],
  recommendedWith: [2, 5],
  weight: 2.5,
  minPlaytime: 30,
  maxPlaytime: 60,
  minAge: 10,
  interactionTypes: ['competitive'],
  interactionTypesSource: 'derived',
  categories: [],
  ownerCategories: [],
  publishers: [],
  yearPublished: 2020,
  bggId: null,
  rating: 7.5,
  isExcluded: false,
  notes: null,
  boxes: [],
  links: [],
  modules: [],
  playCount: 0,
  imagePath: null,
  imageSource: null,
  ...overrides,
});

const criteria = (overrides: Partial<PickCriteria> = {}): PickCriteria => ({
  playerCount: 3,
  fitness: 'bestOrRecommended',
  interactionType: null,
  categories: [],
  maxWeight: null,
  maxPlaytime: null,
  rulesKnown: 'any',
  groupId: null,
  playerIds: null,
  excludedGameIds: [],
  seed: 1,
  ...overrides,
});

const input = (
  games: Game[],
  overrides: Partial<PickCriteria> = {},
  plays: Play[] = [],
) => ({
  games,
  plays,
  players: [],
  groups: [],
  criteria: criteria(overrides),
  now: new Date('2026-08-09T20:00:00Z'),
});

describe("ad-hoc who's-here players", () => {
  it("applies the most cautious selected player's ceiling", () => {
    const result = evaluate({
      games: [game({ id: 'heavy', weight: 3.8 }), game({ id: 'light', weight: 1.5 })],
      plays: [],
      players: [player({ id: 'a', maxWeight: 2.0 }), player({ id: 'b', maxWeight: null })],
      groups: [],
      criteria: criteria({
        playerCount: 2,
        fitness: 'any',
        playerIds: ['a', 'b'],
      }),
      now: new Date('2026-08-09T20:00:00Z'),
    });

    const ids = result.candidates.map((candidate) => candidate.game.id);
    expect(ids).toContain('light');
    expect(ids).not.toContain('heavy');
  });
});

describe('player-count fitness', () => {
  it('keeps a game the community calls best at this count', () => {
    const result = evaluate(input([game()], { playerCount: 3 }));
    expect(result.candidates[0]?.verdict).toBe('best');
  });

  it('drops a count the community voted against', () => {
    // 4 is in neither list, and there ARE votes, so the silence
    // is an opinion.
    const result = evaluate(
      input([game({ bestWith: [2], recommendedWith: [3] })], {
        playerCount: 4,
      }),
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.emptyReason).toBe('fitness');
  });

  it('keeps an unvoted game rather than treating it as bad', () => {
    const result = evaluate(
      input([game({ bestWith: [], recommendedWith: [] })], {
        playerCount: 4,
      }),
    );
    expect(result.candidates[0]?.verdict).toBe('unknown');
  });

  it('bestOnly excludes a merely-recommended count', () => {
    const result = evaluate(
      input([game()], {
        playerCount: 2,
        fitness: 'bestOnly',
      }),
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.suggestion).toContain('play well');
  });
});

describe('hard filters', () => {
  it('respects the box range before anything else', () => {
    const result = evaluate(input([game()], { playerCount: 6 }));
    expect(result.emptyReason).toBe('playerCount');
  });

  it('never offers an excluded game', () => {
    const result = evaluate(input([game({ isExcluded: true })]));
    expect(result.emptyReason).toBe('noGames');
  });

  it('keeps unknown-weight games under a complexity ceiling', () => {
    // Over half the imported collection has no weight. Filtering
    // those out would make the dial look broken.
    const result = evaluate(input([game({ weight: null })], { maxWeight: 1.5 }));
    expect(result.candidates).toHaveLength(1);
  });

  it('names the filter that emptied the set', () => {
    const result = evaluate(input([game({ weight: 4.5 })], { maxWeight: 2 }));
    expect(result.emptyReason).toBe('weight');
    expect(result.suggestion).toContain('complexity');
  });

  it("caps complexity at the most cautious player's ceiling", () => {
    const result = evaluate({
      games: [game({ weight: 3 })],
      plays: [],
      players: [
        {
          id: 'ada',
          displayName: 'Ada',
          birthYear: null,
          maxWeight: 4,
          isBeginner: false,
        },
        {
          id: 'linus',
          displayName: 'Linus',
          birthYear: null,
          maxWeight: 2,
          isBeginner: true,
        },
      ],
      groups: [
        {
          id: 'pair',
          name: 'Ada & Linus',
          playerIds: ['ada', 'linus'],
        },
      ],
      criteria: criteria({ groupId: 'pair' }),
      now: new Date('2026-08-09T20:00:00Z'),
    });

    expect(result.emptyReason).toBe('weight');
  });
});

describe('what the kind of game does to the player count', () => {
  it('refuses a solo game for more than one', () => {
    const result = evaluate(
      input([game({ interactionTypes: ['solo'] })], {
        interactionType: 'solo',
        playerCount: 3,
      }),
    );

    expect(result.emptyReason).toBe('interactionType');
    expect(result.suggestion).toContain('exactly 1');
  });

  it('refuses a co-op game for one', () => {
    // Plenty of co-op boxes have a solo mode. "Find me a co-op
    // game for one person" is still not what anyone means.
    const result = evaluate(
      input([game({ interactionTypes: ['cooperative'] })], {
        interactionType: 'cooperative',
        playerCount: 1,
      }),
    );

    expect(result.emptyReason).toBe('interactionType');
  });

  it('refuses a traitor game under three', () => {
    const result = evaluate(
      input([game({ interactionTypes: ['traitor'] })], {
        interactionType: 'traitor',
        playerCount: 2,
      }),
    );

    expect(result.suggestion).toContain('at least 3');
  });

  it('leaves the count alone when no kind is chosen', () => {
    const result = evaluate(input([game()], { interactionType: null }));

    expect(result.candidates).toHaveLength(1);
  });
});

describe('familiarity weighting', () => {
  const play = (gameId: string, playedAt: string): Play => ({
    id: `${gameId}-${playedAt}`,
    gameId,
    playedAt,
    playerIds: ['ada'],
    notes: null,
  });

  it('prefers a partly-learned game over a never-played one', () => {
    const learning = evaluate(
      input([game({ id: 'learning' })], {}, [play('learning', '2026-08-01T20:00:00Z')]),
    ).candidates[0];

    const unplayed = evaluate(input([game({ id: 'unplayed' })])).candidates[0];

    expect(learning?.score.familiarity).toBeGreaterThan(unplayed?.score.familiarity ?? 0);
  });

  it('backs off once a game is learned', () => {
    const plays = Array.from({ length: 6 }, (_, index) =>
      play('learned', `2026-0${index + 1}-01T20:00:00Z`),
    );
    const learned = evaluate(input([game({ id: 'learned' })], {}, plays)).candidates[0];

    expect(learned?.score.familiarity).toBe(1.5);
  });

  it('cools a game played in the last day right down', () => {
    const result = evaluate(
      input([game({ id: 'tonight' })], {}, [play('tonight', '2026-08-09T14:00:00Z')]),
    );
    expect(result.candidates[0]?.score.cooldown).toBe(0.25);
  });

  it('only counts plays that included everyone in the group', () => {
    const shared = {
      games: [game({ id: 'shared' })],
      plays: [
        {
          id: 'solo-play',
          gameId: 'shared',
          playedAt: '2026-07-01T20:00:00Z',
          // Grace was not there, so this says nothing about
          // whether Ada AND Grace know the rules.
          playerIds: ['ada'],
          notes: null,
        },
      ],
      players: [
        {
          id: 'ada',
          displayName: 'Ada',
          birthYear: null,
          maxWeight: null,
          isBeginner: false,
        },
        {
          id: 'grace',
          displayName: 'Grace',
          birthYear: null,
          maxWeight: null,
          isBeginner: false,
        },
      ],
      groups: [
        {
          id: 'pair',
          name: 'Ada & Grace',
          playerIds: ['ada', 'grace'],
        },
      ],
      criteria: criteria({ groupId: 'pair' }),
      now: new Date('2026-08-09T20:00:00Z'),
    };

    expect(evaluate(shared).candidates[0]?.score.familiarity).toBe(1);
  });
});

describe('drawing', () => {
  it('is deterministic for a given seed', () => {
    const games = Array.from({ length: 10 }, (_, index) =>
      game({ id: `game-${index}`, name: `Game ${index}` }),
    );

    const first = pick(input(games, { seed: 42 }));
    const second = pick(input(games, { seed: 42 }));

    expect(first).toStrictEqual(second);
  });

  it('never draws a game the session already rerolled past', () => {
    const games = [game({ id: 'a' }), game({ id: 'b' })];
    const result = pick(input(games, { excludedGameIds: ['a'], seed: 7 }));

    expect(result).toMatchObject({
      outcome: 'picked',
      candidate: { game: { id: 'b' } },
    });
  });

  it('says so instead of looping when rerolls run out', () => {
    const result = pick(
      input([game({ id: 'a' })], {
        excludedGameIds: ['a'],
      }),
    );

    expect(result).toMatchObject({
      outcome: 'empty',
      reason: 'allRerolled',
    });
  });
});

describe('who already knows the rules', () => {
  /** Ada knows Alpha; Grace knows Beta. Nobody knows Gamma. */
  const knows = (playerId: string, gameId: string): KnownGame => ({
    confirmedAt: '2026-08-01T00:00:00Z',
    gameId,
    playerId,
  });

  const shelf = [game({ id: 'alpha' }), game({ id: 'beta' }), game({ id: 'gamma' })];

  const table = {
    games: shelf,
    groups: [],
    knownGames: [knows('ada', 'alpha'), knows('grace', 'beta')],
    players: [
      player({ id: 'ada', displayName: 'Ada' }),
      player({ id: 'grace', displayName: 'Grace' }),
      player({ id: 'linus', displayName: 'Linus' }),
    ],
    plays: [],
    now: new Date('2026-08-09T20:00:00Z'),
  };

  it('leaves the shelf alone when nobody asked', () => {
    const { candidates } = evaluate({
      ...table,
      criteria: criteria({ rulesKnown: 'any' }),
    });

    expect(candidates).toHaveLength(3);
  });

  it('keeps a game one person at the table can teach', () => {
    const { candidates } = evaluate({
      ...table,
      criteria: criteria({
        playerIds: ['ada', 'linus'],
        rulesKnown: 'someone',
      }),
    });

    // Beta is known — but by Grace, who is not here tonight.
    expect(candidates.map((one) => one.game.id)).toEqual(['alpha']);
  });

  it('drops a game only one of you knows when everyone must', () => {
    const { candidates } = evaluate({
      ...table,
      criteria: criteria({
        playerIds: ['ada', 'grace'],
        rulesKnown: 'everyone',
      }),
    });

    expect(candidates).toHaveLength(0);
  });

  it('keeps the one you both know', () => {
    const { candidates } = evaluate({
      ...table,
      criteria: criteria({
        playerIds: ['ada', 'grace'],
        rulesKnown: 'everyone',
      }),
      knownGames: [...table.knownGames, knows('grace', 'alpha')],
    });

    expect(candidates.map((one) => one.game.id)).toEqual(['alpha']);
  });

  it('falls back to the household when nobody is ticked', () => {
    // No `playerIds`, so "someone" means someone in the house —
    // the same fallback the familiarity bonus makes.
    const { candidates } = evaluate({
      ...table,
      criteria: criteria({ rulesKnown: 'someone' }),
    });

    expect(candidates.map((one) => one.game.id)).toEqual(['alpha', 'beta']);
  });

  it('does not demand the whole household when nobody is ticked', () => {
    // `everyone` needs a table to be about. Without one it would
    // otherwise ask that all three people know the same game,
    // which is not what an unticked form is asking.
    const { candidates } = evaluate({
      ...table,
      criteria: criteria({ rulesKnown: 'everyone' }),
    });

    expect(candidates.map((one) => one.game.id)).toEqual(['alpha', 'beta']);
  });

  it('names itself, and offers the teacher, when it empties the pool', () => {
    const result = pick({
      ...table,
      criteria: criteria({
        playerIds: ['linus'],
        rulesKnown: 'someone',
      }),
    });

    expect(result).toMatchObject({
      outcome: 'empty',
      reason: 'rulesKnown',
    });
  });

  it('suggests dropping to a teacher rather than the rulebook', () => {
    const result = pick({
      ...table,
      criteria: criteria({
        playerIds: ['ada', 'grace'],
        rulesKnown: 'everyone',
      }),
    });

    expect(result.outcome === 'empty' ? result.suggestion : null).toContain('someone knows it');
  });
});
