// THE BOARD-GAME VOCABULARY — the subset of the absorbed app's `contracts` package that the
// pick engine actually reads.
//
// WHY A SUBSET. The origin repo ships one 453-line `@board-game-picker/contracts` module that
// the server AND its web app share. Vendoring all of it here would import art candidates,
// override payloads and gallery paging that nothing in this repo calls, and every one of them
// would then have to be kept true against a schema this package does not own yet. So this file
// holds exactly what `pick.ts`, `verdict.ts` and `pick.test.ts` reference, plus what those
// types reference in turn. WP-4b adds the rest as its own code needs it — an unused type is
// not a head start, it is a claim nobody checks.
//
// WHAT WAS DELIBERATELY LEFT BEHIND: `INTERACTION_TYPES`, `GAME_LINK_KINDS`, `bggListingUrl`,
// `KNOWLEDGE_STALE_AFTER_DAYS`, `GameOverride`, `ArtCandidate`, `ArtCandidateKind`, `GameArt`.
//
// NOTHING HERE IS BOARDGAMEGEEK-SHAPED, on purpose. `bggId` is a nullable back-reference and
// every other field stands on its own, because the database is the book of record and BGG is
// one importer among several — a game typed in by hand is the other one that already exists.

/**
 * How a game is played *against* the other people at the table — versus, teams, co-op. This is
 * the must-have facet, and the one the picker's request validation is written around.
 */
export type InteractionType =
  | 'competitive'
  | 'cooperative'
  | 'semiCooperative'
  | 'team'
  | 'traitor'
  | 'solo';

/**
 * What the community thinks of playing this game at a given player count — the whole reason the
 * absorbed app exists. A box saying "2–5" is a manufacturing claim; this is a verdict.
 *
 * `unknown` is NOT a soft `notRecommended`. A niche game with three votes must stay pickable,
 * flagged rather than filtered.
 */
export type PlayerCountVerdict = 'best' | 'recommended' | 'notRecommended' | 'unknown';

/**
 * Where a field's value came from. Every derived value carries one, because a guess that cannot
 * be told apart from a fact is how a collection loses the owner's trust.
 */
export type FieldSource = 'import' | 'owner' | 'derived';

/** A title. Not a box — one title can be several physical boxes on a shelf. */
export interface Game {
  id: string;
  name: string;
  /** The box claim. Recorded, but never the thing filtered on alone. */
  minPlayers: number;
  maxPlayers: number;
  /** Counts the community calls `best`. May be empty. */
  bestWith: number[];
  /** Counts the community calls `recommended`. May be empty. */
  recommendedWith: number[];
  /** BGG-style 1.0–5.0 complexity. `null` when unknown — never 0. */
  weight: number | null;
  minPlaytime: number | null;
  maxPlaytime: number | null;
  minAge: number | null;
  /**
   * A game is often more than one of these — a co-op box with a solo mode is both, and plenty
   * of titles are co-op AND versus. Never empty; `['competitive']` is the floor.
   */
  interactionTypes: InteractionType[];
  interactionTypesSource: FieldSource;
  /** BGG's auto mechanic/category tags — a palette, not the truth. */
  categories: string[];
  /** The owner's own categories (Roll 'n Write, …), theirs to manage. */
  ownerCategories: string[];
  yearPublished: number | null;
  /** Who made it. Searchable — a publisher name should find its games. */
  publishers: string[];
  /** Nullable by design: a game need not exist on BGG. */
  bggId: number | null;
  /** Community rating, mild tiebreak only. */
  rating: number | null;
  /** Owned but never want to be offered it. */
  isExcluded: boolean;
  notes: string | null;
  /** The poster the UI shows. Owner override wins; otherwise the first box that has art. */
  imagePath: string | null;
  /** `owner` when the owner picked or uploaded it; `import` when enrichment did. */
  imageSource: FieldSource | null;
  /** Every physical box that belongs to this title. */
  boxes: Box[];
  /** Rulebooks, how-to-play videos, anything else. Often empty. */
  links: GameLink[];
  /** Ways to play this one: modules, deck sets, arcs. Often empty. */
  modules: GameModule[];
  /** Denormalised for the collection screen. */
  playCount: number;
}

