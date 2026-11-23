import { isSupersededTier } from "../../shared/queueTitle.js"
import type { ChooserQueue } from "./chooser.js"
import { chooserPosterPath } from "./chooserPosterCache.js"
import { wireKindForSet } from "./kind.js"
import {
  nativeAudience,
  nativeQueueTitles,
} from "./nativeTv.js"
import { providerIdForSet } from "./providers/blocks.js"
import { queueMatchesSelection } from "./queuePeople.js"
import { isSetAvailable } from "./season.js"
import * as sets from "./sets.js"
import { listPeople } from "./store/db/people.js"
import { photoVersionsByPerson } from "./store/db/personPhotos.js"
import { membersByQueue } from "./store/db/queuePeople.js"

/** The display chooser shares the TV/web audience, availability, and title rules. */
export const chooserCatalog = async (
  selected: string[],
): Promise<ChooserQueue[]> => {
  const registry = await sets.getRegistry()
  const audiences = membersByQueue()
  const titles = await nativeQueueTitles()
  return registry.sets
    .filter(
      (set) =>
        (set.provider_kind ||
          providerIdForSet({ ...set })) === "plex" &&
        isSetAvailable(set) &&
        !isSupersededTier(set) &&
        queueMatchesSelection(
          nativeAudience(
            audiences.get(set.filtered_from || set.id) ??
              [],
          ),
          selected,
        ),
    )
    .map((set) => {
      const profile = chooserProfile(set)
      return {
        artworkPath: chooserPosterPath(set),
        id: set.id,
        title: titles.get(set.id) ?? set.id,
        kind: wireKindForSet(set),
        ...(profile ? { profile } : {}),
      }
    })
}

/**
 * The Plex profile a chooser tap must play as. A rotation channel is ungated on disk and
 * names its account only through its default binding, so a tap that sent no profile played
 * on whoever was signed in and the account audit then stopped it. A tap names the profile
 * the same way a direct card does, which makes the scan switch the TV and wait for it.
 * Only a rotation binding counts: routing plays an ungated queue set as the owner and
 * ignores a hand-written top-level `plex_user` there.
 */
const chooserProfile = (set: {
  requires_profile?: string | null
  plex_user?: string | null
  source?: string
}): string | null =>
  set.requires_profile ||
  (set.source === "rotation" ? set.plex_user : null) ||
  null
/** IDs come from the caller's explicit card binding, never a guessed name match. */
export const chooserPerson = (id: string) => {
  const person = listPeople().find(
    (entry) => entry.id === id,
  )
  if (!person) return undefined
  const version = photoVersionsByPerson().get(person.id)
  return {
    id: person.id,
    name: person.displayName,
    ...(version
      ? {
          artworkPath: `/api/people/${encodeURIComponent(person.id)}/photo?v=${encodeURIComponent(version)}`,
        }
      : {}),
  }
}
