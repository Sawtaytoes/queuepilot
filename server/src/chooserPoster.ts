import * as routing from "./engine/routing.js"
import { passesFilter } from "./filteredQueues.js"
import { wireKindForSet } from "./kind.js"
import * as plex from "./plex.js"
import {
  type PlexServerAccess,
  plexServerAccessForProfile,
  plexServerGet,
  plexServerThumb,
} from "./plexSources.js"
import { providerIdForSet } from "./providers/blocks.js"
import { providerFor } from "./providers/index.js"
import { pullLineup } from "./providers/pullLineup.js"
import * as queues from "./queues.js"
import { isSetAvailable } from "./season.js"
import * as sets from "./sets.js"
import type {
  EngineBinding,
  PlayItem,
  Provider,
  ProviderCover,
  RoutingSetCfg,
  SetRegistryEntry,
} from "./types.js"

/** The largest image the chooser keeps. The cache holds up to 128 of them. */
export const CHOOSER_POSTER_MAX_BYTES = 512_000
type PosterImage = ProviderCover
type Candidate = {
  /** The id the provider's art is read by: a Plex ratingKey, a Kavita series, a game id. */
  id: string
  /** A shared Plex server's machine id; absent on the home server and other providers. */
  plexServer?: string
}
/** A candidate whose picture this search already asked for (another episode of one show). */
const REPEAT = Symbol("repeat")
type Art = PosterImage | null | typeof REPEAT

const isUsable = (
  image: Art | undefined,
): image is PosterImage =>
  Boolean(
    image &&
      image !== REPEAT &&
      image.buffer.length > 0 &&
      image.buffer.length <= CHOOSER_POSTER_MAX_BYTES,
  )

const candidateKey = ({ id, plexServer }: Candidate) =>
  `${plexServer ?? ""}:${id}`

/**
 * The first candidate with usable art, in order. Every search starts at the lineup head and
 * walks to the end of the queue, one request at a time, so null means NO candidate has art.
 * A candidate that fails, has no art, or is too large to keep moves on to the next; a
 * candidate is never asked twice. The work is proportional to the artless prefix, which is
 * one request for nearly every queue.
 */
async function firstArt(
  candidates: Candidate[],
  artFor: (candidate: Candidate) => Promise<Art>,
): Promise<PosterImage | null> {
  const seen = new Set<string>()
  const unique = candidates.filter((candidate) => {
    const key = candidateKey(candidate)
    if (!candidate.id || seen.has(key)) return false
    seen.add(key)
    return true
  })
  // No cap: the list is the lineup plus the stored entries, both finite, and stopping
  // early would answer "no art" for a queue that has some.
  for (const candidate of unique) {
    const art = await artFor(candidate).catch(() => null)
    if (isUsable(art)) return art
  }
  return null
}

/** The item a pull provider's cover is read by. Each kind names its id differently. */
export function pullItemId(item: PlayItem): string | null {
  if ("seriesId" in item) return String(item.seriesId)
  if ("gameId" in item) return item.gameId
  if ("appid" in item) return item.appid
  if ("path" in item) return item.path
  return null
}

/**
 * The rest of the queue, after its lineup: every stored entry with an id, in file order,
 * finished ones included — a finished item still has a picture. A pull provider's id is
 * stored in `ratingKey` too. A FILTERED queue's entries are its parent's; the caller narrows
 * them (see `pullPoster`).
 */
async function storedCandidates(
  setId: string,
): Promise<(Candidate & { isDone: boolean })[]> {
  const rows = await queues.listSet(setId).catch(() => [])
  return rows.flatMap((row) => {
    const { ratingKey, extras } = queues.splitEntry(
      row.value,
    )
    if (ratingKey == null || ratingKey === "") return []
    const server = extras.plex_server
    return [
      {
        id: String(ratingKey),
        isDone: row.done === true,
        ...(typeof server === "string" && server
          ? { plexServer: server }
          : {}),
      },
    ]
  })
}

/** Plex: an episode shows its SHOW's poster; anything else shows its own. */
const posterKeyOf = (
  ratingKey: string,
  metadata:
    | {
        grandparentRatingKey?: string | number
        parentRatingKey?: string | number
        type?: string
      }
    | undefined,
) =>
  String(
    metadata?.type === "episode"
      ? metadata.grandparentRatingKey ||
          metadata.parentRatingKey ||
          ratingKey
      : ratingKey,
  )