/**
 * One way to play a game — a module, a deck set, a campaign arc.
 *
 * Not the same axis as a {@link Box}. For some titles a module happens to *be* an expansion
 * box, which is why the list is seeded from them; for a game whose variety is deck sets or a
 * character roster it is something inside one box.
 *
 * v1 only lists these. Randomising a setup after a pick is the intended next step and is why
 * they are rows rather than a blob.
 */
export interface GameModule {
  id: string;
  gameId: string;
  name: string;
  /**
   * `derived` was seeded from an expansion box and a re-derive may rename it. `owner` was typed
   * by hand, and nothing automated touches it.
   */
  source: Extract<FieldSource, 'owner' | 'derived'>;
  /** The box it came from, when it came from one. */
  boxId: string | null;
}

/**
 * What a link off a game is *for*. Deliberately a small closed set rather than free text: the
 * card decides where a link goes and what it is called from this, and "some URL with a name" is
 * a bookmark bar, not a feature.
 *
 * `reference` is the escape hatch — a forum thread, a player aid, a house-rules doc.
 */
export type GameLinkKind = 'rulebook' | 'howToPlay' | 'reference';

/**
 * A way out of the app and into something that explains the game you were just handed.
 *
 * Nothing here names Kavita, YouTube or BoardGameGeek. One deployment's rulebooks may sit in a
 * Kavita library and its how-to-play videos on YouTube; the next has neither — so the app
 * stores **a URL**, and a *linker* is an optional, replaceable thing that fills them in. Typing
 * one by hand has to be as first-class as any importer, because for most installs that is the
 * only route there is.
 */
export interface GameLink {
  id: string;
  gameId: string;
  kind: GameLinkKind;
  /** What the button says. "Rulebook", "Watch It Played", … */
  label: string;
  url: string;
  /**
   * `owner` is typed by hand and is never touched by a linker. `derived` was written by one,
   * and the same linker may replace it on the next run.
   */
  source: Extract<FieldSource, 'owner' | 'derived'>;
}

/** A physical thing on a shelf. This is what you go and fetch. */
export interface Box {
  id: string;
  gameId: string;
  label: string;
  kind: 'standalone' | 'expansion';
  bggId: number | null;
  /** Cached from the inventory app; inventory is never on the pick hot path. */
  homeboxEntityId: string | null;
  locationText: string | null;
  /** Served from this app's origin, never hotlinked. `null` in v1. */
  imagePath: string | null;
  /** The BGG edition name from the collection export. */
  versionNickname: string | null;
  versionYear: number | null;
  versionLanguages: string[];
}

export interface Player {
  id: string;
  displayName: string;
  birthYear: number | null;
  /** This person's personal complexity ceiling, 1.0–5.0. */
  maxWeight: number | null;
  isBeginner: boolean;
}

export interface Group {
  id: string;
  name: string;
  playerIds: string[];
}

export interface Play {
  id: string;
  gameId: string;
  /** ISO 8601. */
  playedAt: string;
  playerIds: string[];
  notes: string | null;
}

/**
 * One person knows one game well enough to sit down and play it without opening the rulebook.
 *
 * A separate fact from `Play`, not a summary of one. Six plays of a heavy game and you may
 * still reach for the book; a game learned at someone else's table has no `Play` row here at
 * all.
 */
export interface KnownGame {
  playerId: string;
  gameId: string;
  /**
   * ISO 8601 — when this was last known to be true. Set when it is ticked, refreshed when that
   * person logs a play. It never expires on its own; the UI just says how long ago it was.
   */
  confirmedAt: string;
}

/**
 * How many people a request for this KIND of game can sensibly name. A constraint on the
 * question, not a claim about the games: plenty of co-op boxes have a solo mode, but "find me a
 * co-op game for one person" is not what anyone means when they tap Co-op.
 *
 *   - **Solo is exactly 1.** Nothing else is selectable.
 *   - **Co-op and traitor cannot be 1.**
 *   - **Traitor starts at 3.** A handful of traitor boxes claim 2 on the lid; their community
 *     verdicts do not agree, and this table follows the verdicts.
 *
 * `null` max means "whatever the game allows". Enforced in the UI *and* in `pick()`, because a
 * constraint that lives only in a component is one API call away from not existing.
 */
