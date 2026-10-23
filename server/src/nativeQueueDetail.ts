/**
 * The native TV's FULL QUEUE and its per-item actions — decision
 * `2026-10-22-the-native-full-queue-history-and-watched-api`.
 *
 * A session plays the engine's lineup WINDOW. This module answers the wider question the TV's
 * queue page asks: every item the queue still holds, in entry order, with what has been
 * watched, what is half-watched, what plays next, and where tonight's lineup ends.
 *
 * It reads; it never writes. The lineup it reports comes from the same `buckets()` call a
 * session makes, and every entry is expanded by the engine's own `resolveMember()` with the
 * batch cap and the shuffle taken off — so an item appears here exactly when the engine would
 * consider it, and nowhere does this file decide on its own what a queue contains.
 */
import * as resolve from "./engine/resolve.js";
import * as select from "./engine/select.js";
import { isRandomOrder, normalizeAddAs, normalizePlacement, wireKindForSet } from "./kind.js";
import { normalizeWatchHistory } from "./watchHistory.js";
import * as queueHistory from "./store/db/queueEntryHistory.js";
import { NativeRequestError, type QueueAccess } from "./nativeAccess.js";
import type { PlexClient, PlexPlayItem } from "./types.js";

/** Where a TV session starts when the viewer picks an item rather than the queue. */
export interface NativeStart {
  entryKey: string;
  ratingKey: string;
  plexServer?: string | null;
  /** `continue`: this item, then the rest of the queue. `only`: this item and nothing else. */
  mode: "continue" | "only";
}

export type NativeItemState = "watched" | "in_progress" | "unwatched";

/** Raw Plex image paths, relative to `serverId`. Fetch them with that server's grant. */
export interface NativeArtwork {
  thumb: string | null;
  parentThumb: string | null;
  grandparentThumb: string | null;
  art: string | null;
}

export interface FullQueueItem {
  /** Index in the flattened response, entry by entry. */
  position: number;
  ratingKey: string;
  /** The machine identifier the item and its artwork live on. */
  serverId: string;
  /** Set only for an item on a SHARED server; null for the home server. */
  plexServer: string | null;
  title: string | null;
  type: "movie" | "episode" | string;
  show: string | null;
  season: number | null;
  episode: number | null;
  /** A season-0 episode the queue plays inline (an OVA, a special). */
  isSpecial: boolean;
  durationMs: number | null;
  state: NativeItemState;
  /** Resume point for `in_progress`; 0 otherwise. */
  offsetMs: number;
  /** The authored window, on the entry's next unit only — the one the engine stamps. */
  section: { startMs: number | null; endMs: number | null } | null;
  /** Index in the current lineup, or null when this sitting's lineup does not include it. */
  lineupIndex: number | null;
  /** The item a plain "play this queue" starts with. */
  isNext: boolean;
  /** True when `POST …/watched` can change this item (queue-owned history only). */
  canMarkWatched: boolean;
  artwork: NativeArtwork;
}

export interface FullQueueEntry {
  /** The entry key a start or a watched mark names. Null for a Rules queue's lineup group. */
  entryKey: string | null;
  title: string;
  type: "movie" | "show" | "collection" | "lineup";
  lane: "priority" | "random" | null;
  watchHistory: "provider" | "queue";
  /** The engine plays this entry's items in a random order; `items` are listed in Plex order. */
  isShuffled: boolean;
  /** The entry could not be found in Plex this read. */
  isUnresolved: boolean;
  items: FullQueueItem[];
}

export interface FullQueue {
  setId: string;
  kind: "picks" | "rules";
  /** `grid` when more items are movies than episodes; otherwise `list` (a tie is `list`). */
  layout: "grid" | "list";
  /** False for a Rules queue: its eligible pool has no fixed order, so only the lineup shows. */
  isWholeQueue: boolean;
  /** The random lane is reshuffled every sitting, so a later session can pick another lineup. */
  isLineupShuffled: boolean;
  lineup: { count: number; endPosition: number | null };
  isTruncated: boolean;
  entries: FullQueueEntry[];
}

