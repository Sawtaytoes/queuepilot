import type { Game, PlayerCountVerdict } from './types.js';

/**
 * What the community thinks of this game at `count` players.
 *
 * The `unknown` case is load-bearing. A game nobody voted on is not a bad game at four players —
 * it is a game with no data, and conflating those two silently buries every small-press title in
 * the collection.
 */
export const verdictFor = (game: Game, count: number): PlayerCountVerdict => {
  if (game.bestWith.includes(count)) return 'best';
  if (game.recommendedWith.includes(count)) return 'recommended';

  // No votes at all — the box range is the only thing we know.
  if (game.bestWith.length === 0 && game.recommendedWith.length === 0) {
    return 'unknown';
  }

  // There ARE votes and this count is in none of them, which is the community actively saying
  // "not at this size".
  return 'notRecommended';
};

export const fitsBoxRange = (game: Game, count: number): boolean =>
  count >= game.minPlayers && count <= game.maxPlayers;
