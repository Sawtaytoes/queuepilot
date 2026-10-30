import { nativeAudience, nativeQueueTitles } from './nativeTv.js';
import { membersByQueue } from './store/db/queuePeople.js';
import { listPeople } from './store/db/people.js';
import { photoVersionsByPerson } from './store/db/personPhotos.js';
import { queueMatchesSelection } from './queuePeople.js';
import { isSupersededTier } from '../../shared/queueTitle.js';
import { providerIdForSet } from './providers/blocks.js';
import { isSetAvailable } from './season.js';
import { wireKindForSet } from './kind.js';
import * as sets from './sets.js';
import type { ChooserQueue } from './chooser.js';

/** The display chooser shares the TV/web audience, availability, and title rules. */
export const chooserCatalog = async (selected: string[]): Promise<ChooserQueue[]> => {
  const registry = await sets.getRegistry();
  const audiences = membersByQueue();
  const titles = await nativeQueueTitles();
  return registry.sets.filter((set) =>
    (set.provider_kind || providerIdForSet({ ...set })) === 'plex'
    && isSetAvailable(set) && !isSupersededTier(set)
    && queueMatchesSelection(nativeAudience(audiences.get(set.filtered_from || set.id) ?? []), selected),
  ).map((set) => ({
    artworkPath: `/api/chooser/poster/${encodeURIComponent(set.id)}`,
    id: set.id, title: titles.get(set.id) ?? set.id, kind: wireKindForSet(set),
    ...(set.requires_profile ? { profile: set.requires_profile } : {}),
  }));
};
/** IDs come from the caller's explicit card binding, never a guessed name match. */
export const chooserPerson = (id: string) => {
  const person = listPeople().find((entry) => entry.id === id);
  if (!person) return undefined;
  const version = photoVersionsByPerson().get(person.id);
  return {
    id: person.id,
    name: person.displayName,
    ...(version ? { artworkPath: `/api/people/${encodeURIComponent(person.id)}/photo?v=${encodeURIComponent(version)}` } : {}),
  };
};