/** The cap on items a full-queue read returns, matching a session's own lineup cap. */
export const FULL_QUEUE_MAX_ITEMS = 2000;

const itemKey = (item: { plexServer?: string | null; ratingKey: string | number }): string =>
  `${item.plexServer || ""}:${item.ratingKey}`;

/** Count item types over the whole queue: more movies than episodes is a grid. */
export function layoutFor(items: readonly { type: string }[]): "grid" | "list" {
  let movies = 0,
    episodes = 0;
  for (const item of items) {
    if (item.type === "movie") movies++;
    else if (item.type === "episode") episodes++;
  }
  return movies > episodes ? "grid" : "list";
}

const emptyArtwork = (): NativeArtwork => ({
  thumb: null,
  parentThumb: null,
  grandparentThumb: null,
  art: null,
});

/** One entry expanded, before positions and lineup marks are assigned. */
export interface ExpandedEntry {
  desc: resolve.EntryDescriptor;
  title: string;
  type: "movie" | "show" | "collection";
  lane: "priority" | "random";
  watchHistory: "provider" | "queue";
  isUnresolved: boolean;
  items: Omit<FullQueueItem, "position" | "lineupIndex" | "isNext" | "serverId" | "artwork">[];
}

/**
 * Every item one entry holds, watched ones included, with the state the engine would read.
 *
 * `resolveMember()` is called with an EMPTY watched set, no batch cap and no shuffle, which is
 * the engine's own way of listing an entry whole. The state is then read the way `nextQueue()`
 * reads it: the queue's private ledger for a `watch_history: queue` entry, otherwise the
 * profile's Plex history (home server) or the item's play count (shared server).
 */
export async function expandEntry(
  access: Pick<QueueAccess, "setId" | "cfg" | "client" | "clientForServer" | "token">,
  desc: resolve.EntryDescriptor,
  watched: ReadonlySet<string>,
): Promise<ExpandedEntry> {
  const { cfg } = access;
  const addAs = normalizeAddAs(cfg.add_as, { kind: cfg.kind, source: cfg.source });
  const lane = normalizePlacement(desc.placement, addAs) === "priority" ? "priority" : "random";
  const watchHistory =
    (desc.watchHistory ?? normalizeWatchHistory((cfg as { watch_history?: unknown }).watch_history) ?? "provider") === "queue"
      ? "queue"
      : "provider";
  const base = {
    desc,
    lane,
    watchHistory,
    title: desc.title || desc.collection || desc.key || "",
  } as const;
  let client: PlexClient | null = access.client;
  if (desc.plexServer)
    client = await access.clientForServer(desc.plexServer).catch(() => null);
  const res = client
    ? await resolve.resolveMember(
        client,
        { ...desc, itemOrder: "in-order", episodes: null },
        cfg as resolve.ResolveCfg,
        new Set(),
        access.token,
        null,
        true,
        null,
        null,
      )
    : null;
  if (!res) return { ...base, type: "show", isUnresolved: true, items: [] };
  let raw: resolve.ResolvedItem[] = res.items;
  // A shared-server film counts as watched off its own play count, so the empty watched set
  // above does not keep a WATCHED one. List it anyway; its state is read below.
  if (res.type === "movie" && !raw.length && res.ratingKey)
    raw = [{ ratingKey: res.ratingKey, title: res.title, season: null, episode: null, viewCount: 1 }];
  const own =
    watchHistory === "queue" && desc.key
      ? queueHistory.progressFor(access.setId, desc.key)
      : null;
  const section = resolve.sectionOf(desc);
  let isSectionPlaced = false;
  const items = raw.map((item) => {
    const rk = String(item.ratingKey);
    const ledger = own?.get(rk);
    let state: NativeItemState = "unwatched";
    let offsetMs = 0;
    if (own) {
      if (ledger?.isCompleted) state = "watched";
      else if (ledger && ledger.positionMs > 0) {
        state = "in_progress";
        offsetMs = ledger.positionMs;
      }
    } else if (resolve.inProgress(item.viewOffset, item.viewCount)) {
      state = "in_progress";
      offsetMs = Number(item.viewOffset) || 0;
    } else if (desc.plexServer ? Number(item.viewCount) > 0 : watched.has(rk)) {
      state = "watched";
    }
    // The engine stamps the window on the first unit the entry CONTRIBUTES, which is its first
    // item that is not finished.
    const isSectionUnit = Boolean(section) && !isSectionPlaced && state !== "watched";
    if (isSectionUnit) isSectionPlaced = true;
    const type =
      res.type === "movie" ? "movie" : item.type || (item.season != null ? "episode" : "movie");
    return {
      ratingKey: rk,
      plexServer: desc.plexServer || null,
      title: item.title ?? null,
      type,
      show: item.show ?? null,
      season: item.season ?? null,
      episode: item.episode ?? null,
      isSpecial: type === "episode" && item.season === 0,
      durationMs: item.duration ?? null,
      state,
      offsetMs,
      section: isSectionUnit && section
        ? { startMs: section.sectionStartMs, endMs: section.sectionEndMs }
        : null,
      canMarkWatched: watchHistory === "queue" && Boolean(desc.key),
    };
  });
  return { ...base, title: res.title || base.title, type: res.type, isUnresolved: false, items };
}

