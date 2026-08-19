// The on-disk cache for MiSTer box art.
//
// Every other provider's art is on the LAN — Plex, Kavita and the picker are all one hop
// away, so re-fetching a poster costs nothing and none of them caches. This is the first
// provider whose art comes from the PUBLIC INTERNET, at roughly 300 KB a tile, so the same
// "just fetch it" would put a megabyte on the wire every time a queue is opened cold.
//
// The cover route's `Cache-Control: public, max-age=86400` only ever helped ONE browser. A
// second device, a hard refresh, or a container restart went straight back out to the
// archive.
//
// MISSES ARE CACHED TOO, and that is the half that actually matters. A hit costs one request
// forever; a miss costs THREE (boxart, then title, then snap) on every single render, and
// the games with no art are exactly the ones that will never grow any. A miss is remembered
// for a week rather than forever, so art added to the archive later still turns up.
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { CACHE_PATH } from '../env.js';

/** How long a "there is no art for this" answer is trusted. */
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Beside the SQLite cache, because it is the same kind of thing: derived, and safe to lose. */
export const boxartCacheDir = (): string => path.join(path.dirname(CACHE_PATH), 'boxart');

/**
 * A filesystem-safe key.
 *
 * Hashed rather than sanitized because a No-Intro name carries characters a filename cannot
 * portably hold (the `:` in "Sonic 3: …", 200-character titles, leading dots), and every
 * sanitizer eventually collapses two different games onto one key.
 */
const keyFor = (system: string, title: string): string => (
  createHash('sha1').update(`${system} ${title}`).digest('hex')
);

/** The cached bytes, or null when this game is not cached. */
export async function readCachedArt(system: string, title: string): Promise<Buffer | null> {
  try {
    const buf = await fsp.readFile(path.join(boxartCacheDir(), `${keyFor(system, title)}.png`));
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

/** True when this game is known to have no art, and that answer is still fresh. */
export async function isCachedMiss(system: string, title: string): Promise<boolean> {
  try {
    const st = await fsp.stat(path.join(boxartCacheDir(), `${keyFor(system, title)}.miss`));
    return Date.now() - st.mtimeMs < MISS_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * Remember one answer. A null buffer records a MISS.
 *
 * Never throws: a cache that cannot be written is a slower app, not a broken one — the
 * container may be running with a read-only config mount, and a queue must still draw.
 *
 * Deliberately NOT covered by a gate: `CACHE_PATH` is read at import like every other knob
 * in this app, so a test cannot re-point the cache at an unwritable path after the fact. The
 * `catch` is the guarantee; pretending to exercise it would have been a test that passes for
 * the wrong reason.
 */
export async function writeCachedArt(
  system: string,
  title: string,
  buffer: Buffer | null,
): Promise<void> {
  const dir = boxartCacheDir();
  try {
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${keyFor(system, title)}${buffer ? '.png' : '.miss'}`);
    // Write-then-rename, so a crash mid-write cannot leave a truncated PNG to be served
    // forever afterwards as a corrupt poster.
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, buffer ?? Buffer.alloc(0));
    await fsp.rename(tmp, file);
  } catch {
    // Deliberately silent — see this function's note.
  }
}
