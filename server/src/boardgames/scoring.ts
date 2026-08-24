/**
 * Every tunable number in the board-game picker lives here.
 *
 * These are a **starting point, not a finding**. They are meant to be moved after the first
 * real game night, and the point of one file is that they can be moved without a code hunt.
 */

/**
 * Familiarity — the deliberate inverse of this repo's `1/n²` least-watched weighting in
 * `providers/plex.ts`.
 *
 * The intent: play the same game a few times to get used to the rules before it falls back into
 * the "it could be anything" pool. So a game played once or twice is the MOST likely to come up,
 * a never-played game stays reachable, and a learned game recedes without disappearing.
 */
export const FAMILIARITY = {
  /** Never played — the "it could be anything" pool. */
  unplayed: 1,
  /** 1–4 plays: learning. Strongly preferred. */
  learning: 4,
  /** 5+ plays: learned. Fondly remembered, no longer urgent. */
  learned: 1.5,
  /** Where "learning" stops and "learned" starts. */
  learnedAtPlays: 5,
} as const;

/**
 * Played in the last day, so probably not again tonight — unless "keep learning" is on, which is
 * an explicit request for another crack at the same rules.
 */
export const COOLDOWN = {
  recentPlayMultiplier: 0.25,
  recentPlayWindowHours: 24,
} as const;

/**
 * A nudge towards player counts the community actually likes. `unknown` is penalised only
 * mildly: it means "nobody voted", not "it's bad", and treating those two the same would quietly
 * bury every small-press game in the collection.
 */
export const FITNESS_BONUS = {
  best: 1.5,
  recommended: 1,
  unknown: 0.8,
} as const;

/**
 * Community rating, clamped hard. A tiebreak, never a gate — the whole point is to surface the
 * collection you own, not BGG's top 100.
 */
export const RATING_NUDGE = {
  divisor: 7.5,
  min: 0.8,
  max: 1.2,
} as const;

/**
 * Mode 2 asks "games *we* have played". A play with exactly the selected people counts fully; a
 * play that also had four other people at the table is weaker evidence that this group knows the
 * rules.
 */
export const GROUP_PLAY_WEIGHT = {
  exactGroup: 1,
  supersetOfGroup: 0.6,
} as const;

/**
 * A verdict needs this many total votes to mean anything. Below it, the count is `unknown`
 * rather than a number.
 */
export const MIN_VOTES_FOR_VERDICT = 5;