/**
 * Turn expanded entries plus the current lineup into the response.
 *
 * Pure, so the ordering rules are tested without Plex: entries that the lineup draws from come
 * first, in lineup order; then the rest of the Priority lane, then the rest of the pool, each in
 * file order. A lineup item is matched to the FIRST entry holding that item that has not
 * already claimed it, which is what keeps one file listed twice (an entry `id`) apart.
 */
export function assembleFullQueue(
  setId: string,
  homeServerId: string,
  expanded: readonly ExpandedEntry[],
  lineup: readonly PlexPlayItem[],
  options: { isLineupShuffled: boolean },
  artwork: ReadonlyMap<string, NativeArtwork> = new Map(),
): FullQueue {
  const claims = new Map<string, { entry: number; item: number }[]>();
  expanded.forEach((entry, e) =>
    entry.items.forEach((item, i) => {
      const key = itemKey(item);
      claims.set(key, [...(claims.get(key) ?? []), { entry: e, item: i }]);
    }),
  );
  const lineupOf = new Map<string, number>();
  const firstLineupOfEntry = new Map<number, number>();
  lineup.forEach((raw, index) => {
    const slot = claims.get(itemKey(raw))?.shift();
    if (!slot) return;
    lineupOf.set(`${slot.entry}/${slot.item}`, index);
    if (!firstLineupOfEntry.has(slot.entry)) firstLineupOfEntry.set(slot.entry, index);
  });
  const order = expanded
    .map((_, e) => e)
    .sort((a, b) => {
      const la = firstLineupOfEntry.get(a),
        lb = firstLineupOfEntry.get(b);
      if (la != null || lb != null) return (la ?? Infinity) - (lb ?? Infinity) || a - b;
      const pa = expanded[a]!.lane === "priority" ? 0 : 1,
        pb = expanded[b]!.lane === "priority" ? 0 : 1;
      return pa - pb || a - b;
    });
  const nextKey = lineup[0] ? itemKey(lineup[0]) : null;
  let position = 0,
    endPosition: number | null = null,
    isTruncated = false,
    isNextPlaced = false;
  const entries: FullQueueEntry[] = [];
  for (const e of order) {
    const entry = expanded[e]!;
    const items: FullQueueItem[] = [];
    entry.items.forEach((item, i) => {
      if (position >= FULL_QUEUE_MAX_ITEMS) {
        isTruncated = true;
        return;
      }
      const lineupIndex = lineupOf.get(`${e}/${i}`) ?? null;
      const isNext = !isNextPlaced && lineupIndex === 0 && itemKey(item) === nextKey;
      if (isNext) isNextPlaced = true;
      if (lineupIndex != null) endPosition = position;
      items.push({
        ...item,
        position,
        serverId: item.plexServer || homeServerId,
        lineupIndex,
        isNext,
        artwork: artwork.get(itemKey(item)) ?? emptyArtwork(),
      });
      position++;
    });
    entries.push({
      entryKey: entry.desc.key,
      title: entry.title,
      type: entry.type,
      lane: entry.lane,
      watchHistory: entry.watchHistory,
      isShuffled: entry.desc.itemOrder === "shuffle",
      isUnresolved: entry.isUnresolved,
      items,
    });
  }
  return {
    setId,
    kind: "picks",
    layout: layoutFor(entries.flatMap((entry) => entry.items)),
    isWholeQueue: true,
    isLineupShuffled: options.isLineupShuffled,
    lineup: { count: lineup.length, endPosition },
    isTruncated,
    entries,
  };
}

