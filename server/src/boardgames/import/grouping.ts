// COLLAPSING BOXES INTO GAMES.
//
// The settled rule: **a game is the TITLE, not the BOX.** Several season boxes of one franchise
// are one game; a spin-off that plays differently is a different one. An expansion is never a
// game — it is a box belonging to one.
//
// Anything this file cannot decide is REPORTED, not guessed (`board_game_grouping_reviews`),
// because a wrong grouping silently removes a title from the pool and nobody ever notices.
//
// ── ⚠️ THE RULES ARE ROWS. THIS FILE HOLDS THE ALGORITHM AND NEVER THE ANSWERS ───────────
//
// The app this was absorbed from kept two hand-curated tables in THIS FILE — nineteen merge
// rules and four "no, that really is its own game" answers, each with the owner's own words
// quoted beside it. They are answers about one household's shelf, so they are DATA
// (decision 2026-08-23-the-collections-grouping-rules-are-rows-not-source), and this repo is
// public.
//
// So `groupBoxes` takes its rules as an ARGUMENT. `store/db/boardgameRules.ts` reads them out
// of `board_game_groupings` and `board_game_grouping_reviews`; the shape is documented by
// `store/migrate/board-game-grouping-seed.example.yaml`, whose titles are invented. **Do not
// reintroduce a constant here, and do not add an example that names a real title.**
//
// A COLLECTION WITH NO RULES AT ALL STILL GROUPS. Everything below — normalising a title,
// finding the franchise prefix, recognising an edition marker — works with both lists empty.
// What an empty rule set produces is a working picker holding a review list, which is exactly
// what an unreviewed collection looks like.
//
// ── A PREFIX IS A LITERAL, NEVER A PATTERN ───────────────────────────────────────────────
//
// The absorbed version matched a family rule with a `RegExp` compiled in source. A rule is a
// text column now, and the store never compiles a pattern out of one: a rule that looks like a
// pattern is a rule somebody expected to be executed. `prefixMatches` is a WORD BOUNDARY test —
// equal, or followed by a space — so a one-word rule cannot swallow a longer word that merely
// starts the same way.

export type BoxKind = 'standalone' | 'expansion';

export interface SourceBox {
  name: string;
  kind: BoxKind;
  bggId: number | null;
}

export interface GroupedGame {
  id: string;
  name: string;
  boxNames: string[];
  /** The external listing for the title, when no owned box IS that listing. */
  listingBggId?: number;
}

export interface GroupingReview {
  boxName: string;
  status: 'orphan' | 'ambiguous' | 'possibleEdition' | 'distinctAfterNormalizing';
  reason: string;
  /** Where it landed anyway, if anywhere. */
  gameId: string | null;
  /**
   * The title it was NEARLY filed under — the one whose prefix it shares. Carried because
   * answering the prompt with "yes, one game" is a merge, and a merge needs a survivor: without
   * this the screen could only offer to merge INTO the new title, which keeps the wrong id and
   * the wrong external listing. Null when nothing was near enough to name.
   */
  parentGameId: string | null;
}

export interface GroupingResult {
  games: GroupedGame[];
  /** Box name → game id. Every input box appears exactly once. */
  assignments: Map<string, string>;
  reviews: GroupingReview[];
}

/**
 * An owner merge, keyed by the physical box LABEL. Applied before the prefix rules so an answer
 * given from a screen survives the next import or sync.
 */
export interface OwnerGrouping {
  boxLabel: string;
  gameId: string;
  gameName: string;
  listingBggId?: number | null;
}

/**
 * "Every box whose title starts with this prefix is one title." The first matching rule wins,
 * so the caller hands them over already ordered by `position`.
 */
export interface PrefixGrouping {
  /** A LITERAL in comparison form. Never a pattern — see the file header. */
  prefix: string;
  gameId: string;
  gameName: string;
  /** A single literal that takes a matching box back OUT of the family. */
  exceptContains?: string | null;
  /** Make this title even though every box that matched is flagged as an expansion upstream. */
  isGameFromExpansions?: boolean;
  listingBggId?: number | null;
}

