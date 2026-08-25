/**
 * Matching a document library's titles against the collection.
 *
 * A rulebook library is named by whoever filed the PDFs, not by the collection. The same game
 * is `Orchard` on one side and `Orchard: Deluxe Edition` on the other; a publisher's stylised
 * `Pa$try Panic` is filed as `Pastry Panic`; a bare `Harbour Lantern` is filed as
 * `Harbour Lantern (Second Edition)`. So this is deliberately a *two-tier* matcher rather than
 * a fuzzy score:
 *
 *   - **exact** — the normalised titles are equal.
 *   - **prefix** — one normalised title is the other plus more words, and every candidate that
 *     fits belongs to the SAME game.
 *   - **ambiguous / none** — reported, never guessed.
 *
 * Fuzzy string distance was tried first and it is actively harmful here: it rates
 * `Castles of Rill` against `Villages of Rill` at 0.75, which is a *wrong rulebook on the
 * right-looking game*, and a wrong rulebook is worse than no rulebook. Better to hand the
 * leftovers to a human — in practice that is a handful of titles out of a whole library.
 */

/** A title in the collection, and the game it resolves to. */
export interface MatchTarget {
  gameId: string;
  /** The game's own name or one of its boxes' labels. */
  name: string;
}

export type MatchConfidence = 'exact' | 'prefix' | 'ambiguous' | 'none';

export interface TitleMatch {
  confidence: MatchConfidence;
  /** Non-null only for `exact` and `prefix`. */
  gameId: string | null;
  /**
   * What it *could* have been, when it could have been several things. The linker prints these
   * so a person can pick one by hand rather than wonder what it saw.
   */
  alternatives: string[];
}

/**
 * Words that a filing system adds and a collection does not (or the other way round). Stripped
 * from both sides, so the rule is symmetric and there is no "which side is canonical" question.
 */
const NOISE =
  /\b(?:rulebook|rulebooks|rules|rulesheet|the|a|an|second edition|2nd edition|first edition|1st edition|deluxe edition|edition)\b/g;

/**
 * Title → comparison key.
 *
 * Every rule here was earned by a real pair that failed without it, and each is safe because it
 * is applied to BOTH sides:
 *
 *   - parentheses go, because `Orchard (Second Edition)` and `Harbour Lantern: First Voyage
 *     (U.S.)` carry editions and regions that the other side omits;
 *   - `$` reads as `s`, because publishers stylise (`Pa$try Panic`) and librarians do not;
 *   - `&` reads as ` and `, because `Moth & Flame` is filed both ways;
 *   - everything non-alphanumeric collapses to a single space, which is what makes
 *     `Signal - Deep Water` and `Signal: Deep Water` the same string.
 */
export const normalizeTitle = (title: string): string =>
  title
    .toLowerCase()
    .replaceAll('&', ' and ')
    .replaceAll('$', 's')
    // Non-greedy, so `A (b) c (d)` loses both, not the middle.
    .replace(/\(.*?\)/g, ' ')
    .replace(NOISE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Is `longer` `shorter` plus at least one more whole word? */
const extendsTitle = (longer: string, shorter: string): boolean =>
  shorter !== '' && longer.startsWith(`${shorter} `);

const distinct = (values: string[]): string[] => [...new Set(values)];

/**
 * Resolve one library title to a game.
 *
 * `targets` should carry both game names and box labels: a rulebook is filed under the name on
 * the box, and the box label is the only place that name exists once several boxes have been
 * collapsed into one game.
 */
export const matchTitle = (title: string, targets: MatchTarget[]): TitleMatch => {
  const key = normalizeTitle(title);
  if (key === '')
    return {
      alternatives: [],
      confidence: 'none',
      gameId: null,
    };

  const keyed = targets.map((target) => ({
    ...target,
    key: normalizeTitle(target.name),
  }));

  const exact = keyed.filter((target) => target.key === key);
  const exactGameIds = distinct(exact.map((target) => target.gameId));

  if (exactGameIds.length === 1)
    return {
      alternatives: [],
      confidence: 'exact',
      gameId: exactGameIds[0] ?? null,
    };

  // Two DIFFERENT games with the same normalised name is a real possibility once editions are
  // stripped, and picking one at random would silently file the rulebook on the wrong shelf.
  if (exactGameIds.length > 1)
    return {
      alternatives: distinct(exact.map((target) => target.name)),
      confidence: 'ambiguous',
      gameId: null,
    };

  const prefixed = keyed.filter(
    (target) => extendsTitle(target.key, key) || extendsTitle(key, target.key),
  );
  const prefixGameIds = distinct(prefixed.map((target) => target.gameId));

  if (prefixGameIds.length === 1)
    return {
      alternatives: [],
      confidence: 'prefix',
      gameId: prefixGameIds[0] ?? null,
    };

  return {
    alternatives: distinct(prefixed.map((target) => target.name)),
    confidence: prefixGameIds.length > 1 ? 'ambiguous' : 'none',
    gameId: null,
  };
};