/** A Rules queue has no stored order to list: its whole answer is the lineup. */
export function assembleRulesLineup(
  setId: string,
  homeServerId: string,
  title: string,
  lineup: readonly PlexPlayItem[],
  artwork: ReadonlyMap<string, NativeArtwork> = new Map(),
): FullQueue {
  const items: FullQueueItem[] = lineup.slice(0, FULL_QUEUE_MAX_ITEMS).map((item, index) => {
    const type = item.type || (item.season != null ? "episode" : "movie");
    return {
      position: index,
      ratingKey: String(item.ratingKey),
      serverId: item.plexServer || homeServerId,
      plexServer: item.plexServer || null,
      title: item.title ?? null,
      type,
      show: item.show ?? null,
      season: item.season ?? null,
      episode: item.episode ?? null,
      isSpecial: type === "episode" && item.season === 0,
      durationMs: item.duration ?? null,
      state: resolve.inProgress(item.viewOffset, 0) ? "in_progress" : "unwatched",
      offsetMs: Number(item.viewOffset) || 0,
      section: null,
      lineupIndex: index,
      isNext: index === 0,
      canMarkWatched: false,
      artwork: artwork.get(itemKey(item)) ?? emptyArtwork(),
    };
  });
  return {
    setId,
    kind: "rules",
    layout: layoutFor(items),
    isWholeQueue: false,
    isLineupShuffled: true,
    lineup: { count: items.length, endPosition: items.length ? items.length - 1 : null },
    isTruncated: lineup.length > FULL_QUEUE_MAX_ITEMS,
    entries: [
      {
        entryKey: null,
        title,
        type: "lineup",
        lane: null,
        watchHistory: "provider",
        isShuffled: true,
        isUnresolved: false,
        items,
      },
    ],
  };
}

/** Plex image paths for many items at once, one batched metadata read per server. */
export async function artworkFor(
  access: Pick<QueueAccess, "client" | "clientForServer" | "token">,
  items: readonly { ratingKey: string | number; plexServer?: string | null }[],
): Promise<Map<string, NativeArtwork>> {
  const out = new Map<string, NativeArtwork>();
  const byServer = new Map<string, string[]>();
  for (const item of items) {
    const server = item.plexServer || "";
    byServer.set(server, [...(byServer.get(server) ?? []), String(item.ratingKey)]);
  }
  for (const [server, keys] of byServer) {
    const client = server
      ? await access.clientForServer(server).catch(() => null)
      : access.client;
    if (!client) continue;
    const unique = [...new Set(keys)];
    for (let at = 0; at < unique.length; at += 100) {
      try {
        const mc = await client.container(
          `/library/metadata/${unique.slice(at, at + 100).join(",")}`,
          access.token,
        );
        for (const md of (mc.Metadata || []) as Record<string, unknown>[]) {
          const text = (field: string): string | null =>
            typeof md[field] === "string" ? (md[field] as string) : null;
          out.set(`${server}:${String(md.ratingKey)}`, {
            thumb: text("thumb"),
            parentThumb: text("parentThumb"),
            grandparentThumb: text("grandparentThumb"),
            art: text("art") ?? text("grandparentArt"),
          });
        }
      } catch {
        // Artwork is decoration. A failed read leaves these items without pictures.
      }
    }
  }
  return out;
}