export const PLAYER_COUNT_LIMITS: Record<InteractionType, { min: number; max: number | null }> = {
  competitive: { min: 1, max: null },
  cooperative: { min: 2, max: null },
  semiCooperative: { min: 2, max: null },
  solo: { min: 1, max: 1 },
  team: { min: 2, max: null },
  traitor: { min: 3, max: null },
};

export const isPlayerCountAllowed = (
  interactionType: InteractionType | null,
  count: number,
): boolean => {
  if (interactionType === null) return true;
  const { min, max } = PLAYER_COUNT_LIMITS[interactionType];
  return count >= min && (max === null || count <= max);
};

/**
 * How strictly the player count is enforced. `bestOrRecommended` is the default: `bestOnly`
 * empties the set surprisingly often, and `any` is the box lying to you again.
 */
export type PlayerCountFitness = 'bestOnly' | 'bestOrRecommended' | 'any';

/**
 * How much of the table already knows the rules — the "we want to start playing, not start
 * reading" dial.
 *
 * - `any` — no constraint. The default; the shelf is the shelf.
 * - `someone` — at least one person here knows it, so there is a teacher and nobody opens the
 *   book.
 * - `everyone` — nobody has to be taught at all. The fastest possible start, and a much smaller
 *   pool.
 *
 * With nobody ticked in "who's here", `everyone` cannot mean the whole household — that is a
 * bar almost nothing clears — so both settings fall back to "someone in the household knows
 * it", mirroring how the familiarity bonus falls back to household-wide plays.
 */
export type RulesKnown = 'any' | 'someone' | 'everyone';

/**
 * One resolved request to the picker. Both modes fill this in — mode 1 from the form, mode 2
 * from the group — and there is exactly one `pick()` behind them.
 */
export interface PickCriteria {
  playerCount: number;
  fitness: PlayerCountFitness;
  interactionType: InteractionType | null;
  /** Owner categories the game must ALL carry. Empty = no filter. */
  categories: string[];
  /** Complexity ceiling for this session, 1.0–5.0. */
  maxWeight: number | null;
  /** Minutes. Filters on `minPlaytime`, not the optimistic max. */
  maxPlaytime: number | null;
  /** How much of the table must already know the rules. */
  rulesKnown: RulesKnown;
  /** Mode 2: whose shared history the familiarity bonus counts. */
  groupId: string | null;
  /**
   * Ad-hoc "who's playing" — an explicit set of people, not a saved group. Their complexity
   * ceilings apply and the familiarity bonus counts plays with exactly them, same as a group. A
   * saved group is just a shortcut that fills this. When both are set, this wins.
   */
  playerIds: string[] | null;
  /** Reroll's session-scoped memory. */
  excludedGameIds: string[];
  /** Omit for a real draw; set in tests for a deterministic one. */
  seed?: number;
}

/** Why a game scored what it scored. Shown in the dry-run CLI. */
export interface PickScoreBreakdown {
  familiarity: number;
  cooldown: number;
  fitnessBonus: number;
  ratingNudge: number;
  total: number;
}

export interface PickCandidate {
  game: Game;
  verdict: PlayerCountVerdict;
  playCount: number;
  score: PickScoreBreakdown;
}

/**
 * A pick either produced a game or it produced an explanation. There is no third state, and "no
 * games" is never silently widened into "here, have one anyway".
 */
export type PickResult =
  | {
      outcome: 'picked';
      candidate: PickCandidate;
      /** How many others were eligible — feeds "reroll" copy. */
      eligibleCount: number;
    }
  | {
      outcome: 'empty';
      /** Which filter emptied the set. */
      reason: EmptyReason;
      /** The single loosest relaxation worth offering. */
      suggestion: string | null;
    };

export type EmptyReason =
  | 'noGames'
  | 'playerCount'
  | 'fitness'
  | 'interactionType'
  | 'category'
  | 'weight'
  | 'playtime'
  | 'rulesKnown'
  | 'allRerolled';
