import * as routing from './engine/routing.js';
import { providerFor } from './providers/index.js';
import { providerIdForSet } from './providers/blocks.js';
import { wireKindForSet } from './kind.js';
import { isSetAvailable } from './season.js';
import * as sets from './sets.js';
import * as plex from './plex.js';
import { plexServerAccessForProfile, plexServerThumb, plexServerGet } from './plexSources.js';

/** Read-only lineup sample: never materialize, persist completion, or start playback.
 * Random queues choose again at playback; artwork is a preview, never a reservation.
 * On-demand image requests keep scans independent of provider latency.
 */
export async function chooserPoster(setId: string) {
  const set = await sets.getSet(setId);
  const cfg = routing.loadSets()?.sets[setId];
  if (!set || !cfg || !isSetAvailable(set)) return null;
  const provider = providerFor(providerIdForSet({ ...cfg }));
  if (provider.kind !== 'plex') return null;
  const profile = cfg.requires_profile || '';
  let binding = routing.bindingFor(cfg, profile);
  if (provider.profileBinding) binding = await provider.profileBinding(binding, profile);
  if (!provider.profileToken) return null;
  const token = await provider.profileToken(binding.user_uuid);
  if (!token) return null;
  const result = await provider.buckets({ setName: setId, cfg, binding, token, kind: wireKindForSet(cfg) });
  const first = result.play[0];
  if (!first || !('ratingKey' in first)) return null;
  // Shared-server keys are not interchangeable with home-server keys. Keep their
  // existing profile-scoped poster proxy rather than fetching unrelated local art.
  if (first.plexServer) {
    const user = await plex.profileUser(profile);
    if (!user) return null;
    const access = await plexServerAccessForProfile(user.uuid, first.plexServer);
    if (!access) return null;
    const data = await plexServerGet(access, `/library/metadata/${encodeURIComponent(String(first.ratingKey))}`);
    const metadata = data.MediaContainer?.Metadata?.[0];
    const key = metadata?.type === 'episode' ? metadata.grandparentRatingKey || metadata.parentRatingKey || first.ratingKey : first.ratingKey;
    return plexServerThumb(access, String(key));
  }
  const data = await plex.plexGet(`/library/metadata/${encodeURIComponent(String(first.ratingKey))}`) as {
    MediaContainer?: { Metadata?: { grandparentRatingKey?: string; parentRatingKey?: string; type?: string }[] };
  };
  const metadata = data.MediaContainer?.Metadata?.[0];
  const key = metadata?.type === 'episode' ? metadata.grandparentRatingKey || metadata.parentRatingKey || first.ratingKey : first.ratingKey;
  return plex.thumb(String(key));
}
