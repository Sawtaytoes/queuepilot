/**
 * The one native TV authorization path: a VERIFIED Plex profile may read or play a queue only
 * when the queue's binding resolves to that profile, and then only through grants derived from
 * that profile's own proof.
 *
 * Extracted from `createNativePlan` so the full-queue read and the watched mark ask exactly the
 * same question a playback session asks. Nothing here was loosened in the move: the checks, the
 * error text and the grant model are the ones a session has always used.
 */
import * as sets from "./sets.js";
import * as routing from "./engine/routing.js";
import { providerFor } from "./providers/index.js";
import { providerIdForSet } from "./providers/blocks.js";
import { plexProvider } from "./providers/plex.js";
import { isSetAvailable } from "./season.js";
import { liveClient } from "./engine/plex-live.js";
import { nativeClient, nativeGrant, nativeScopeProof } from "./nativePlex.js";
import type * as plex from "./plex.js";
import type { PlexServerAccess } from "./plexSources.js";
import type { EngineBinding, PlexClient, RoutingSetCfg } from "./types.js";

/**
 * A request the native API understood and refuses for a stated reason. Every other failure on
 * these routes stays the 403 a session has always answered, so no new status leaks whether a
 * queue the profile cannot use exists.
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
  profile: plex.HomeUser;
  /** The name a session records for completion reconciliation. */
  profileName: string;
  homeServerId: string;
  /** The profile proof every later grant is derived from. Never persisted. */
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

export async function authorizeQueue(
  setId: string,
  profile: plex.HomeUser,
  proof?: string,
): Promise<QueueAccess> {
  const set = await sets.getSet(setId),
    cfg = routing.loadSets()?.sets[setId];
  if (!set || !cfg || !isSetAvailable(set)) throw new Error("This queue is unavailable");
  const provider = providerFor(providerIdForSet({ ...cfg }));
  if (provider.kind !== "plex") throw new Error("Only Plex queues can play on this TV");
  const profileName = profileNameOf(profile);
  if (cfg.requires_profile && ![profile.name, profile.username].includes(cfg.requires_profile))
    throw new Error(`Switch to the queue's Plex profile: ${cfg.requires_profile}`);
  let binding = routing.bindingFor(cfg, profileName);
  binding = await plexProvider({
    resolveProfileUser: async (title) =>
      [profile.name, profile.username].includes(title || null) ? profile : null,
  }).profileBinding!(binding, cfg.requires_profile || profileName);
  if (
    (binding.user_uuid || null) !== (profile.uuid || null) ||
    (binding.account_id != null && binding.account_id !== profile.id)
  )
    throw new Error(
      `This queue plays as ${binding.plex_user || "the server owner"}. Switch Plex profile first.`,
    );
  const identity = (await liveClient().container("/identity")) as { machineIdentifier?: string };
  if (!identity.machineIdentifier)
    throw new Error("The home Plex server identity could not be verified");
  const credential = proof || (await nativeScopeProof(profile.uuid));
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
