/** Verified cloud identity and direct grants for native clients. Never inherit global TLS bypass. */
import { Agent } from "undici"
import {
  PLEX_CLIENT_IDENTIFIER,
  PLEX_TOKEN,
} from "./config.js"
import type { HomeUser } from "./plex.js"
import {
  type PlexServerAccess,
  plexServerClient,
} from "./plexSources.js"
import type { PlexClient } from "./types.js"

const verifiedAgent = new Agent({
  connect: { rejectUnauthorized: true },
})
export const verifiedFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    dispatcher: verifiedAgent,
  } as RequestInit)
async function cloud(
  path: string,
  token: string,
  method = "GET",
): Promise<unknown> {
  const response = await verifiedFetch(
    "https://plex.tv" + path,
    {
      method,
      headers: {
        "X-Plex-Token": token,
        "X-Plex-Client-Identifier": PLEX_CLIENT_IDENTIFIER,
        Accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    },
  )
  if (!response.ok)
    throw new Error(
      "Plex could not verify this authorization",
    )
  return response.json()
}
/**
 * A profile's plex.tv language settings: the `profile` fields of `GET /api/v2/user`. A native TV
 * applies them when Plex marks no audio or subtitle stream `selected` for an item. The TV holds
 * no plex.tv token for a queue that plays as another profile, so the plan carries them.
 */
export interface NativeLanguages {
  defaultAudioLanguage: string | null
  // eslint-disable-next-line @typescript-eslint/naming-convention -- a Plex API field
  autoSelectAudio: boolean
  defaultSubtitleLanguage: string | null
  /** 0 manual, 1 with audio in another language, 2 always; null when plex.tv does not say. */
  autoSelectSubtitle: number | null
}
const languageOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim()
    ? value.trim()
    : null
/**
 * The language settings of the profile `proof` belongs to, or null when plex.tv does not answer.
 * Null is safe: Plex's own stream selection still plays, and the TV never substitutes another
 * profile's settings.
 */
export async function nativeLanguages(
  proof: string,
): Promise<NativeLanguages | null> {
  try {
    const user = (await cloud("/api/v2/user", proof)) as {
      profile?: Record<string, unknown> | null
    }
    const profile = user?.profile
    if (!profile || typeof profile !== "object") return null
    const subtitleMode = Number(profile.autoSelectSubtitle)
    return {
      defaultAudioLanguage: languageOf(
        profile.defaultAudioLanguage,
      ),
      autoSelectAudio:
        profile.autoSelectAudio === true ||
        profile.autoSelectAudio === 1 ||
        profile.autoSelectAudio === "1",
      defaultSubtitleLanguage: languageOf(
        profile.defaultSubtitleLanguage,
      ),
      autoSelectSubtitle:
        profile.autoSelectSubtitle == null ||
        !Number.isInteger(subtitleMode)
          ? null
          : subtitleMode,
    }
  } catch {
    return null
  }
}
export async function nativeHomeUsers(): Promise<
  (HomeUser & { thumb?: string })[]
> {
  const data = (await cloud(
    "/api/v2/home/users",
    PLEX_TOKEN,
  )) as {
    users?: {
      id: number
      uuid?: string
      // eslint-disable-next-line @typescript-eslint/naming-convention -- a Plex API field
      admin?: boolean
      title?: string
      username?: string
      // eslint-disable-next-line @typescript-eslint/naming-convention -- a Plex API field
      restricted?: boolean
      thumb?: string
    }[]
  }
  return (data.users || []).map((homeProfile) => ({
    id: homeProfile.admin ? 1 : Number(homeProfile.id),
    uuid: homeProfile.admin
      ? null
      : homeProfile.uuid || null,
    admin: !!homeProfile.admin,
    name:
      homeProfile.title ||
      homeProfile.username ||
      "Profile",
    username: homeProfile.username || null,
    restricted: !!homeProfile.restricted,
    thumb: homeProfile.thumb,
  }))
}
export async function nativeVerifiedProfile(
  proof: string,
): Promise<HomeUser> {
  if (!proof || proof.length > 2048)
    throw new Error("Plex sign-in is required")
  const [identity, users] = await Promise.all([
    cloud("/api/v2/user", proof) as Promise<{
      id?: number
      uuid?: string
    }>,
    nativeHomeUsers(),
  ])
  const child = users.find(
    (user) =>
      !user.admin &&
      user.uuid === identity.uuid &&
      user.id != null &&
      String(user.id) === String(identity.id),
  )
  if (child) return child
  const owner = (await cloud(
    "/api/v2/user",
    PLEX_TOKEN,
  )) as { id?: number }
  const admin = users.find((user) => user.admin)
  if (
    admin &&
    identity.id &&
    String(identity.id) === String(owner.id)
  )
    return admin
  throw new Error(
    "This profile is not enrolled with this QueuePilot server",
  )
}
function directOrigin(
  uri: string,
  isLocal: boolean,
  isRelay: boolean,
): boolean {
  try {
    const url = new URL(uri)
    if (
      isRelay ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return false
    if (url.protocol === "https:") return true
    if (url.protocol !== "http:" || !isLocal) return false
    const octets = url.hostname.split(".").map(Number)
    // `NaN` compares false, exactly as a missing octet did; the length check below rules
    // that out anyway.
    const secondOctet = octets[1] ?? Number.NaN
    return (
      octets.length === 4 &&
      octets.every(
        (octet) =>
          Number.isInteger(octet) &&
          octet >= 0 &&
          octet <= 255,
      ) &&
      (octets[0] === 10 ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 &&
          secondOctet >= 16 &&
          secondOctet <= 31))
    )
  } catch {
    return false
  }
}
export async function nativeGrant(
  proof: string,
  serverId: string,
): Promise<PlexServerAccess> {
  const resources = (await cloud(
    "/api/v2/resources?includeHttps=1&includeRelay=0",
    proof,
  )) as {
    clientIdentifier?: string
    name?: string
    provides?: string
    accessToken?: string
    connections?: {
      uri?: string
      // eslint-disable-next-line @typescript-eslint/naming-convention -- a Plex API field
      local?: boolean
      // eslint-disable-next-line @typescript-eslint/naming-convention -- a Plex API field
      relay?: boolean
    }[]
  }[]
  const server = resources.find(
    (resource) =>
      resource.clientIdentifier === serverId &&
      resource.provides?.split(",").includes("server"),
  )
  if (!server?.accessToken)
    throw new Error(
      "This profile cannot access the queued server",
    )
  const connections = [...(server.connections || [])].sort(
    (left, right) =>
      Number(!left.local) - Number(!right.local),
  )
  for (const connection of connections) {
    if (
      !connection.uri ||
      !directOrigin(
        connection.uri,
        !!connection.local,
        !!connection.relay,
      )
    )
      continue
    try {
      const baseUrl = connection.uri.replace(/\/+$/, "")
      const response = await verifiedFetch(
        baseUrl + "/identity",
        {
          headers: {
            "X-Plex-Token": server.accessToken,
            Accept: "application/json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        },
      )
      if (!response.ok) continue
      const data = (await response.json()) as {
        MediaContainer?: { machineIdentifier?: string }
      }
      if (
        data.MediaContainer?.machineIdentifier !== serverId
      )
        continue
      return {
        id: serverId,
        name: server.name || "Plex server",
        baseUrl,
        token: server.accessToken,
        libraries: [],
      }
    } catch {}
  }
  throw new Error(
    "No verified direct connection to the queued server is available",
  )
}
export const nativeClient = (
  access: PlexServerAccess,
): PlexClient => plexServerClient(access, verifiedFetch)
export async function nativeTimeline(
  access: PlexServerAccess,
  query: URLSearchParams,
): Promise<void> {
  const response = await verifiedFetch(
    access.baseUrl + "/:/timeline?" + query,
    {
      headers: { "X-Plex-Token": access.token },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    },
  )
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error("Plex could not save playback progress")
  }
  await response.arrayBuffer()
}
/**
 * A Plex token for one Home profile, minted with the owner's token through plex.tv's Home-user
 * switch (null uuid = the owner). Every native queue route plays as the queue's own profile, so
 * this runs on most TV requests; a minted token is kept for ten minutes rather than asking
 * plex.tv to switch on every page. Memory only, never persisted.
 */
const SCOPE_PROOF_TTL_MS = 10 * 60_000
const scopeProofs = new Map<
  string,
  { token: string; expiresAt: number }
>()
export async function nativeScopeProof(
  uuid: string | null,
): Promise<string> {
  if (!uuid) return PLEX_TOKEN
  const cached = scopeProofs.get(uuid)
  if (cached && cached.expiresAt > Date.now())
    return cached.token
  const result = (await cloud(
    "/api/v2/home/users/" +
      encodeURIComponent(uuid) +
      "/switch",
    PLEX_TOKEN,
    "POST",
  )) as { authToken?: string }
  if (!result.authToken)
    throw new Error(
      "The playback profile needs reauthorization",
    )
  scopeProofs.set(uuid, {
    token: result.authToken,
    expiresAt: Date.now() + SCOPE_PROOF_TTL_MS,
  })
  return result.authToken
}
