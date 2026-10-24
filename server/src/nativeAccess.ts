/**
 * The one native TV authorization path.
 *
 * ⚠️ THE TV IS A HOUSEHOLD DEVICE, NOT A PROFILE (decision
 * `2026-10-23-the-native-tv-plays-each-queue-as-its-own-profile-and-locks-queues-with-a-pin`).
 * Until then a verified profile could read or play a queue only when the queue's binding
 * resolved to THAT profile, so the TV had to switch Plex profile before every queue that played
 * as somebody else. Now two separate questions are asked, and neither stands in for the other:
 *
 *  1. **May this device use QueuePilot at all?** `nativeVerifiedProfile()` (the route's job)
 *     proves the presented Plex token belongs to the server owner or a member of the owner's
 *     Plex Home. Anything else — another Plex account, a shared friend, a forged token — is the
 *     403 these routes have always answered. Fail closed.
 *  2. **Whom does this queue play as?** `queuePlayAs()` answers from the queue's OWN
 *     configuration — `requires_profile`, else the routing binding, else the server owner — and
 *     every grant below is minted for THAT profile by the server's own Home-user switch
 *     (`nativeScopeProof`). Item reads, playback grants, scrobbles, and watched marks are all
 *     that profile's, so history lands where the queue says, whoever holds the remote.
 *
 * The device's own token is never used for a queue's grants. Using it would write the device
 * account's history for a queue configured to play as somebody else, which is exactly the
 * failure the profile gate exists to prevent.
 *
 * A queue marked "Locked on TV" additionally needs the household TV PIN (`nativeLock.ts`).
 */
import * as sets from "./sets.js";
import * as routing from "./engine/routing.js";
import { providerFor } from "./providers/index.js";
import { providerIdForSet } from "./providers/blocks.js";
import { plexProvider } from "./providers/plex.js";
import { isSetAvailable } from "./season.js";
import { liveClient } from "./engine/plex-live.js";
import { nativeClient, nativeGrant, nativeHomeUsers, nativeScopeProof } from "./nativePlex.js";
import { assertUnlocked, type NativeDevice } from "./nativeLock.js";
import type * as plex from "./plex.js";
import type { PlexServerAccess } from "./plexSources.js";
import type { EngineBinding, PlexClient, RoutingSetCfg } from "./types.js";

/**
 * A request the native API understood and refuses for a stated reason. Every other failure on
 * these routes stays the 403 a session has always answered, so no new status leaks whether a
 * queue the device cannot use exists.
 */
export class NativeRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "NativeRequestError";
  }
}

export interface QueueAccess {
  setId: string;
  set: NonNullable<Awaited<ReturnType<typeof sets.getSet>>>;
  cfg: RoutingSetCfg;
  binding: EngineBinding;
  /** The profile the QUEUE plays as. Not the device's account. */
  profile: plex.HomeUser;
  /** The name a session records for completion reconciliation. */
  profileName: string;
  homeServerId: string;
  /** The play-as profile's proof every later grant is derived from. Never persisted. */
  credential: string;
  home: PlexServerAccess;
  serverFor: (id: string) => Promise<PlexServerAccess>;
  servers: Map<string, PlexServerAccess>;
  selector: ReturnType<typeof plexProvider>;
  client: PlexClient;
  clientForServer: (id: string) => Promise<PlexClient>;
  token: string;
}

/** The name QueuePilot records for a profile. The owner is known by username. */
export const profileNameOf = (profile: plex.HomeUser): string =>
  profile.admin ? profile.username || profile.name : profile.name;

/**
 * The Plex Home profile a queue plays as, from its own configuration only.
 *
 * Same answer `nativeHistory.queuePlaysAs()` gives the other way round: `requires_profile`
 * names a profile by title or username; otherwise a rotation binding names an account by uuid
 * or id; otherwise the queue plays as the server owner. Null when the named profile is not in
 * this Plex Home any more — a stated refusal, never a silent fallback to the owner, because the
 * owner's history is the wrong place for a queue configured to play as somebody else.
 */
export function queuePlayAs(
  cfg: RoutingSetCfg,
  users: readonly plex.HomeUser[],
): plex.HomeUser | null {
  if (cfg.requires_profile)
    return users.find((u) => [u.name, u.username].includes(cfg.requires_profile!)) ?? null;
  const binding = routing.bindingFor(cfg);
  if (binding.user_uuid) return users.find((u) => u.uuid === binding.user_uuid) ?? null;
  if (binding.account_id != null && binding.account_id !== 1)
    return users.find((u) => !u.admin && u.id === binding.account_id) ?? null;
  return users.find((u) => u.admin) ?? null;
}

/**
 * Authorize one queue for a household device, and return grants for the queue's OWN profile.
 *
 * `device` is the verified caller. It is checked against the queue's TV lock and nothing else.
 * `null` means the caller already holds a session key for this queue — a continuation of a
 * sitting that was authorized (and, if locked, unlocked) when it started — so the lock is not
 * asked again; a four-hour unlock must not end a sitting halfway through a film.
 */
export async function authorizeQueue(
  setId: string,
  device: NativeDevice | null,
): Promise<QueueAccess> {
  const set = await sets.getSet(setId),
    cfg = routing.loadSets()?.sets[setId];
  if (!set || !cfg || !isSetAvailable(set)) throw new Error("This queue is unavailable");
  const provider = providerFor(providerIdForSet({ ...cfg }));
  if (provider.kind !== "plex") throw new Error("Only Plex queues can play on this TV");
  if (device) assertUnlocked(set, device);
  const profile = queuePlayAs(cfg, await nativeHomeUsers());
  if (!profile)
    throw new Error(
      `This queue plays as ${cfg.requires_profile || "a Plex profile"}, which is not in this Plex Home`,
    );
  const profileName = profileNameOf(profile);
  let binding = routing.bindingFor(cfg, profileName);
  binding = await plexProvider({
    resolveProfileUser: async (title) =>
      [profile.name, profile.username].includes(title || null) ? profile : null,
  }).profileBinding!(binding, cfg.requires_profile || profileName);
  // The binding must still agree with the profile resolved above. A rotation binding that names
  // an account explicitly is returned untouched by `profileBinding`, so this is the check that a
  // hand-edited `profiles[]` and the Home it names have not drifted apart.
  if (
    (binding.user_uuid || null) !== (profile.uuid || null) ||
    (binding.account_id != null && binding.account_id !== profile.id)
  )
    throw new Error("This queue's Plex binding does not match its profile");
  const identity = (await liveClient().container("/identity")) as { machineIdentifier?: string };
  if (!identity.machineIdentifier)
    throw new Error("The home Plex server identity could not be verified");
  const credential = await nativeScopeProof(profile.uuid);
  const servers = new Map<string, PlexServerAccess>();
  const home = await nativeGrant(credential, identity.machineIdentifier);
  servers.set(home.id, home);
  const serverFor = async (id: string): Promise<PlexServerAccess> => {
    const existing = servers.get(id);
    if (existing) return existing;
    const access = await nativeGrant(credential, id);
    servers.set(id, access);
    return access;
  };
  const clientForServer = async (id: string): Promise<PlexClient> =>
    nativeClient(await serverFor(id));
  const client = nativeClient(home);
  const selector = plexProvider({ client, clientForServer });
  return {
    setId,
    set,
    cfg,
    binding,
    profile,
    profileName,
    homeServerId: identity.machineIdentifier,
    credential,
    home,
    serverFor,
    servers,
    selector,
    client,
    clientForServer,
    token: home.token,
  };
}
