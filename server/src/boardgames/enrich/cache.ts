import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { QUEUES_PATH } from '../../config.js';

/**
 * On-disk caches for other people's servers.
 *
 * Every cache the board-game enrichment keeps is a sibling directory under ONE root, so a
 * redeploy that moves the root moves all of them together: `geekdo` (the item payloads),
 * `geekdo-versions`, `geekdo-videos`, `geekdo-images`, `bgg-versions` and `art-previews`.
 *
 * `BOARD_GAME_CACHE_PATH` is that ROOT. In the source app the equivalent variable pointed at
 * the geekdo-*item* directory and the siblings were computed from its parent; that indirection
 * only existed because a cron job had already pinned the item directory. Here the root is
 * named directly, and `geekdoCacheDirectory()` is derived from it — the on-disk layout is
 * identical either way.
 *
 * The default hangs off the config directory rather than a repo root. This server ships as a
 * single bundled file and has no repo root at runtime; `QUEUES_PATH`'s directory is what
 * every other durable path in this app is resolved against.
 */
export const boardGameCacheDirectory = (): string =>
  process.env.BOARD_GAME_CACHE_PATH || join(dirname(QUEUES_PATH), 'board-game-cache');

/** The geekdo *item* cache. Does not create the directory — `cacheDirectory` is what does. */
export const geekdoCacheDirectory = (): string => join(boardGameCacheDirectory(), 'geekdo');

export const cacheDirectory = (name: string): string => {
  const directory = join(boardGameCacheDirectory(), name);
  mkdirSync(directory, { recursive: true });
  return directory;
};
