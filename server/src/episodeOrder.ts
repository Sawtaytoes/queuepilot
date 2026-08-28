/**
 * The shared episode-selection rule for the API previews and the playback engine.
 *
 * Plex returns Season 0 before Season 1. Regular specials therefore stay out unless the
 * queue names their leaf ids in `included_specials`. A selected special uses its original
 * availability date to find a place among normal episodes when Plex supplies one. A special
 * with no date follows the normal episodes instead of opening the show.
 */

export interface EpisodeOrderItem {
  ratingKey?: string | number | null;
  type?: string;
  extraType?: number | string | null;
  parentIndex?: number | null;
  index?: number | null;
  season?: number | null;
  episode?: number | null;
  duration?: number;
  originallyAvailableAt?: string | null;
}

export interface SpecialSelection {
  /** Legacy all-or-nothing opt-in. Kept readable for existing hand-written sets. */
  include_specials?: unknown;
  /** Regular Season-0 leaf ids this set opts into. */
  included_specials?: readonly unknown[] | null;
}

const S0_EXTRA_INDEX_MIN = 200;
const S0_EXTRA_INDEX_MAX = 399;

export const episodeSeason = (episode: EpisodeOrderItem): number =>
  Number(episode.parentIndex ?? episode.season ?? 0);

const episodeNumber = (episode: EpisodeOrderItem): number =>
  Number(episode.index ?? episode.episode ?? 0);

export function isExtraOrPromoEpisode(
  episode: EpisodeOrderItem | null | undefined,
): boolean {
  if (!episode) return false;
  if (episode.type === 'clip') return true;
  if (episode.extraType != null && episode.extraType !== '') return true;
  const index = episodeNumber(episode);
  return episodeSeason(episode) === 0
    && Number.isFinite(index)
    && index >= S0_EXTRA_INDEX_MIN
    && index <= S0_EXTRA_INDEX_MAX;
}

export const isRegularSpecial = (
  episode: EpisodeOrderItem | null | undefined,
): boolean => Boolean(
  episode
    && episodeSeason(episode) === 0
    && episode.duration
    && !isExtraOrPromoEpisode(episode),
);

const dateMs = (episode: EpisodeOrderItem): number | null => {
  if (!episode.originallyAvailableAt) return null;
  const value = Date.parse(episode.originallyAvailableAt);
  return Number.isFinite(value) ? value : null;
};

/**
 * Return the episodes this set may play, in viewing order.
 *
 * The source order remains authoritative for normal episodes. A selected special with a
 * date lands after the last dated item on or before that date. This makes a same-day special
 * follow the episode it accompanies. An undated special follows the complete normal run.
 */
export function orderedPlayableEpisodes<T extends EpisodeOrderItem>(
  episodes: readonly T[],
  selection: SpecialSelection = {},
): T[] {
  const candidates = episodes.filter(
    (episode) => Boolean(episode.duration) && !isExtraOrPromoEpisode(episode),
  );
  const regular = candidates.filter((episode) => episodeSeason(episode) !== 0);
  const specials = candidates.filter((episode) => episodeSeason(episode) === 0);

  // A specials-only title treats Season 0 as its real run. This preserves the existing OAD
  // exception and does not require a per-leaf opt-in for a title that has no other episodes.
  if (!regular.length) return specials;

  const included = new Set((selection.included_specials || []).map(String));
  const selected = specials.filter(
    (episode) => Boolean(selection.include_specials)
      || included.has(String(episode.ratingKey)),
  );
  const ordered = [...regular];

  for (const special of selected) {
    const specialDate = dateMs(special);
    if (specialDate == null) {
      ordered.push(special);
      continue;
    }

    let insertAt = ordered.length;
    for (let i = 0; i < ordered.length; i += 1) {
      const itemDate = dateMs(ordered[i]!);
      if (itemDate != null && itemDate > specialDate) {
        insertAt = i;
        break;
      }
    }
    ordered.splice(insertAt, 0, special);
  }

  return ordered;
}

/** Apply a manual S/E floor to the viewing-order list, not to Plex's Season-0-first tuple. */
export function episodesAtOrAfterStart<T extends EpisodeOrderItem>(
  episodes: readonly T[],
  start: { season?: unknown; episode?: unknown } | null | undefined,
): T[] {
  if (!start || start.episode == null) return [...episodes];
  const season = Number(start.season ?? 1);
  const episode = Number(start.episode ?? 1);
  const hasRegularEpisodes = episodes.some((item) => episodeSeason(item) !== 0);
  const index = episodes.findIndex((item) => {
    const itemSeason = episodeSeason(item);
    if (hasRegularEpisodes && itemSeason === 0) return false;
    const itemEpisode = episodeNumber(item);
    return itemSeason > season || (itemSeason === season && itemEpisode >= episode);
  });
  return index < 0 ? [] : episodes.slice(index);
}
