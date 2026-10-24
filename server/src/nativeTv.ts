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
import { queueMatchesSelection, type ResolvedMember } from "./queuePeople.js";
import { isSupersededTier, queueListNumbers, queueTitle } from "../../shared/queueTitle.js";
import { authorizeQueue, NativeRequestError, profileNameOf, queuePlayAs } from "./nativeAccess.js";
import { isQueueLocked, isUnlocked, unlock, type NativeDevice } from "./nativeLock.js";
import { storedGroups } from "./groups.js";
import {
  expandEntry,
  fullQueueFor,
  spliceStart,
  type FullQueue,
  type NativeStart,
} from "./nativeQueueDetail.js";
import { historyFor, type NativeHistory } from "./nativeHistory.js";
import * as cache from "./cache.js";
import * as queues from "./queues.js";
import * as resolve from "./engine/resolve.js";
import * as select from "./engine/select.js";
import * as sets from "./sets.js";
import * as routing from "./engine/routing.js";
import { providerIdForSet } from "./providers/blocks.js";
import { isSetAvailable } from "./season.js";
import { playbackLength } from "./engine/playbackLength.js";
import { wireKindForSet } from "./kind.js";
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
import { addQueueItem, QueueAddError } from "./queueItemAdd.js";
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
  /** Epoch ms. Absent on a plan written before 2026-10-22; read `expiresAt - 24h` then. */
  createdAt?: number;
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
/**
 * The QUEUE profile's grant for one server, handed to the TV with a new plan so it streams the
 * items as the profile the queue plays as — a TV signed in as a restricted profile could not
 * otherwise open an owner queue's items. In the RESPONSE only: never in `native_tv_sessions`,
 * never in `GET /native/sessions/:id`. The TV keeps them in memory for the sitting.
 */
export interface NativePlaybackGrant {
  serverId: string;
  baseUrl: string;
  token: string;
}
export type NativePlanResponse = NativePlan & { sessionKey: string; grants: NativePlaybackGrant[] };

export interface NativeEvent {
  id: string;
  sequence: number;
  index: number;
  state: "playing" | "paused" | "stopped" | "ended" | "skip" | "section-end" | "error";
  positionMs: number;
  durationMs: number;
}
const hash = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * What a native request presents, read from its headers by the route. `proof` is the TV's Plex
 * token (`X-Plex-Profile-Token`); it identifies a HOUSEHOLD DEVICE and nothing more — a queue
 * never plays with it (see `nativeAccess.ts`). A bare string is the proof alone.
 */
export interface NativeCaller {
  proof: string;
  /** `X-QueuePilot-Device`. */
  deviceId?: string;
  /** `X-QueuePilot-Unlock`. */
  unlockToken?: string;
}

/** Verify the caller as a household device. Throws (403) for anybody outside the Plex Home. */
export async function nativeDevice(caller: NativeCaller | string): Promise<NativeDevice> {
  const c = typeof caller === "string" ? { proof: caller } : caller;
  return {
    account: await nativeVerifiedProfile(c.proof),
    deviceId: c.deviceId ?? "",
    unlockToken: c.unlockToken ?? "",
  };
}

/** `POST /api/native/unlock`: trade the household TV PIN for an unlock on this device. */
export async function nativeUnlock(
  caller: NativeCaller,
  pin: unknown,
): Promise<{ unlockToken: string; expiresAt: number }> {
  const device = await nativeDevice(caller);
  return unlock(device.account, device.deviceId, pin);
}

/**
 * The audience line the web prints beside a queue (`queuePeopleLabel` in
 * `web/src/lib/people.ts`): the REQUIRED members by name, three at most and then `+n`, and
 * "Anybody" when nobody is required. Optional members are faces, not text.
 */
