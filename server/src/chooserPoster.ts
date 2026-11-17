import * as routing from "./engine/routing.js"
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
import {
  curatedEntries,
  pullLineup,
} from "./providers/pullLineup.js"
import * as queues from "./queues.js"
import { isSetAvailable } from "./season.js"
import * as sets from "./sets.js"
import type {
  EngineBinding,
  PlayItem,
  Provider,
  ProviderCover,
  RoutingSetCfg,
} from "./types.js"

/** The largest image the chooser keeps. The cache holds up to 128 of them. */
export const CHOOSER_POSTER_MAX_BYTES = 512_000
/** Items that may be ASKED for art before the queue is called artless. Bounds warm-up work. */
const MAX_ART_ATTEMPTS = 8

type PosterImage = ProviderCover
type Candidate = {
  /** The id the provider's art is read by: a Plex ratingKey, a Kavita series, a game id. */
  id: string
  /** A shared Plex server's machine id; absent on the home server and other providers. */
  plexServer?: string
}

const isUsable = (
  image: PosterImage | null | undefined,
): image is PosterImage =>
  Boolean(
    image &&
      image.buffer.length > 0 &&
      image.buffer.length <= CHOOSER_POSTER_MAX_BYTES,
  )

const candidateKey = ({ id, plexServer }: Candidate) =>
  `${plexServer ?? ""}:${id}`

/**
 * The first candidate with usable art, in order, never asking more than
 * `MAX_ART_ATTEMPTS` of them. A candidate that fails, has no art, or is too large to keep
 * moves on to the next; one bad item never leaves the queue artless.
 */
async function firstArt(
  candidates: Candidate[],
  artFor: (
    candidate: Candidate,
  ) => Promise<PosterImage | null>,
): Promise<PosterImage | null> {
  const seen = new Set<string>()
  const unique = candidates.filter((candidate) => {
    const key = candidateKey(candidate)
    if (!candidate.id || seen.has(key)) return false
    seen.add(key)
    return true
  })
  for (const candidate of unique.slice(
    0,
    MAX_ART_ATTEMPTS,
  )) {
    const image = await artFor(candidate).catch(() => null)
    if (isUsable(image)) return image
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
 * The rest of the queue, after its lineup: every stored entry with an id, in file order.
 * A FILTERED queue reads its parent's entries and cannot tell here which of them its filter
 * keeps, so it offers none rather than another queue's art.
 */
async function queueEntryCandidates(
  setId: string,
  cfg: RoutingSetCfg,
): Promise<Candidate[]> {
  if (cfg.filtered_from) return []
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
  const artFor = async ({
    id,
    plexServer,
  }: Candidate): Promise<PosterImage | null> => {
    if (plexServer) {
      const access = await accessFor(plexServer)
      if (!access) return null
      const data = await plexServerGet(
        access,
        `/library/metadata/${encodeURIComponent(id)}`,
      )
      return plexServerThumb(
        access,
        posterKeyOf(id, data.MediaContainer?.Metadata?.[0]),
        fetch,
        { format: "jpeg" },
      )
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
    return plex.thumb(
      posterKeyOf(id, data.MediaContainer?.Metadata?.[0]),
      { format: "jpeg" },
    )
  }
  return firstArt(
    [
      ...lineup,
      ...(await queueEntryCandidates(setId, cfg)),
    ],
    artFor,
  )
}

/** Kavita, board games, Steam, MiSTer: the provider's own cover for each item. */
async function pullPoster(
  setId: string,
  cfg: RoutingSetCfg,
  provider: Provider,
): Promise<PosterImage | null> {
  const cover = provider.cover?.bind(provider)
  if (!cover) return null
  const lineup = await pullLineup(setId, cfg, provider, {
    isReadOnly: true,
  }).catch(() => [] as PlayItem[])
  const entries = cfg.filtered_from
    ? []
    : await curatedEntries(setId).catch(() => [])
  return firstArt(
    [
      ...lineup.flatMap((item) => {
        const id = pullItemId(item)
        return id ? [{ id }] : []
      }),
      ...entries.map(({ id }) => ({ id })),
    ],
    ({ id }) => cover(id),
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
    : pullPoster(setId, cfg, provider)
}