/** Everything the caller has to say about one household's shelf. */
export interface GroupingRules {
  owner: readonly OwnerGrouping[];
  prefixes: readonly PrefixGrouping[];
  /**
   * Titles somebody has looked at and confirmed are their own game, in COMPARISON FORM. They
   * share a prefix with something else, so the prefix check would flag them forever otherwise —
   * and a review list that never shrinks is a review list nobody reads.
   */
  confirmedSeparate: ReadonlySet<string>;
}

export const NO_GROUPING_RULES: GroupingRules = {
  confirmedSeparate: new Set<string>(),
  owner: [],
  prefixes: [],
};

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Comparison form: case-, punctuation- and dash-insensitive. Collection exports mix `-`, `–`
 * and `:` inside one franchise, so anything that treats those as meaningful mis-groups.
 *
 * Deliberately the same transformation as `store/db/boardgames.ts normalizeTitle` — the seed
 * reader validates a prefix against that one, and a rule that validated under one form and
 * matched under another would silently never fire.
 */
export const normalize = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The bit before the first `:` or `–`. Two titles in one franchise share it, which is how an
 * expansion finds a base game whose subtitle it does not repeat.
 */
export const franchiseOf = (name: string): string => normalize(name.split(/[:–—|]/)[0] ?? name);

/** A remainder that reads as "the same game in a different box" rather than as a new game. */
const EDITION_MARKER =
  /\b(kickstarter|deluxe|big box|retail|edition|anniversary|remaster(ed)?|rerolled|re rolled|2nd|second|3rd|third)\b/;

/**
 * Word-boundary prefix match. `name === prefix`, or `name` continues after a space.
 *
 * The boundary is the whole reason this is not `startsWith`: a rule for one short title would
 * otherwise swallow every longer title that begins with the same letters.
 */
const prefixMatches = (normalized: string, prefix: string): boolean =>
  normalized === prefix || normalized.startsWith(`${prefix} `);

interface Candidate {
  gameId: string;
  gameName: string;
  listingBggId?: number;
}

const listingOf = (value: number | null | undefined): number | undefined =>
  value == null ? undefined : value;

