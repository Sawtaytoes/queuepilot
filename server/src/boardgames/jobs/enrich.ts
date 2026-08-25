// FILL IN WHAT A COLLECTION EXPORT CANNOT CARRY: mechanics, categories, publishers and box art.
//
// The second nightly step. It only ever writes the IMPORTED layer, so a tag somebody applied
// lives in `board_game_overrides`, is merged on read, and cannot be walked over from here.
//
// ── The cache is the point, not an optimisation ──────────────────────────────────────────
//
// Every upstream item is written to `<config>/board-game-cache/geekdo/<id>.json` and read back
// on the next run. A nightly that re-fetched a few hundred items would be a few hundred
// requests a night against a free API that has turned access off before. `force` bypasses the
// read, and that is for a human at a terminal, not for the schedule.
//
// ── The art is stored, never hotlinked ───────────────────────────────────────────────────
//
// `storeSquareImage` writes a padded 1:1 webp beside the book of record. The padding is what
// makes the tile's `object-cover` a no-op — a box is not a uniform trim like a film poster, and
// centre-cropping a wide one loses the title off both edges.
import {
  boxBggIdsFor,
  editionHintFor,
  listEnrichableGames,
  writeCoverPath,
  writeEnrichment,
} from '../../store/db/boardgameEnrich.js';
import { cacheDirectory } from '../enrich/cache.js';
import { deriveInteractionTypes, fetchGeekdoItem, parseGeekdoItem } from '../enrich/geekdo.js';
import { storeSquareImage } from '../enrich/images.js';
import { matchEdition } from '../enrich/matchEdition.js';
import { failed, type CollectionJobResult, type OnProgress } from './types.js';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Between two uncached fetches. The upstream is free and unauthenticated; do not hammer it. */
const REQUEST_INTERVAL_MS = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface EnrichOptions {
  /** Stop after this many titles. For a human trying the job out. */
  limit?: number;
  /** Re-fetch even when the cache has an answer. */
  isForced?: boolean;
}

export async function runEnrich(
  { limit = Number.POSITIVE_INFINITY, isForced = false }: EnrichOptions = {},
  onProgress: OnProgress = () => {},
): Promise<CollectionJobResult> {
  try {
    const itemCache = cacheDirectory('geekdo');
    const versionCache = cacheDirectory('geekdo-versions');
    mkdirSync(itemCache, { recursive: true });
    mkdirSync(versionCache, { recursive: true });

    const games = listEnrichableGames();
    const pending = games.slice(0, Number.isFinite(limit) ? limit : games.length);
    onProgress(`enriching ${pending.length} of ${games.length} title(s)`);

    const loadJson = async (
      directory: string,
      id: number,
      fetchPayload: () => Promise<unknown>,
    ): Promise<{ payload: unknown; fromCache: boolean }> => {
      const cachePath = join(directory, `${id}.json`);
      if (existsSync(cachePath) && !isForced) {
        return { fromCache: true, payload: JSON.parse(readFileSync(cachePath, 'utf8')) };
      }
      const payload = await fetchPayload();
      await writeFile(cachePath, JSON.stringify(payload));
      await sleep(REQUEST_INTERVAL_MS);
      return { fromCache: false, payload };
    };

    let fetched = 0;
    let cached = 0;
    let withArt = 0;
    let matchedEdition = 0;
    let failures = 0;

    for (const game of pending) {
      let payload: unknown;
      try {
        const loaded = await loadJson(itemCache, game.bggId, () => fetchGeekdoItem(game.bggId));
        payload = loaded.payload;
        if (loaded.fromCache) cached += 1;
        else fetched += 1;
      } catch (error) {
        // One title failing is not the run failing — a nightly that stops at the first 500
        // leaves the rest of the collection unenriched until somebody notices.
        onProgress(`  ✗ ${game.name}: ${error instanceof Error ? error.message : String(error)}`);
        failures += 1;
        continue;
      }

      const item = parseGeekdoItem(payload);
      if (!item) {
        onProgress(`  ✗ ${game.name}: unrecognised payload`);
        failures += 1;
        continue;
      }

      writeEnrichment({
        // The upstream's categories and mechanics are one palette to the picker; the owner's
        // own vocabulary is rows in `board_game_category_members` and is untouched by this.
        categories: [...new Set([...item.categories, ...item.mechanics])],
        gameId: game.id,
        interactionTypes: deriveInteractionTypes({
          categories: item.categories,
          maxPlayers: item.maxPlayers,
          mechanics: item.mechanics,
          minPlayers: item.minPlayers,
        }),
        maxPlaytime: item.maxPlaytime,
        minAge: item.minAge,
        minPlaytime: item.minPlaytime,
        publishers: item.publishers,
      });

      // ── the cover ──
      //
      // A FAMILY LISTING IS NOT AN OWNED BOX. When the title's own upstream id is not any box's
      // id, it is a franchise listing, and matching a box's edition against it picks the art
      // for a different game entirely. That check is the difference between the right cover and
      // a confidently wrong one.
      const ownedBggIds = boxBggIdsFor(game.id);
      const isListingOnly = !ownedBggIds.has(game.bggId);
      const hint = editionHintFor(game.id);

      const matched = isListingOnly
        ? null
        : matchEdition(
            { languages: hint.languages, nickname: hint.nickname, year: hint.year },
            item.versions,
          );

      let imageUrl = item.imageUrl;
      let usedEdition = false;

      if (matched) {
        try {
          const loaded = await loadJson(versionCache, matched.id, () =>
            fetchGeekdoItem(matched.id, 'version'),
          );
          if (loaded.fromCache) cached += 1;
          else fetched += 1;
          const versionItem = parseGeekdoItem(loaded.payload);
          if (versionItem?.imageUrl) {
            imageUrl = versionItem.imageUrl;
            usedEdition = true;
          }
        } catch (error) {
          onProgress(
            `  ✗ ${game.name} edition: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (imageUrl) {
        try {
          const stored = await storeSquareImage(imageUrl);
          writeCoverPath(game.id, game.bggId, stored.path);
          withArt += 1;
          if (usedEdition) matchedEdition += 1;
        } catch (error) {
          onProgress(
            `  ✗ ${game.name} art: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    return {
      counts: { cached, editionArt: matchedEdition, failures, fetched, withArt },
      isOk: true,
      isSkipped: false,
      name: 'enrich',
      summary:
        `${pending.length} title(s): ${fetched} fetched, ${cached} from cache, ` +
        `${withArt} with art (${matchedEdition} edition-matched), ${failures} failed`,
    };
  } catch (error) {
    return failed('enrich', error);
  }
}
