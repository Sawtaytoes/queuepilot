import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import sharp from 'sharp';

import { QUEUES_PATH } from '../../config.js';

/**
 * Box art, cached and squared locally.
 *
 * Never hotlinked: BGG has already demonstrated it will turn access off, and the picker has to
 * work when the internet does not. Two settled reasons for the square:
 *
 *  - The tile's `<img>` is hardcoded `object-cover`, and board game boxes are not a uniform
 *    trim like a film poster — a wide box centre-cropped loses the title off both edges.
 *    Padding to 1:1 here makes `object-cover` a no-op.
 *  - A locally-supplied photograph can be any aspect ratio at all.
 */

/**
 * Resolved from the CONFIG directory, not from a repo root.
 *
 * The source app resolved this against its repo root because `yarn workspace … run` sets the
 * cwd to the package directory, and a bare relative path put the art under the package while
 * the server looked for it at the root — no error, just a page of broken images. This server
 * ships as a single bundled file and has no repo root at runtime, so the same class of bug is
 * avoided the other way: everything durable hangs off `QUEUES_PATH`'s directory.
 */
export const imagesDirectory = (): string =>
  process.env.BOARD_GAME_IMAGES_PATH || join(dirname(QUEUES_PATH), 'board-game-images');

export interface StoredImage {
  /**
   * Served path, e.g. `/images/ab12cd34-600.webp`.
   *
   * The `/images/` prefix is KEPT EXACTLY as the source app wrote it, even though this app
   * serves the files at `/api/board-games/images/<file>`. The reader does `basename()` on the
   * stored string, so the prefix is irrelevant to it — and every row already in the database
   * carries this shape. Changing it would make new rows differ from old ones for no gain.
   */
  path: string;
  bytes: number;
}

const SIZES = [600, 200] as const;

const hashKey = (key: string): string =>
  createHash('sha256').update(key).digest('hex').slice(0, 16);

/** Where `storeSquareImage(url)` will put the 600px file. */
export const storedPathForUrl = (sourceUrl: string): string =>
  `/images/${hashKey(sourceUrl)}-${SIZES[0]}.webp`;

export const storeSquareImageFromBuffer = async (
  source: Buffer,
  cacheKey: string,
): Promise<StoredImage> => {
  const directory = imagesDirectory();
  mkdirSync(directory, { recursive: true });

  const hash = hashKey(cacheKey);
  const primary = `${hash}-${SIZES[0]}.webp`;

  if (existsSync(join(directory, primary))) {
    return { path: `/images/${primary}`, bytes: 0 };
  }

  let bytes = 0;

  for (const size of SIZES) {
    const output = await sharp(source)
      .resize(size, size, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality: 82 })
      .toBuffer();

    await writeFile(join(directory, `${hash}-${size}.webp`), output);
    bytes += output.byteLength;
  }

  return { path: `/images/${primary}`, bytes };
};

export const storeSquareImage = async (sourceUrl: string): Promise<StoredImage> => {
  const hash = hashKey(sourceUrl);
  const directory = imagesDirectory();
  mkdirSync(directory, { recursive: true });
  const primary = `${hash}-${SIZES[0]}.webp`;

  if (existsSync(join(directory, primary))) {
    return { path: `/images/${primary}`, bytes: 0 };
  }

  const response = await fetch(sourceUrl, {
    headers: {
      'user-agent': 'board-game-picker/0.1 (self-hosted collection picker)',
    },
  });

  if (!response.ok) {
    throw new Error(`image → HTTP ${response.status}`);
  }

  return storeSquareImageFromBuffer(Buffer.from(await response.arrayBuffer()), sourceUrl);
};
