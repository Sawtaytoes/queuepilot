/** Verified cloud identity and direct grants for native clients. Never inherit global TLS bypass. */
import { Agent } from "undici";
import { PLEX_CLIENT_IDENTIFIER, PLEX_TOKEN } from "./config.js";
import type { HomeUser } from "./plex.js";
import { plexServerClient, type PlexServerAccess } from "./plexSources.js";
import type { PlexClient } from "./types.js";
const verifiedAgent = new Agent({ connect: { rejectUnauthorized: true } });
export const verifiedFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, dispatcher: verifiedAgent } as RequestInit);
async function cloud(path: string, token: string, method = "GET"): Promise<unknown> {
  const response = await verifiedFetch("https://plex.tv" + path, {
    method,
    headers: {
      "X-Plex-Token": token,
      "X-Plex-Client-Identifier": PLEX_CLIENT_IDENTIFIER,
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Plex could not verify this authorization");
  return response.json();
}
export async function nativeHomeUsers(): Promise<(HomeUser & { thumb?: string })[]> {
  const data = (await cloud("/api/v2/home/users", PLEX_TOKEN)) as {
    users?: {
      id: number;
      uuid?: string;
      admin?: boolean;
      title?: string;
      username?: string;
      restricted?: boolean;
      thumb?: string;
    }[];
  };
  return (data.users || []).map((u) => ({
    id: u.admin ? 1 : Number(u.id),
    uuid: u.admin ? null : u.uuid || null,
    admin: !!u.admin,
    name: u.title || u.username || "Profile",
    username: u.username || null,
    restricted: !!u.restricted,
    thumb: u.thumb,
  }));
}
export async function nativeVerifiedProfile(proof: string): Promise<HomeUser> {
  if (!proof || proof.length > 2048) throw new Error("Plex sign-in is required");
  const [identity, users] = await Promise.all([
    cloud("/api/v2/user", proof) as Promise<{ id?: number; uuid?: string }>,
    nativeHomeUsers(),
  ]);
  const child = users.find(
    (u) =>
      !u.admin && u.uuid === identity.uuid && u.id != null && String(u.id) === String(identity.id),
  );
  if (child) return child;
  const owner = (await cloud("/api/v2/user", PLEX_TOKEN)) as { id?: number };
  const admin = users.find((u) => u.admin);
  if (admin && identity.id && String(identity.id) === String(owner.id)) return admin;
  throw new Error("This profile is not enrolled with this QueuePilot server");
}
function directOrigin(uri: string, local: boolean, relay: boolean): boolean {
  try {
    const u = new URL(uri);
    if (relay || u.username || u.password || u.search || u.hash || u.pathname !== "/") return false;
    if (u.protocol === "https:") return true;
    if (u.protocol !== "http:" || !local) return false;
    const p = u.hostname.split(".").map(Number);
    return (
      p.length === 4 &&
      p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
      (p[0] === 10 ||
        (p[0] === 192 && p[1] === 168) ||
        (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31))
    );
  } catch {
    return false;
  }
}
export async function nativeGrant(proof: string, serverId: string): Promise<PlexServerAccess> {
  const resources = (await cloud("/api/v2/resources?includeHttps=1&includeRelay=0", proof)) as {
    clientIdentifier?: string;
    name?: string;
    provides?: string;
    accessToken?: string;
    connections?: { uri?: string; local?: boolean; relay?: boolean }[];
  }[];
  const server = resources.find(
    (s) => s.clientIdentifier === serverId && s.provides?.split(",").includes("server"),
  );
  if (!server?.accessToken) throw new Error("This profile cannot access the queued server");
  const connections = [...(server.connections || [])].sort(
    (a, b) => Number(!a.local) - Number(!b.local),
  );
  for (const c of connections) {
    if (!c.uri || !directOrigin(c.uri, !!c.local, !!c.relay)) continue;
    try {
      const baseUrl = c.uri.replace(/\/+$/, "");
      const response = await verifiedFetch(baseUrl + "/identity", {
        headers: { "X-Plex-Token": server.accessToken, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) continue;
      const data = (await response.json()) as { MediaContainer?: { machineIdentifier?: string } };
      if (data.MediaContainer?.machineIdentifier !== serverId) continue;
      return {
        id: serverId,
        name: server.name || "Plex server",
        baseUrl,
        token: server.accessToken,
        libraries: [],
      };
    } catch {}
  }
  throw new Error("No verified direct connection to the queued server is available");
}
export const nativeClient = (access: PlexServerAccess): PlexClient =>
  plexServerClient(access, verifiedFetch);
export async function nativeTimeline(
  access: PlexServerAccess,
  query: URLSearchParams,
): Promise<void> {
  const response = await verifiedFetch(access.baseUrl + "/:/timeline?" + query, {
    headers: { "X-Plex-Token": access.token },
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Plex could not save playback progress");
  }
  await response.arrayBuffer();
}
export async function nativeScopeProof(uuid: string | null): Promise<string> {
  if (!uuid) return PLEX_TOKEN;
  const result = (await cloud(
    "/api/v2/home/users/" + encodeURIComponent(uuid) + "/switch",
    PLEX_TOKEN,
    "POST",
  )) as { authToken?: string };
  if (!result.authToken) throw new Error("The playback profile needs reauthorization");
  return result.authToken;
}
