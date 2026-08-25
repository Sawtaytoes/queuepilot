/**
 * Which BGG version is the copy on the shelf.
 *
 * The collection export names the owned edition (`version_nickname`, year, language). BGG's
 * version list uses the same names. We match exactly, and we refuse to guess: a wrong cover is
 * worse than the title's default image.
 */

export interface EditionHint {
  nickname: string | null;
  year: number | null;
  languages: string[];
}

export interface CatalogEdition {
  id: number;
  name: string;
  year?: number | null;
  languages?: readonly string[];
}

export const normalizeEditionName = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, ' ');

const sharesLanguage = (
  left: readonly string[] | undefined,
  right: readonly string[],
): boolean => {
  if (!left || left.length === 0 || right.length === 0) return false;
  const wanted = new Set(right.map((language) => normalizeEditionName(language)));
  return left.some((language) => wanted.has(normalizeEditionName(language)));
};

/**
 * `null` means "use the title default" — not "pick the first English one and hope". Two
 * versions that share a name AND a year (same-year reprints of one edition) stay unresolved on
 * purpose.
 */
export const matchEdition = (
  hint: EditionHint,
  catalog: readonly CatalogEdition[],
): CatalogEdition | null => {
  const nickname = hint.nickname ? normalizeEditionName(hint.nickname) : '';

  if (nickname !== '') {
    const exact = catalog.filter(
      (edition) => normalizeEditionName(edition.name) === nickname,
    );
    const picked = breakTies(exact, hint);
    if (picked || exact.length > 0) return picked;
    // A nickname that matches nothing is a miss, not a prompt to invent an English printing
    // from the year alone.
    return null;
  }

  if (hint.year !== null && hint.languages.length > 0) {
    const byYearAndLanguage = catalog.filter(
      (edition) =>
        edition.year === hint.year && sharesLanguage(edition.languages, hint.languages),
    );
    if (byYearAndLanguage.length === 1) return byYearAndLanguage[0] ?? null;
  }

  return null;
};

const breakTies = (
  candidates: CatalogEdition[],
  hint: EditionHint,
): CatalogEdition | null => {
  if (candidates.length === 1) return candidates[0] ?? null;
  if (candidates.length === 0) return null;

  if (hint.year !== null) {
    const byYear = candidates.filter((edition) => edition.year === hint.year);
    if (byYear.length === 1) return byYear[0] ?? null;
    if (byYear.length > 1) {
      const byLanguage = byYear.filter((edition) =>
        sharesLanguage(edition.languages, hint.languages),
      );
      if (byLanguage.length === 1) return byLanguage[0] ?? null;
      return null;
    }
  }

  const byLanguage = candidates.filter((edition) =>
    sharesLanguage(edition.languages, hint.languages),
  );
  if (byLanguage.length === 1) return byLanguage[0] ?? null;

  return null;
};
