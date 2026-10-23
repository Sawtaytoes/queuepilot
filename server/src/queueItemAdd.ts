/**
 * Adding one item to a Picks queue: the body of `POST /api/queues/:set/items`, shared with the
 * native TV route so both run the same remote-server check, the same duplicate guard and the
 * same `queues.addItem` write. Parsing the request (a collection name, an empty value) stays
 * with each caller; what is decided here is whether this value may land in this queue.
 */
import { liveClient } from './engine/plex-live.js';
import * as routing from './engine/routing.js';
import { findDuplicateItem } from './entryIdentity.js';
import * as plex from './plex.js';
import { plexServerAccessForProfile, plexServerGet } from './plexSources.js';
import * as queues from './queues.js';
import type { EntryValue } from './types.js';

/** A refusal the caller answers with its own status; anything else is the caller's 500. */
export class QueueAddError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403,
  ) {
    super(message);
    this.name = 'QueueAddError';
  }
}

export interface QueueAddResult {
  added: boolean;
  key: string;
  duplicateOf?: string;
}

export async function addQueueItem(
  set: string,
  value: EntryValue,
  position: 'top' | 'bottom',
  { allowDuplicate = false }: { allowDuplicate?: boolean } = {},
): Promise<QueueAddResult> {
  // `added: false` is what `addItem` already answers for an exact key repeat, so the wire
  // shape is unchanged; `duplicateOf` names the line that made it a repeat. The cfg is the
  // ENGINE's (`routing.loadSets`), because it is the engine's resolver that runs — the
  // registry entry `isQueueSet` reads is the file shape, which is a different object.
  const cfg = routing.loadSets()?.sets[set];
  const mapping = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const remoteServer = mapping?.plex_server ? String(mapping.plex_server) : null;
  if (remoteServer) {
    if (remoteServer === (await plex.machineIdentifier()))
      throw new QueueAddError('Use the home server search for local Plex items', 400);
    if (!cfg || mapping?.ratingKey == null || !/^\d+$/.test(String(mapping.ratingKey)))
      throw new QueueAddError('A shared Plex item needs a valid rating key', 400);
    const scope = await plex.profileScope(cfg.requires_profile || null);
    const access = await plexServerAccessForProfile(scope.account ?? null, remoteServer);
    if (!access) throw new QueueAddError('This queue profile cannot reach that Plex server', 403);
    const metadata = await plexServerGet(access, `/library/metadata/${mapping.ratingKey}`);
    const item = metadata.MediaContainer?.Metadata?.[0];
    if (!item || (item.type !== 'movie' && item.type !== 'show'))
      throw new QueueAddError('That item is not available to this queue profile', 400);
  }
  if (cfg && !allowDuplicate) {
    const dup = await findDuplicateItem(liveClient(), cfg, await queues.listSet(set), value);
    if (dup) return { added: false, key: dup.key, duplicateOf: dup.key };
  }
  return queues.addItem(set, value, position, { allowDuplicate });
}
