/** Native players consume the existing selector; they never enter the room-control path. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { bookOfRecord, prepareChecked } from "./store/db/open.js";
import {
  listPeople,
  rosterMembersByGroup,
  minPresentByGroup,
  getPerson,
} from "./store/db/people.js";
import { membersByQueue } from "./store/db/queuePeople.js";
import { queueMatchesSelection, numberDuplicates, type ResolvedMember } from "./queuePeople.js";
import * as sets from "./sets.js";
import * as routing from "./engine/routing.js";
import { providerFor } from "./providers/index.js";
import { providerIdForSet } from "./providers/blocks.js";
import { isSetAvailable } from "./season.js";
import { playbackLength } from "./engine/playbackLength.js";
import { wireKindForSet } from "./kind.js";
import * as plex from "./plex.js";
import { liveClient } from "./engine/plex-live.js";
import type { PlexServerAccess } from "./plexSources.js";
import { plexProvider } from "./providers/plex.js";
import {
  nativeVerifiedProfile,
  nativeHomeUsers,
  nativeGrant,
  nativeClient,
  nativeTimeline,
  nativeScopeProof,
  verifiedFetch,
} from "./nativePlex.js";
import * as finished from "./finished.js";
import * as watchedReset from "./watchedReset.js";
import * as promote from "./promote.js";
import * as queueHistory from "./store/db/queueEntryHistory.js";
import type { PlexPlayItem } from "./types.js";

export interface NativeItem extends PlexPlayItem {
  positionKey: string;
  queueEntryKey?: string;
  queueOwnHistory?: boolean;
  queueProviderViewCount?: number;
  sectionStartMs?: number | null;
  sectionEndMs?: number | null;
  resumeMs: number;
}
export interface NativePlan {
  id: string;
  setId: string;
  profileName: string;
  profileUuid: string | null;
  expiresAt: number;
  items: NativeItem[];
  led: string[];
  cursor: number;
  sequence: number;
  started: boolean;
  homeServerId: string | null;
  target: number | null;
  handed: number;
  refill: boolean;
  seen: string[];
  binding: {
    plex_user: string | null;
    account_id: number | null;
    user_uuid: string | null;
    allowed_ratings: string[] | null;
    movie_ratings: string[] | null;
    watch_count_accounts: number[] | null;
    movie_excludes: string[];
  };
  startedPositions: number[];
}
export interface NativeEvent {
  id: string;
  sequence: number;
  index: number;
  state: "playing" | "paused" | "stopped" | "ended" | "skip" | "section-end" | "error";
  positionMs: number;
  durationMs: number;
}
const hash = (s: string): string => createHash("sha256").update(s).digest("hex");

export function nativeAudience(
  members: readonly { kind: string; id: string; role: string; position?: number }[],
): ResolvedMember[] {
  const rosters = rosterMembersByGroup(),
    minimums = minPresentByGroup();
  return members.map((member) => {
    const roster = member.kind === "group" ? (rosters.get(member.id) ?? []) : [];
    const required =
      member.kind === "person"
        ? [member.id]
        : roster.filter((r) => r.role === "required").map((r) => r.personId);
    return {
      ...member,
      position: member.position ?? 0,
      kind: member.kind as "person" | "group",
      role: member.role as "required" | "optional",
      people: member.kind === "person" ? [member.id] : roster.map((r) => r.personId),
      requiredPeople: required,
      minPresent: member.kind === "person" ? 1 : (minimums.get(member.id) ?? required.length),
    };
  });
}

export async function nativeQueues(selected: readonly string[]): Promise<unknown> {
  const registry = await sets.getRegistry(),
    audiences = membersByQueue();
  const numbers = numberDuplicates(
    registry.sets
      .filter((s) => (s.provider_kind || providerIdForSet({ ...s })) === "plex")
      .map((s) => ({
        id: s.id,
        activity: "watching" as const,
        members: audiences.get(s.filtered_from || s.id) ?? [],
      })),
  );
  const homeUsers = await nativeHomeUsers();
  const routingSets = routing.loadSets()?.sets || {};
  const playbackProfile = (id: string, required?: string | null): string | null => {
    if (required) return required;
    const cfg = routingSets[id];
    if (!cfg) return null;
    const binding = routing.bindingFor(cfg);
    const user = homeUsers.find((u) =>
      binding.account_id === 1 && !binding.user_uuid ? u.admin : u.uuid === binding.user_uuid,
    );
    return user ? user.username || user.name : binding.plex_user;
  };
  const queues = registry.sets
    .filter((s) => (s.provider_kind || providerIdForSet({ ...s })) === "plex" && isSetAvailable(s))
    .map((s) => ({ s, members: nativeAudience(audiences.get(s.filtered_from || s.id) ?? []) }))
    .filter(({ members }) => queueMatchesSelection(members, selected))
    .map(({ s, members }) => ({
      id: s.id,
      activity: "watching",
      title: `Movies & Shows${numbers.get(s.id) ? " · " + numbers.get(s.id) : ""}`,
      kind: wireKindForSet(s),
      people: [...new Set(members.flatMap((m) => m.people))],
      requiredProfile: playbackProfile(s.id, s.requires_profile),
    }));
  return {
    queues,
    people: listPeople().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      avatar: `/api/native/people/${encodeURIComponent(p.id)}/avatar`,
    })),
  };
}

const grants = new Map<string, { proof: string; servers: Map<string, PlexServerAccess> }>();
async function grantForPlan(
  plan: NativePlan,
  serverId: string,
  proof?: string,
): Promise<PlexServerAccess> {
  let cached = grants.get(plan.id);
  if (!cached) {
    const credential = proof || (await nativeScopeProof(plan.profileUuid));
    const profile = await nativeVerifiedProfile(credential);
    if (profile.uuid !== plan.profileUuid) throw new Error("Native session authorization failed");
    cached = { proof: credential, servers: new Map() };
    grants.set(plan.id, cached);
  }
  const existing = cached.servers.get(serverId);
  if (existing) return existing;
  const server = await nativeGrant(cached.proof, serverId);
  cached.servers.set(serverId, server);
  return server;
}

export async function createNativePlan(
  setId: string,
  proof: string,
): Promise<NativePlan & { sessionKey: string }> {
  return planForProfile(setId, await nativeVerifiedProfile(proof), undefined, proof);
}
async function planForProfile(
  setId: string,
  profile: plex.HomeUser,
  previous?: NativePlan,
  proof?: string,
): Promise<NativePlan & { sessionKey: string }> {
  const set = await sets.getSet(setId),
    cfg = routing.loadSets()?.sets[setId];
  if (!set || !cfg || !isSetAvailable(set)) throw new Error("This queue is unavailable");
  const provider = providerFor(providerIdForSet({ ...cfg }));
  if (provider.kind !== "plex") throw new Error("Only Plex queues can play on this TV");
  const profileName = profile.admin ? profile.username || profile.name : profile.name;
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
  const selector = plexProvider({
    client: nativeClient(home),
    clientForServer: async (id) => nativeClient(await serverFor(id)),
  });
  const token = home.token;
  if (cfg.source === "queue") await watchedReset.applySeasonalReset(setId, cfg);
  let result = await selector.buckets({
    setName: setId,
    cfg,
    binding,
    token,
    kind: wireKindForSet(cfg),
    lastMovieRk: previous?.items.at(-1)?.ratingKey
      ? String(previous.items.at(-1)?.ratingKey)
      : null,
  });
  if (cfg.source === "queue") {
    await finished.applyQueueWriteSide(setId, cfg, result);
    if (!result.play.length && cfg.restart_when_exhausted)
      result = await selector.buckets({
        setName: setId,
        cfg,
        binding,
        token,
        kind: wireKindForSet(cfg),
      });
  }
  if (!result.play.length) throw new Error("This queue has nothing left to play");
  const target = previous ? previous.target : playbackLength(cfg);
  const remaining = !previous || target == null ? 2000 : Math.max(0, target - previous.handed);
  const seen = new Set(previous?.seen || []);
  const selection = result.play
    .filter((raw) => {
      const item = raw as PlexPlayItem;
      return !previous || !seen.has(`${item.plexServer || ""}:${item.ratingKey}`);
    })
    .slice(0, remaining);
  if (!selection.length) throw new Error("There is no new eligible material to continue");
  const play =
    typeof cfg.max_items === "number" && cfg.max_items > 0
      ? selection.slice(0, cfg.max_items)
      : selection;
  if (play.length > 2000) throw new Error("This preview supports lineups up to 2000 items");
  const items: NativeItem[] = [];
  for (const [index, raw] of play.entries()) {
    const item = raw as NativeItem;
    if (!/^[0-9]+$/.test(String(item.ratingKey))) throw new Error("Unsupported media identity");
    const access = item.plexServer ? await serverFor(item.plexServer) : null;
    if (item.plexServer && !access) throw new Error("A media server is unavailable");
    const metadata = await nativeClient(access || home).container(
      `/library/metadata/${item.ratingKey}`,
      access?.token ?? token,
    );
    const md = metadata.Metadata?.[0];
    if (!md) throw new Error("A queued item is unavailable to this profile");
    items.push({
      ratingKey: String(item.ratingKey),
      plexServer: item.plexServer,
      title: item.title,
      show: item.show,
      season: item.season,
      episode: item.episode,
      type: item.type,
      duration: item.duration,
      queueEntryKey: item.queueEntryKey,
      queueOwnHistory: item.queueOwnHistory,
      sectionStartMs: item.sectionStartMs,
      sectionEndMs: item.sectionEndMs,
      positionKey: `${index}:${item.plexServer || "home"}:${item.ratingKey}`,
      queueProviderViewCount: Math.max(0, Number(md.viewCount) || 0),
      resumeMs:
        item.sectionStartMs ??
        (item.queueOwnHistory && item.queueEntryKey
          ? (queueHistory.progressFor(setId, item.queueEntryKey).get(String(item.ratingKey))
              ?.positionMs ?? 0)
          : index === 0
            ? result.offset || Number(md.viewOffset) || 0
            : Number(md.viewOffset) || 0),
    });
  }
  const plan: NativePlan = {
    id: randomUUID(),
    setId,
    profileName,
    profileUuid: profile.uuid,
    expiresAt: Date.now() + 24 * 3600000,
    items,
    led: result.led || [],
    cursor: 0,
    sequence: 0,
    started: false,
    startedPositions: [],
    binding: {
      ...binding,
      allowed_ratings: binding.allowed_ratings ? [...binding.allowed_ratings] : null,
      movie_ratings: binding.movie_ratings ? [...binding.movie_ratings] : null,
    },
    homeServerId: identity.machineIdentifier || null,
    seen: [
      ...new Set([...seen, ...items.map((item) => `${item.plexServer || ""}:${item.ratingKey}`)]),
    ],
    target,
    handed: (previous?.handed || 0) + items.length,
    refill: target === null || (previous?.handed || 0) + items.length < target,
  };
  const sessionKey = randomBytes(32).toString("base64url");
  prepareChecked(
    bookOfRecord(),
    "INSERT INTO native_tv_sessions (id, key_hash, data) VALUES (:id, :key_hash, :data)",
  ).run({ id: plan.id, key_hash: hash(sessionKey), data: JSON.stringify(plan) });
  grants.set(plan.id, { proof: credential, servers });
  return { ...plan, sessionKey };
}

export function readNativePlan(id: string, key: string): NativePlan {
  const row = prepareChecked<{ key_hash: string; data: string }>(
    bookOfRecord(),
    "SELECT key_hash,data FROM native_tv_sessions WHERE id=:id",
  ).get({ id });
  if (
    !row ||
    !key ||
    !timingSafeEqual(Buffer.from(row.key_hash, "hex"), Buffer.from(hash(key), "hex"))
  )
    throw new Error("Native session authorization failed");
  const plan = JSON.parse(row.data) as NativePlan;
  if (plan.expiresAt < Date.now()) throw new Error("This native session has expired");
  return plan;
}
export function validateNativeEvent(plan: NativePlan, event: NativeEvent): void {
  if (
    !/^[a-zA-Z0-9-]{8,80}$/.test(event.id) ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence <= plan.sequence ||
    event.index !== plan.cursor
  )
    throw new Error("Stale or out-of-order playback event");
  if (
    !["playing", "paused", "stopped", "ended", "skip", "section-end", "error"].includes(event.state)
  )
    throw new Error("Unknown playback event");
  if (
    ![event.positionMs, event.durationMs].every(
      (n) => Number.isFinite(n) && n >= 0 && n <= 7 * 24 * 3600000,
    )
  )
    throw new Error("Invalid playback position");
  if (!plan.items[event.index]) throw new Error("Playback position is outside this session");
  if (
    event.state === "section-end" &&
    (plan.items[event.index]?.sectionEndMs == null ||
      event.positionMs < Number(plan.items[event.index]?.sectionEndMs) - 500)
  )
    throw new Error("This item has no section boundary");
}
const events = new Map<string, Promise<unknown>>();
export async function nativeEvent(
  id: string,
  key: string,
  event: NativeEvent,
  proof?: string,
): Promise<{ ok: true; duplicate?: boolean; cursor: number }> {
  const previous = events.get(id) || Promise.resolve();
  const pending = previous
    .catch(() => {})
    .then(async () => {
      const plan = readNativePlan(id, key);
      const duplicate = prepareChecked<{ id: string }>(
        bookOfRecord(),
        "SELECT id FROM native_tv_events WHERE session_id=:session_id AND id=:id",
      ).get({ session_id: id, id: event.id });
      if (duplicate) return { ok: true as const, duplicate: true, cursor: plan.cursor };
      validateNativeEvent(plan, event);
      const item = plan.items[event.index]!;
      const access = await grantForPlan(plan, item.plexServer || plan.homeServerId || "", proof);
      const state = ["ended", "skip", "section-end", "error"].includes(event.state)
        ? "stopped"
        : event.state;
      const query = new URLSearchParams({
        type: "video",
        ratingKey: String(item.ratingKey),
        key: `/library/metadata/${item.ratingKey}`,
        state,
        time: String(Math.round(event.positionMs)),
        duration: String(Math.round(event.durationMs)),
        "X-Plex-Client-Identifier": `queuepilot-native-${id}`,
        "X-Plex-Product": "QueuePilot TV",
        "X-Plex-Platform": "Android",
      });
      if (event.state === "playing" && !plan.startedPositions.includes(event.index)) {
        const mc = await nativeClient(access).container(
          `/library/metadata/${item.ratingKey}`,
          access.token,
        );
        item.queueProviderViewCount = Math.max(0, Number(mc.Metadata?.[0]?.viewCount) || 0);
        plan.startedPositions.push(event.index);
      }
      await nativeTimeline(access, query);
      if (!plan.started && event.state === "playing") {
        for (const entryKey of plan.led) await promote.recordLead(plan.setId, entryKey);
        plan.started = true;
      }
      if (
        item.queueOwnHistory &&
        item.queueEntryKey &&
        item.sectionStartMs == null &&
        item.sectionEndMs == null
      )
        queueHistory.savePosition(
          plan.setId,
          item.queueEntryKey,
          String(item.ratingKey),
          event.positionMs,
          event.durationMs,
        );
      if (["stopped", "ended", "skip", "section-end", "error"].includes(event.state)) {
        if (event.state === "section-end" && item.queueOwnHistory && item.queueEntryKey)
          queueHistory.markCompleted(plan.setId, item.queueEntryKey, String(item.ratingKey));
        else
          await finished.finalizeQueueProgress(
            plan.setId,
            plan.profileName,
            { ...item, ratingKey: String(item.ratingKey) },
            event.durationMs,
            { client: nativeClient(access), token: access.token },
          );
        const home = await grantForPlan(plan, plan.homeServerId || "", proof);
        const scoped = plexProvider({
          client: nativeClient(home),
          clientForServer: async (id) => nativeClient(await grantForPlan(plan, id, proof)),
        });
        await finished.reconcileQueue(plan.setId, plan.profileName, {
          provider: scoped,
          binding: {
            ...plan.binding,
            allowed_ratings: plan.binding.allowed_ratings
              ? new Set(plan.binding.allowed_ratings)
              : null,
            movie_ratings: plan.binding.movie_ratings ? new Set(plan.binding.movie_ratings) : null,
          },
          token: home.token,
        });
      }
      if (["ended", "skip", "section-end"].includes(event.state)) plan.cursor++;
      plan.sequence = event.sequence;
      const db = bookOfRecord();
      db.exec("BEGIN IMMEDIATE");
      try {
        prepareChecked(
          db,
          "INSERT INTO native_tv_events(session_id,id,sequence,data) VALUES(:session_id,:id,:sequence,:data)",
        ).run({
          session_id: id,
          id: event.id,
          sequence: event.sequence,
          data: JSON.stringify(event),
        });
        prepareChecked(db, "UPDATE native_tv_sessions SET data=:data WHERE id=:id").run({
          id,
          data: JSON.stringify(plan),
        });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { ok: true as const, cursor: plan.cursor };
    });
  events.set(id, pending);
  try {
    return await pending;
  } finally {
    if (events.get(id) === pending) events.delete(id);
  }
}

export async function nativeAvatar(personId: string): Promise<string | null> {
  const person = getPerson(personId),
    accounts = person?.accounts.plex || [];
  if (accounts.length !== 1) return null;
  const users = await nativeHomeUsers();
  const matches = users.filter((u) => [u.name, u.username].includes(accounts[0]!));
  const thumb = matches.length === 1 ? matches[0]?.thumb : null;
  if (!thumb) return null;
  const url = new URL(thumb, "https://plex.tv");
  return safeAvatarUrl(url.href) ? url.href : null;
}

export function safeAvatarUrl(address: string): boolean {
  try {
    const u = new URL(address);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === "443") &&
      (u.hostname === "plex.tv" ||
        u.hostname.endsWith(".plex.tv") ||
        u.hostname === "secure.gravatar.com" ||
        u.hostname === "www.gravatar.com")
    );
  } catch {
    return false;
  }
}
export async function avatarBytes(
  address: string,
): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  let url = address;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!safeAvatarUrl(url)) return null;
    if (new URL(url).hostname.endsWith("gravatar.com")) {
      const image = new URL(url);
      image.searchParams.set("s", "512");
      url = image.href;
    }
    const response = await verifiedFetch(url, {
      signal: AbortSignal.timeout(8000),
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const target = response.headers.get("location");
      await response.body?.cancel();
      if (!target) return null;
      url = new URL(target, url).href;
      continue;
    }
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4 * 1024 * 1024) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return { bytes: bytes.buffer, type: response.headers.get("content-type")! };
  }
  return null;
}

export async function continueNativePlan(
  id: string,
  key: string,
  proof?: string,
): Promise<(NativePlan & { sessionKey: string }) | { complete: true }> {
  const previous = readNativePlan(id, key);
  if (previous.cursor !== previous.items.length)
    throw new Error("The current lineup has not finished");
  if (!previous.refill) return { complete: true };
  const profile = (await nativeHomeUsers()).find((p) => (p.uuid || null) === previous.profileUuid);
  if (!profile) throw new Error("The playback profile is no longer available");
  try {
    return await planForProfile(previous.setId, profile, previous, proof || grants.get(id)?.proof);
  } catch (error) {
    if (error instanceof Error && /nothing left|no new eligible/i.test(error.message))
      return { complete: true };
    throw error;
  }
}
