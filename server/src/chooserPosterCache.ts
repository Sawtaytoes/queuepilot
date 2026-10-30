import { createHash } from 'node:crypto';
import { chooserPoster } from './chooserPoster.js';
import * as sets from './sets.js';
import { isSetAvailable } from './season.js';
import { providerIdForSet } from './providers/blocks.js';
import type { SetRegistryEntry } from './types.js';

type Image = Awaited<ReturnType<typeof chooserPoster>>;
const images = new Map<string, { image: Image; at: number; generation: string; version: string }>();
const pending = new Map<string, Promise<Image>>();
const generations = new Map<string, string>();
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const generationFor = (set: SetRegistryEntry) => digest(JSON.stringify(set));
/** Cached bytes belong to the effective configuration, never just the queue ID. */
export async function cachedChooserPoster(id: string, isRefresh = false): Promise<Image> {
  const set = await sets.getSet(id);
  if (!set || !isSetAvailable(set) || (set.provider_kind || providerIdForSet({ ...set })) !== 'plex') {
    images.delete(id); generations.delete(id); return null;
  }
  const generation = generationFor(set);
  generations.set(id, generation);
  const entry = images.get(id);
  const cached = entry?.generation === generation ? entry : undefined;
  const key = `${id}:${generation}`;
  if (isRefresh || !cached || Date.now() - cached.at > (cached.image ? 300_000 : 30_000)) {
    if (!pending.has(key)) {
      const request = chooserPoster(id).catch(() => null).then((result) => {
        if (generations.get(id) !== generation) return null;
        const image = result && result.buffer.length <= 512_000 ? result : null;
        if (images.size >= 128 && !images.has(id)) images.delete(images.keys().next().value || '');
        images.set(id, { image, generation, at: Date.now(), version: image ? digest(image.buffer) : 'none' });
        return image;
      }).finally(() => pending.delete(key));
      pending.set(key, request);
    }
  }
  return cached && !isRefresh ? cached.image : pending.get(key)!;
}
/** Both configuration and image generations invalidate display and browser caches. */
export function chooserPosterPath(set: SetRegistryEntry) {
  const generation = generationFor(set);
  const cached = images.get(set.id);
  const version = cached?.generation === generation ? cached.version : 'pending';
  return `/api/chooser/poster/${encodeURIComponent(set.id)}?v=${generation}-${version}`;
}
/** The same seasonal Plex registry drives both the cache manifest and the warmer. */
export async function chooserPosterPaths() {
  const registry = await sets.getRegistry();
  return registry.sets.filter((set) => isSetAvailable(set) && (set.provider_kind || providerIdForSet({ ...set })) === 'plex')
    .map((set) => ({ id: set.id, artworkPath: chooserPosterPath(set) }));
}
/** Warm independently of scans, two provider requests at a time. */
export async function warmChooserPosters() {
  const paths = await chooserPosterPaths();
  await paths.reduce(async (previous, _entry, index) => {
    await previous;
    if (index % 2 === 0) await Promise.all(paths.slice(index, index + 2).map(({ id }) => cachedChooserPoster(id, true)));
  }, Promise.resolve());
  const active = new Set(paths.map(({ id }) => id));
  images.forEach((_image, id) => { if (!active.has(id)) images.delete(id); });
  generations.forEach((_generation, id) => { if (!active.has(id)) generations.delete(id); });
}