export function audienceText(
  members: readonly { kind: string; id: string; role: string }[],
  nameOf: (member: { kind: string; id: string }) => string,
): string {
  const names = members.filter((m) => m.role === "required").map(nameOf);
  if (!names.length) return "Anybody";
  return names.length <= 3
    ? names.join(", ")
    : `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}

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

/**
 * Every queue's title, as the web Queues page prints it. `queueTitle` and `queueListNumbers`
 * are the web's own functions (`shared/queueTitle.ts`), called over the WHOLE registry in
 * registry order — every provider, not only Plex — because that is the list the page numbers.
 * A filtered queue is numbered with its parent's people, the alias `/api/queue-people` makes.
 * The catalog, the full queue and the history all name a queue through this.
 */
export async function nativeQueueTitles(): Promise<Map<string, string>> {
  const registry = await sets.getRegistry(),
    audiences = membersByQueue();
  const numbers = queueListNumbers(
    registry.sets,
    Object.fromEntries(
      registry.sets.map((s) => [s.id, audiences.get(s.filtered_from || s.id) ?? []]),
    ),
  );
  return new Map(registry.sets.map((s) => [s.id, queueTitle(s, numbers.get(s.id) ?? null)]));
}

export async function nativeQueues(selected: readonly string[]): Promise<unknown> {
  const registry = await sets.getRegistry(),
    audiences = membersByQueue();
  // THE SAME TITLE THE WEB QUEUES PAGE PRINTS. This used to print "Movies & Shows · N" for
  // every Plex queue, named or not.
  const titles = await nativeQueueTitles();
  const homeUsers = await nativeHomeUsers();
  const routingSets = routing.loadSets()?.sets || {};
  // WHOM EACH QUEUE PLAYS AS, for display only. The TV never gates on it any more: the server
  // plays each queue as this profile whoever is signed in (`nativeAccess.authorizeQueue`).
  const playsAs = (id: string, required?: string | null): string | null => {
    const cfg = routingSets[id];
    const user = cfg ? queuePlayAs(cfg, homeUsers) : null;
    return user ? user.name || profileNameOf(user) : required || null;
  };
  const people = listPeople();
  const groups = storedGroups();
  const nameOf = (member: { kind: string; id: string }): string =>
    member.kind === "group"
      ? (groups.find((g) => g.id === member.id)?.label ?? member.id)
      : (people.find((p) => p.id === member.id)?.displayName ?? member.id);
  const queues = registry.sets
    // A superseded legacy tier is out of every web picker, so it is out of this one too. Its id
    // still plays through `createNativePlan` — hiding it from the catalog is not refusing it.
    .filter(
      (s) =>
        (s.provider_kind || providerIdForSet({ ...s })) === "plex" &&
        isSetAvailable(s) &&
        !isSupersededTier(s),
    )
    .map((s) => ({ s, members: nativeAudience(audiences.get(s.filtered_from || s.id) ?? []) }))
    .filter(({ members }) => queueMatchesSelection(members, selected))
    .map(({ s, members }) => ({
      id: s.id,
      activity: "watching",
      title: titles.get(s.id) ?? s.id,
      kind: wireKindForSet(s),
      people: [...new Set(members.flatMap((m) => m.people))],
      audience: audienceText(members, nameOf),
      playsAs: playsAs(s.id, s.requires_profile),
      isLocked: isQueueLocked(s),
    }));
  return {
    queues,
    people: people.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      avatar: `/api/native/people/${encodeURIComponent(p.id)}/avatar`,
    })),
  };
}

const grants = new Map<string, { proof: string; servers: Map<string, PlexServerAccess> }>();
/**
 * The plan's grant for one server, for its QUEUE'S profile. After a restart the grant is minted
 * again from the owner's token (`nativeScopeProof`) and checked against the plan's profile. The
 * TV's own token is deliberately not an input: it names the device, and a queue playing as
 * somebody else must never scrobble to the device's account.
 */
async function grantForPlan(plan: NativePlan, serverId: string): Promise<PlexServerAccess> {
  let cached = grants.get(plan.id);
  if (!cached) {
    const credential = await nativeScopeProof(plan.profileUuid);
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
  caller: NativeCaller | string,
  start?: NativeStart | null,
): Promise<NativePlanResponse> {
  return planForQueue(setId, await nativeDevice(caller), undefined, start);
}
/** `device` null: a continuation of a sitting its session key already authorized. */
async function planForQueue(
  setId: string,
  device: NativeDevice | null,
  previous?: NativePlan,
  start?: NativeStart | null,
): Promise<NativePlanResponse> {
  const queueAccess = await authorizeQueue(setId, device);
  const { cfg, binding, profile, profileName, credential, home, servers, selector, serverFor } =
    queueAccess;
  const identity = { machineIdentifier: queueAccess.homeServerId };
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
  let lineup = result.play as PlexPlayItem[];
  let led = result.led || [];
  let headOffset = result.offset || 0;
  if (start) {
    // A picked item replaces the head of the lineup; nothing before it is marked or skipped.
    if (cfg.source !== "queue")
      throw new NativeRequestError("Only a Picks queue can start from an item", 409);
    const desc = resolve.loadEntries(setId).find((entry) => entry.key === start.entryKey);
    if (!desc) throw new NativeRequestError("That entry is not in this queue", 404);
    const watched = await select.watchedForSet(queueAccess.client, cfg, binding);
    lineup = spliceStart(await expandEntry(queueAccess, desc, watched), start, lineup);
    // The queue did not LEAD this sitting, the viewer chose. No lead window is spent.
    led = [];
    headOffset = 0;
  }
  if (!lineup.length) throw new Error("This queue has nothing left to play");
  const target = previous ? previous.target : playbackLength(cfg);
  const remaining = !previous || target == null ? 2000 : Math.max(0, target - previous.handed);
  const seen = new Set(previous?.seen || []);
  const selection = lineup
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
            ? headOffset || Number(md.viewOffset) || 0
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
    led,
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
    refill:
      start?.mode !== "only" &&
      (target === null || (previous?.handed || 0) + items.length < target),
    createdAt: Date.now(),
  };
  const sessionKey = randomBytes(32).toString("base64url");
  prepareChecked(
    bookOfRecord(),
    "INSERT INTO native_tv_sessions (id, key_hash, data) VALUES (:id, :key_hash, :data)",
  ).run({ id: plan.id, key_hash: hash(sessionKey), data: JSON.stringify(plan) });
  grants.set(plan.id, { proof: credential, servers });
  const playback: NativePlaybackGrant[] = [];
  for (const serverId of new Set([home.id, ...items.map((item) => item.plexServer || home.id)])) {
    const access = await serverFor(serverId);
    playback.push({ serverId, baseUrl: access.baseUrl, token: access.token });
  }
  return { ...plan, sessionKey, grants: playback };
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
      const access = await grantForPlan(plan, item.plexServer || plan.homeServerId || "");
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
        const home = await grantForPlan(plan, plan.homeServerId || "");
        const scoped = plexProvider({
          client: nativeClient(home),
          clientForServer: async (id) => nativeClient(await grantForPlan(plan, id)),
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
          "INSERT INTO native_tv_events(session_id,id,sequence,data,recorded_at) VALUES(:session_id,:id,:sequence,:data,:recorded_at)",
        ).run({
          session_id: id,
          id: event.id,
          sequence: event.sequence,
          data: JSON.stringify(event),
          recorded_at: Date.now(),
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
): Promise<NativePlanResponse | { complete: true }> {
  const previous = readNativePlan(id, key);
  if (previous.cursor !== previous.items.length)
    throw new Error("The current lineup has not finished");
  if (!previous.refill) return { complete: true };
  try {
    // The session key is the authorization; the queue is resolved again, so the refill plays
    // as whatever profile the queue is configured for now.
    return await planForQueue(previous.setId, null, previous);
  } catch (error) {
    if (error instanceof Error && /nothing left|no new eligible/i.test(error.message))
      return { complete: true };
    throw error;
  }
}

/**
 * The WHOLE ordered queue, read as the queue's own profile: every entry, every item, watched
 * ones included, with where tonight's lineup ends. Same authorization as starting a session.
 */
export async function nativeFullQueue(
  setId: string,
  caller: NativeCaller | string,
): Promise<FullQueue> {
  const access = await authorizeQueue(setId, await nativeDevice(caller));
  const titles = await nativeQueueTitles();
  return fullQueueFor(access, titles.get(setId) ?? setId);
}

/**
 * The household's watch history, queue → sitting → items, for EVERY queue — not one profile's.
 * A queue locked on the TV is left out unless this device holds a valid unlock, and the count
 * left out is returned so the TV can say so rather than show a silently short list.
 */
export async function nativeWatchHistory(
  caller: NativeCaller | string,
  days: number,
): Promise<NativeHistory> {
  const device = await nativeDevice(caller);
  const titles = await nativeQueueTitles();
  const registry = await sets.getRegistry();
  const isUnlockedHere = isUnlocked(device);
  const hidden = new Set(
    registry.sets.filter((s) => isQueueLocked(s) && !isUnlockedHere).map((s) => s.id),
  );
  return historyFor(device.account, days, (setId) => titles.get(setId) ?? setId, {
    isHidden: (setId) => hidden.has(setId),
  });
}

export interface NativeWatchedMark {
  entryKey: string;
  ratingKey: string;
  plexServer?: string | null;
  isWatched: boolean;
}

/**
 * Mark one item of a queue-owned (`watch_history: queue`) entry watched or unwatched.
 *
 * The queue's private ledger is the only watched state QueuePilot writes, so a provider-history
 * entry is refused: its watched mark lives in Plex, and nothing here scrobbles to Plex. Marking
 * watched is the web's "complete one leaf"; marking unwatched forgets that item's row (its
 * position too) and clears the entry's `done`, so the engine offers the item again. Either way
 * the ordinary reconcile then decides whether the entry as a whole is finished.
 */
export async function nativeMarkWatched(
  setId: string,
  caller: NativeCaller | string,
  mark: NativeWatchedMark,
): Promise<{ entryKey: string; ratingKey: string; state: "watched" | "unwatched" }> {
  const access = await authorizeQueue(setId, await nativeDevice(caller));
  if (access.cfg.source !== "queue")
    throw new NativeRequestError("Only a Picks queue item can be marked watched", 409);
  const desc = resolve.loadEntries(setId).find((entry) => entry.key === mark.entryKey);
  if (!desc?.key) throw new NativeRequestError("That entry is not in this queue", 404);
  // A queue-owned entry reads its state from the ledger, so no Plex watched set is needed.
  const entry = await expandEntry(access, desc, new Set());
  if (entry.watchHistory !== "queue")
    throw new NativeRequestError(
      "This entry uses Plex's watch history. Mark it watched in Plex.",
      409,
    );
  const ratingKey = String(mark.ratingKey);
  if (
    !entry.items.some(
      (item) =>
        item.ratingKey === ratingKey && (item.plexServer || null) === (mark.plexServer || null),
    )
  )
    throw new NativeRequestError("That item is not in this queue entry", 404);
  if (mark.isWatched) queueHistory.markCompleted(setId, desc.key, ratingKey);
  else {
    queueHistory.clearItem(setId, desc.key, ratingKey);
    await queues.clearDone(setId, [desc.key]);
  }
  await finished.reconcileQueue(setId, access.profileName, {
    provider: access.selector,
    binding: access.binding,
    token: access.token,
  });
  await cache.bumpGeneration();
  return { entryKey: desc.key, ratingKey, state: mark.isWatched ? "watched" : "unwatched" };
}

export interface NativeQueueAdd {
  ratingKey: string;
  /** The TV's own server; the home server's id, or none, adds a home-server item. */
  plexServer?: string | null;
}

/**
 * Add one movie or show to a Picks queue, from the TV's title screen.
 *
 * Same authorization as starting the queue: any household device, plus the TV PIN for a locked
 * queue. The item is read through the QUEUE'S profile grant first, so a title the queue's
 * profile cannot see is never written; the add itself is the web route's (`addQueueItem`): remote-server check, duplicate
 * guard, then `queues.addItem` at the top, where the web's search adds it. A Rules queue picks
 * its own titles and refuses with 409.
 */
export async function nativeAddToQueue(
  setId: string,
  caller: NativeCaller | string,
  add: NativeQueueAdd,
): Promise<{ added: boolean; key: string; duplicateOf?: string; title: string }> {
  const access = await authorizeQueue(setId, await nativeDevice(caller));
  if (access.cfg.source !== "queue")
    throw new NativeRequestError(
      "A Rules queue chooses its own titles. Add this to a Picks queue.",
      409,
    );
  const ratingKey = String(add.ratingKey);
  if (!/^[0-9]+$/.test(ratingKey)) throw new NativeRequestError("Send a numeric ratingKey", 400);
  const remote = add.plexServer && add.plexServer !== access.homeServerId ? add.plexServer : null;
  const server = remote ? await access.serverFor(remote) : access.home;
  const metadata = await nativeClient(server).container(
    `/library/metadata/${ratingKey}`,
    server.token,
  );
  const item = metadata.Metadata?.[0] as { type?: string; title?: string } | undefined;
  if (!item) throw new NativeRequestError("That title is not available to this profile", 404);
  if (item.type !== "movie" && item.type !== "show")
    throw new NativeRequestError("Only a movie or a show can be added to a queue", 400);
  const title = String(item.title || ratingKey);
  try {
    const result = await addQueueItem(
      setId,
      { ratingKey, title, ...(remote ? { plex_server: remote } : {}) },
      "top",
    );
    return { ...result, title };
  } catch (error) {
    // A stated 400 keeps its status; the 403 (the queue profile cannot reach that server) and
    // anything else fall through to the 403 every native refusal answers.
    if (error instanceof QueueAddError && error.status === 400)
      throw new NativeRequestError(error.message, 400);
    throw error;
  }
}