/** The full queue for a profile that `authorizeQueue` already accepted. */
export async function fullQueueFor(access: QueueAccess, title: string): Promise<FullQueue> {
  const { setId, cfg, binding, token } = access;
  const lineup = (
    await access.selector.buckets({
      setName: setId,
      cfg,
      binding,
      token,
      kind: wireKindForSet(cfg),
    })
  ).play as PlexPlayItem[];
  if (cfg.source !== "queue")
    return assembleRulesLineup(
      setId,
      access.homeServerId,
      title,
      lineup,
      await artworkFor(access, lineup),
    );
  const watched = await select.watchedForSet(access.client, cfg, binding);
  const expanded: ExpandedEntry[] = [];
  for (const desc of resolve.loadEntries(setId))
    expanded.push(await expandEntry(access, desc, watched));
  const shaped = assembleFullQueue(setId, access.homeServerId, expanded, lineup, {
    isLineupShuffled: isRandomOrder(cfg),
  });
  const art = await artworkFor(
    access,
    shaped.entries.flatMap((entry) => entry.items),
  );
  for (const entry of shaped.entries)
    for (const item of entry.items)
      item.artwork = art.get(itemKey(item)) ?? item.artwork;
  return shaped;
}

/**
 * The lineup a picked item starts: the item, then (for `continue`) the rest of ITS entry that is
 * not finished, then the engine's own lineup without anything already taken and without this
 * entry's items that come before the pick.
 *
 * Items before the picked one are NOT marked and NOT skipped. They keep their state and stay in
 * the queue, so the next sitting the engine builds offers them again (private decision
 * "Start here leaves earlier unwatched items unwatched").
 */
export function spliceStart(
  entry: ExpandedEntry,
  start: NativeStart,
  lineup: readonly PlexPlayItem[],
): PlexPlayItem[] {
  const index = entry.items.findIndex(
    (item) =>
      item.ratingKey === String(start.ratingKey) &&
      (item.plexServer || null) === (start.plexServer || null),
  );
  if (index < 0) throw new NativeRequestError("That item is not in this queue entry", 404);
  const picked = [
    entry.items[index]!,
    ...(start.mode === "continue"
      ? entry.items.slice(index + 1).filter((item) => item.state !== "watched")
      : []),
  ].map((item) => {
    const play: PlexPlayItem & Record<string, unknown> = {
      ratingKey: item.ratingKey,
      title: item.title ?? undefined,
      show: item.show ?? undefined,
      season: item.season,
      episode: item.episode,
      type: item.type,
      ...(item.durationMs != null ? { duration: item.durationMs } : {}),
      ...(item.plexServer ? { plexServer: item.plexServer } : {}),
    };
    if (item.section) {
      play.sectionStartMs = item.section.startMs;
      play.sectionEndMs = item.section.endMs;
    }
    if (entry.watchHistory === "queue" && entry.desc.key) {
      play.queueEntryKey = entry.desc.key;
      play.queueOwnHistory = true;
    }
    return play;
  });
  if (start.mode === "only") return picked;
  // The engine's lineup may open with this entry's EARLIER items. They are left for a later
  // sitting rather than played straight after the pick, which would undo the choice.
  const taken = new Set([...picked, ...entry.items.slice(0, index)].map(itemKey));
  return [...picked, ...lineup.filter((item) => !taken.has(itemKey(item)))];
}
