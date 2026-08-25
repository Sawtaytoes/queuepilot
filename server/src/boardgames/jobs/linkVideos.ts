// FIND ONE HOW-TO-PLAY VIDEO PER TITLE.
//
// The fourth nightly step. Writes `board_game_links` rows of kind `howToPlay` with
// `source = 'derived'`.
//
// ⚠️ A TITLE WITH NO TEACH VIDEO GETS AN EXPLICIT EMPTY LIST, not a skip. That is what removes
// a link whose video has been taken down or re-titled. Skipping instead would leave a dead link
// on the card forever, and nobody checks a link that used to work.
//
// The upstream payload is cached per title, for the same reason the enrichment pass caches: a
// nightly that re-fetched a few hundred titles is a few hundred requests a night against a free
// API.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { listLinkableGames } from '../../store/db/boardgameEnrich.js';
import { replaceDerivedLinks } from '../../store/db/boardgameSync.js';
import { cacheDirectory } from '../enrich/cache.js';
import { fetchInstructionalVideos, parseVideos, selectHowToPlayVideo } from '../links/videos.js';
import { failed, type CollectionJobResult, type OnProgress } from './types.js';

const REQUEST_INTERVAL_MS = 1_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface LinkVideosOptions {
  limit?: number;
  isForced?: boolean;
  isDryRun?: boolean;
}

export async function runLinkVideos(
  { limit = Number.POSITIVE_INFINITY, isForced = false, isDryRun = false }: LinkVideosOptions = {},
  onProgress: OnProgress = () => {},
): Promise<CollectionJobResult> {
  try {
    const cache = cacheDirectory('geekdo-videos');
    mkdirSync(cache, { recursive: true });

    const games = listLinkableGames().filter(
      (game): game is { id: string; name: string; bggId: number } => game.bggId !== null,
    );
    const pending = games.slice(0, Number.isFinite(limit) ? limit : games.length);
    onProgress(`checking ${pending.length} of ${games.length} title(s) for a teach video`);

    let fetched = 0;
    let cached = 0;
    let linked = 0;
    let cleared = 0;
    let failures = 0;

    for (const game of pending) {
      let payload: unknown;
      const cachePath = join(cache, `${game.bggId}.json`);
      try {
        if (existsSync(cachePath) && !isForced) {
          payload = JSON.parse(readFileSync(cachePath, 'utf8'));
          cached += 1;
        } else {
          payload = await fetchInstructionalVideos(game.bggId);
          await writeFile(cachePath, JSON.stringify(payload));
          fetched += 1;
          await sleep(REQUEST_INTERVAL_MS);
        }
      } catch (error) {
        // One title failing is not the run failing.
        onProgress(`  ✗ ${game.name}: ${error instanceof Error ? error.message : String(error)}`);
        failures += 1;
        continue;
      }

      const chosen = selectHowToPlayVideo(parseVideos(payload));
      if (isDryRun) {
        if (chosen) linked += 1;
        else cleared += 1;
        continue;
      }

      if (chosen) {
        replaceDerivedLinks(game.id, 'howToPlay', [{ label: chosen.label, url: chosen.url }]);
        linked += 1;
      } else {
        // The explicit clear. See the file header — this is the line that removes a dead link.
        replaceDerivedLinks(game.id, 'howToPlay', []);
        cleared += 1;
      }
    }

    return {
      counts: { cached, cleared, failures, fetched, linked },
      isOk: true,
      isSkipped: false,
      name: 'link-videos',
      summary:
        `${linked} title(s) with a teach video, ${cleared} without, ${failures} failed` +
        (isDryRun ? ' — DRY RUN, nothing written' : ''),
    };
  } catch (error) {
    return failed('link-videos', error);
  }
}
