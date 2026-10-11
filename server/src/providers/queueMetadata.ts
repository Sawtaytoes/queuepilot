// One fresh metadata snapshot per lineup. Keep resolution (and its RNG) sequential;
// only the home server's direct rating-key reads are grouped on the wire.
import type { EntryDescriptor } from '../engine/resolve.js';
import type { PlexClient, PlexMetadata } from '../types.js';

const BATCH_SIZE = 50;

export async function queueMetadataClient(
  client: PlexClient,
  entries: readonly Pick<EntryDescriptor, 'ratingKey' | 'plexServer'>[],
  token: string | null | undefined,
): Promise<PlexClient> {
  const keys = [...new Set(entries.filter((entry) => !entry.plexServer)
    .map((entry) => entry.ratingKey).filter((key): key is string => key != null && /^\d+$/.test(key)))];
  if (keys.length < 2) return client;
  const metadata = new Map<string, PlexMetadata>();
  const scope = token ?? null;
  for (let start = 0; start < keys.length; start += BATCH_SIZE) {
    const batch = keys.slice(start, start + BATCH_SIZE);
    const wanted = new Set(batch);
    try {
      const mc = await client.container(`/library/metadata/${batch.join(',')}`, scope);
      const duplicates = new Set<string>();
      for (const row of mc.Metadata || []) {
        const key = String(row.ratingKey);
        if (!wanted.has(key)) continue;
        if (metadata.has(key)) duplicates.add(key);
        metadata.set(key, row);
      }
      // Missing or ambiguous rows retain their original individual read. A failed batch
      // must not turn an accessible entry into an unresolved/finished one.
      for (const key of duplicates) metadata.delete(key);
    } catch {
      // Older servers, incomplete responses and transport failures use the normal path.
    }
  }
  return {
    container(path, readToken = null) {
      const key = path.match(/^\/library\/metadata\/(\d+)$/)?.[1];
      const row = key && readToken === scope ? metadata.get(key) : null;
      return row ? { Metadata: [row], size: 1 } : client.container(path, readToken);
    },
    accountToken: (uuid) => client.accountToken(uuid),
  };
}