export const groupBoxes = (
  boxes: SourceBox[],
  rules: GroupingRules = NO_GROUPING_RULES,
): GroupingResult => {
  const ownerByLabel = new Map(rules.owner.map((row) => [row.boxLabel, row] as const));
  const games = new Map<string, GroupedGame>();
  const assignments = new Map<string, string>();
  const reviews: GroupingReview[] = [];

  /** The first rule whose prefix matches and whose escape hatch does not. */
  const ruleFor = (name: string): PrefixGrouping | undefined => {
    const normalized = normalize(name);
    return rules.prefixes.find(
      (rule) =>
        prefixMatches(normalized, rule.prefix) &&
        !(rule.exceptContains != null && normalized.includes(rule.exceptContains)),
    );
  };

  const addGame = (candidate: Candidate, boxName: string) => {
    const existing = games.get(candidate.gameId);
    if (existing) {
      existing.boxNames.push(boxName);
      if (existing.listingBggId === undefined && candidate.listingBggId !== undefined) {
        existing.listingBggId = candidate.listingBggId;
      }
    } else {
      const created: GroupedGame = {
        boxNames: [boxName],
        id: candidate.gameId,
        name: candidate.gameName,
      };
      if (candidate.listingBggId !== undefined) created.listingBggId = candidate.listingBggId;
      games.set(candidate.gameId, created);
    }
    assignments.set(boxName, candidate.gameId);
  };

  const standalones = boxes.filter((box) => box.kind === 'standalone');
  const expansions = boxes.filter((box) => box.kind === 'expansion');

  // Pass 1 — standalones become games, SHORTEST name first, so a base game is already
  // registered by the time an edition of it comes looking for one to attach to.
  const byLengthAsc = [...standalones].sort(
    (a, b) => normalize(a.name).length - normalize(b.name).length,
  );

  /** Every game id handed out, so two titles cannot share one. */
  const usedIds = new Set<string>();

  /**
   * Two titles differing ONLY in a symbol are different games — and stripping punctuation is
   * exactly what `slugify` does. Without this the second one silently becomes a box of the
   * first and disappears from the pool.
   */
  const uniqueId = (name: string): string => {
    const base = slugify(name) || 'game';
    if (!usedIds.has(base)) {
      usedIds.add(base);
      return base;
    }
    let suffix = 2;
    while (usedIds.has(`${base}-${suffix}`)) suffix += 1;
    const id = `${base}-${suffix}`;
    usedIds.add(id);
    return id;
  };

  /** Normalized standalone game name → game id. */
  const standaloneNames = new Map<string, string>();
  /** Normalized standalone game name → the exact title it came from. */
  const standaloneTitles = new Map<string, string>();
  /** Original standalone title → game id, for the franchise lookup. */
  const standaloneOriginals = new Map<string, string>();

  const applyOwner = (boxName: string): boolean => {
    const owner = ownerByLabel.get(boxName);
    if (!owner) return false;
    usedIds.add(owner.gameId);
    addGame(
      {
        gameId: owner.gameId,
        gameName: owner.gameName,
        listingBggId: listingOf(owner.listingBggId),
      },
      boxName,
    );
    // Index the physical box AND the name the owner gave the combined game, so an expansion of
    // the merged title can find the merge even when no box is titled that.
    standaloneNames.set(normalize(boxName), owner.gameId);
    standaloneTitles.set(normalize(boxName), boxName);
    standaloneOriginals.set(boxName, owner.gameId);
    standaloneNames.set(normalize(owner.gameName), owner.gameId);
    standaloneTitles.set(normalize(owner.gameName), owner.gameName);
    standaloneOriginals.set(owner.gameName, owner.gameId);
    return true;
  };

  for (const box of byLengthAsc) {
    if (applyOwner(box.name)) continue;

    const rule = ruleFor(box.name);
    if (rule) {
      usedIds.add(rule.gameId);
      addGame(
        {
          gameId: rule.gameId,
          gameName: rule.gameName,
          listingBggId: listingOf(rule.listingBggId),
        },
        box.name,
      );
      // Registered under its OWN title as well, so an expansion that shares only the franchise
      // can still find it. Without this a base game was consumed by its family rule and never
      // entered the franchise index — which orphaned every expansion of it at once.
      standaloneNames.set(normalize(box.name), rule.gameId);
      standaloneTitles.set(normalize(box.name), box.name);
      standaloneOriginals.set(box.name, rule.gameId);
      continue;
    }

    const normalized = normalize(box.name);

    // Already have this EXACT title? A second copy is a second box, not a second game. Same
    // normalized form but a different original is the symbol case above: two games, reported
    // rather than merged.
    const sameNormalized = standaloneNames.get(normalized);
    if (sameNormalized) {
      if (standaloneTitles.get(normalized) === box.name) {
        addGame(
          { gameId: sameNormalized, gameName: games.get(sameNormalized)?.name ?? box.name },
          box.name,
        );
        continue;
      }

      reviews.push({
        boxName: box.name,
        gameId: null,
        parentGameId: sameNormalized,
        reason: `Reads identically to “${standaloneTitles.get(normalized) ?? ''}” once punctuation is stripped.`,
        status: 'distinctAfterNormalizing',
      });

      const distinctId = uniqueId(box.name);
      addGame({ gameId: distinctId, gameName: box.name }, box.name);
      continue;
    }

    // A box whose title is another title plus an edition marker is another BOX of it. Anything
    // else is a new game, flagged so somebody can say otherwise.
    const parent = longestPrefixMatch(normalized, standaloneNames);
    if (parent) {
      const remainder = normalized.slice(parent.prefix.length).trim();
      if (EDITION_MARKER.test(remainder)) {
        addGame(
          { gameId: parent.gameId, gameName: games.get(parent.gameId)?.name ?? box.name },
          box.name,
        );
        continue;
      }
      if (!rules.confirmedSeparate.has(normalized)) {
        // Both halves as they read on the boxes, not as the matcher saw them: this sentence is
        // for a person, and the comparison form is not what is printed on either lid.
        const parentTitle = standaloneTitles.get(parent.prefix);
        reviews.push({
          boxName: box.name,
          gameId: null,
          parentGameId: parent.gameId,
          reason: `Shares a title prefix with “${parentTitle ?? parent.prefix}”, but “${originalRemainder(box.name, parentTitle) ?? remainder}” does not read as an edition.`,
          status: 'possibleEdition',
        });
      }
    }

    const gameId = uniqueId(box.name);
    standaloneNames.set(normalized, gameId);
    standaloneTitles.set(normalized, box.name);
    standaloneOriginals.set(box.name, gameId);
    addGame({ gameId, gameName: box.name }, box.name);
  }

  // Pass 2 — expansions attach to a game. They never make one, unless a rule says this
  // "expansion" is really its own game.
  //
  // The index is built from the ORIGINAL titles, not the normalized keys: normalizing has
  // already eaten the `:` that `franchiseOf` splits on, so indexing the keys would file every
  // game under its own full name and no expansion would ever find a franchise sibling.
  const franchiseIndex = new Map<string, Set<string>>();
  for (const [originalName, gameId] of standaloneOriginals) {
    const franchise = franchiseOf(originalName);
    const set = franchiseIndex.get(franchise) ?? new Set<string>();
    set.add(gameId);
    franchiseIndex.set(franchise, set);
  }

  for (const box of expansions) {
    if (applyOwner(box.name)) continue;

    const rule = ruleFor(box.name);
    if (rule) {
      const target = games.get(rule.gameId);
      if (target !== undefined || rule.isGameFromExpansions === true) {
        addGame(
          {
            gameId: rule.gameId,
            gameName: rule.gameName,
            listingBggId: listingOf(rule.listingBggId),
          },
          box.name,
        );
        continue;
      }
    }

    const normalized = normalize(box.name);

    const parent = longestPrefixMatch(normalized, standaloneNames);
    if (parent) {
      addGame(
        { gameId: parent.gameId, gameName: games.get(parent.gameId)?.name ?? box.name },
        box.name,
      );
      continue;
    }

    const franchise = franchiseIndex.get(franchiseOf(box.name));
    if (franchise?.size === 1) {
      // `size === 1` on the line above is what proves the spread is non-empty.
      const gameId = [...franchise][0]!;
      addGame({ gameId, gameName: games.get(gameId)?.name ?? box.name }, box.name);
      continue;
    }

    if (franchise && franchise.size > 1) {
      reviews.push({
        boxName: box.name,
        gameId: null,
        parentGameId: null,
        reason: `Could belong to any of ${franchise.size} games sharing “${franchiseOf(box.name)}”.`,
        status: 'ambiguous',
      });
      continue;
    }

    reviews.push({
      boxName: box.name,
      gameId: null,
      parentGameId: null,
      reason:
        'No owned base game matches this expansion — the base game is either missing from the ' +
        'collection or titled differently.',
      status: 'orphan',
    });
  }

  return { assignments, games: [...games.values()], reviews };
};

/**
 * A title minus its parent's title, separator and all trimmed off. Null when the box does not
 * literally start with the parent's title — normalizing eats punctuation, so the prefix match
 * can hold where a plain slice would cut mid-word.
 */
const originalRemainder = (boxName: string, parentTitle: string | undefined): string | null => {
  if (!parentTitle) return null;
  if (!boxName.toLowerCase().startsWith(parentTitle.toLowerCase())) return null;
  const rest = boxName
    .slice(parentTitle.length)
    .replace(/^[\s:–—|-]+/, '')
    .trim();
  return rest === '' ? null : rest;
};

const longestPrefixMatch = (
  normalized: string,
  standaloneNames: Map<string, string>,
): { prefix: string; gameId: string } | null => {
  let best: { prefix: string; gameId: string } | null = null;
  for (const [name, gameId] of standaloneNames) {
    if (name === normalized) continue;
    if (!normalized.startsWith(`${name} `)) continue;
    if (best && best.prefix.length >= name.length) continue;
    best = { gameId, prefix: name };
  }
  return best;
};