async function plexPoster(
  setId: string,
  cfg: RoutingSetCfg,
  provider: Provider,
): Promise<PosterImage | null> {
  const profile = cfg.requires_profile || ""
  let binding: EngineBinding = routing.bindingFor(
    cfg,
    profile,
  )
  if (provider.profileBinding)
    binding = await provider.profileBinding(
      binding,
      profile,
    )
  if (!provider.profileToken) return null
  const token = await provider.profileToken(
    binding.user_uuid,
  )
  // A managed profile without its own token never falls back to the owner's.
  if (binding.user_uuid && !token) return null
  const result = await provider
    .buckets({
      setName: setId,
      cfg,
      binding,
      token,
      kind: wireKindForSet(cfg),
    })
    .catch(() => ({ play: [] as PlayItem[] }))
  const lineup = result.play.flatMap((item): Candidate[] =>
    "ratingKey" in item
      ? [
          {
            id: String(item.ratingKey),
            ...(item.plexServer
              ? { plexServer: item.plexServer }
              : {}),
          },
        ]
      : [],
  )
  // Shared-server keys are not interchangeable with home-server keys. Each server is reached
  // through the QUEUE PROFILE's own grant, looked up once per server.
  const servers = new Map<
    string,
    Promise<PlexServerAccess | null>
  >()
  const accessFor = (server: string) => {
    const known = servers.get(server)
    if (known) return known
    const access = plex
      .profileUser(profile)
      .then((user) =>
        user
          ? plexServerAccessForProfile(user.uuid, server)
          : null,
      )
      .catch(() => null)
    servers.set(server, access)
    return access
  }
  // Eight episodes of one show are one picture: asking for it again is not a new attempt.
  const askedPosters = new Set<string>()
  const isRepeat = (server: string, key: string) => {
    const asked = `${server}:${key}`
    if (askedPosters.has(asked)) return true
    askedPosters.add(asked)
    return false
  }
  const artFor = async ({
    id,
    plexServer,
  }: Candidate): Promise<Art> => {
    if (plexServer) {
      const access = await accessFor(plexServer)
      if (!access) return null
      const data = await plexServerGet(
        access,
        `/library/metadata/${encodeURIComponent(id)}`,
      )
      const key = posterKeyOf(
        id,
        data.MediaContainer?.Metadata?.[0],
      )
      if (isRepeat(plexServer, key)) return REPEAT
      return plexServerThumb(access, key, fetch, {
        format: "jpeg",
      })
    }
    const data = (await plex.plexGet(
      `/library/metadata/${encodeURIComponent(id)}`,
    )) as {
      MediaContainer?: {
        Metadata?: {
          grandparentRatingKey?: string
          parentRatingKey?: string
          type?: string
        }[]
      }
    }
    const key = posterKeyOf(
      id,
      data.MediaContainer?.Metadata?.[0],
    )
    if (isRepeat("", key)) return REPEAT
    return plex.thumb(key, { format: "jpeg" })
  }
  // A filtered Plex queue is not narrowed anywhere in the engine (see `filteredQueues.ts`),
  // so its lineup and its items are its parent's, and so is its art.
  return firstArt(
    [...lineup, ...(await storedCandidates(setId))],
    artFor,
  )
}

/** Kavita, board games, Steam, MiSTer: the provider's own cover for each item. */
async function pullPoster(
  set: SetRegistryEntry,
  cfg: RoutingSetCfg,
  provider: Provider,
): Promise<PosterImage | null> {
  const cover = provider.cover?.bind(provider)
  if (!cover) return null
  const stored = await storedCandidates(set.id)
  const storedIds = new Set(stored.map(({ id }) => id))
  // A CURATED queue's art comes only from its own entries. When every entry is finished the
  // provider would answer from the whole library shelf (Kavita does), so the lineup is not
  // even built; a queue with no entries is rule-based and its shelf IS its queue.
  const isCurated = stored.length > 0
  const lineup =
    isCurated && stored.every(({ isDone }) => isDone)
      ? []
      : await pullLineup(set.id, cfg, provider, {
          isReadOnly: true,
        }).catch(() => [] as PlayItem[])
  const lineupIds = lineup.flatMap((item) => {
    const id = pullItemId(item)
    return id && (!isCurated || storedIds.has(id))
      ? [id]
      : []
  })
  return firstArt(
    [
      ...lineupIds,
      ...(await narrowed(set, provider, stored)),
    ].map((id) => ({ id })),
    ({ id }) => cover(id),
  )
}

/**
 * A filtered queue's stored entries, narrowed by its filter the way its page narrows them:
 * by the library each item's tile reports (`passesFilter`; an item whose library cannot be
 * read is kept, as on the page). An ordinary queue's entries pass unchanged.
 */
async function narrowed(
  set: SetRegistryEntry,
  provider: Provider,
  stored: Candidate[],
): Promise<string[]> {
  const ids = stored.map(({ id }) => id)
  if (!set.filtered_from || !set.filter?.libraries.length)
    return ids
  if (typeof provider.tiles !== "function") return []
  const rows = await provider.tiles(ids).catch(() => null)
  if (!rows) return []
  return ids.filter((_id, index) =>
    passesFilter(set.filter, {
      libraryId: rows[index]?.libraryId ?? null,
    }),
  )
}

/** Read-only lineup sample: never materialize, persist completion, or start playback.
 * Random queues choose again at playback; artwork is a preview, never a reservation.
 * The lineup head's art comes first, then the rest of the lineup, then the rest of the
 * queue, each through the queue's own provider. Null only when none of them has art.
 * On-demand image requests keep scans independent of provider latency.
 */
export async function chooserPoster(
  setId: string,
): Promise<PosterImage | null> {
  const set = await sets.getSet(setId)
  const cfg = routing.loadSets()?.sets[setId]
  if (!set || !cfg || !isSetAvailable(set)) return null
  const provider = providerFor(providerIdForSet({ ...cfg }))
  return provider.kind === "plex"
    ? plexPoster(setId, cfg, provider)
    : pullPoster(set, cfg, provider)
}
