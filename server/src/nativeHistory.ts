/**
 * The native TV's WATCH HISTORY: queue → sitting → what was watched in that queue sitting, for
 * one verified Plex profile (decision `2026-10-22-the-native-full-queue-history-and-watched-api`).
 *
 * ⚠️ WHICH PLAYS COUNT — exactly two records, both already written by QueuePilot:
 *
 *  1. A NATIVE TV PLAY: an item of a native session (`native_tv_sessions`) that received at
 *     least one `playing` event (`native_tv_events`). It belongs to the profile the session was
 *     verified as. Finished when an `ended` or `section-end` event arrived; otherwise partial,
 *     at the last reported position.
 *  2. A QUEUE-LEDGER COMPLETION: a `queue_entry_history` row with `is_completed = 1` and a
 *     non-zero `completed_at`. That ledger exists only for `watch_history: queue` entries, and
 *     it is written when QueuePilot attributes a play to the entry — a play QueuePilot started
 *     on another Plex app, a Plex play the web's "Track the current Plex play here" adopted, a
 *     native play, or a manual "Mark watched" (the ledger cannot tell the last one apart). The
 *     ledger is per QUEUE, not per profile, so a row counts for the profile the queue PLAYS AS:
 *     its `requires_profile`, or the server owner for an ungated queue. A ledger row within
 *     `LEDGER_DUPLICATE_MS` of a native play of the same item in the same queue is that native
 *     play's own completion and is dropped.
 *
 * Nothing else counts. A Plex play of an item on a `watch_history: provider` entry is in Plex's
 * history, not in any queue's, so no queue tracks it; a partial ledger position carries no time;
 * a gated-push row says what was SENT to a screen, not what was watched.
 */
import { bookOfRecord, prepareChecked } from "./store/db/open.js";
import * as routing from "./engine/routing.js";
import * as resolve from "./engine/resolve.js";
import { liveClient } from "./engine/plex-live.js";
import { nativeClient, nativeGrant } from "./nativePlex.js";
import type * as plex from "./plex.js";
import type { NativeEvent, NativePlan } from "./nativeTv.js";
import type { RoutingSetCfg } from "./types.js";

/** A gap longer than this between two plays of one queue starts a new sitting. */
export const SITTING_GAP_MINUTES = 75;
const SITTING_GAP_MS = SITTING_GAP_MINUTES * 60_000;
/** How close a ledger completion must be to a native play to be that play's own write. */
export const LEDGER_DUPLICATE_MS = 15 * 60_000;
const DAY_MS = 24 * 3600_000;

export interface HistoryPlay {
  setId: string;
  entryKey: string | null;
  ratingKey: string;
  plexServer: string | null;
  title: string | null;
  show: string | null;
  season: number | null;
  episode: number | null;
  type: string | null;
  /** Epoch ms. A ledger completion knows only when it finished, so both are that moment. */
  startedAt: number;
  endedAt: number;
  state: "finished" | "partial";
  positionMs: number;
  durationMs: number;
  source: "native-tv" | "queue-ledger";
  /** A native play recorded before event times were stored: dated by its session's start. */
  isTimeApproximate: boolean;
}

interface OwnedPlay extends HistoryPlay {
  /** The profile a native play was verified as; undefined for a ledger row. */
  profileUuid?: string | null;
}

export interface HistorySitting {
  startedAt: number;
  endedAt: number;
  items: HistoryPlay[];
}

export interface HistoryQueue {
  setId: string;
  title: string;
  lastWatchedAt: number;
  sittings: HistorySitting[];
}

export interface NativeHistory {
  profile: { uuid: string | null; name: string };
  sittingGapMinutes: number;
  since: number;
  queues: HistoryQueue[];
}

/** Every native TV play, of every profile, since `since`. */
export function nativePlays(since: number): OwnedPlay[] {
  const db = bookOfRecord();
  const sessions = prepareChecked<{ id: string; data: string }>(
    db,
    "SELECT id, data FROM native_tv_sessions",
  ).all({});
  const eventRows = prepareChecked<{
    session_id: string;
    sequence: number;
    data: string;
    recorded_at: number | null;
  }>(db, "SELECT session_id, sequence, data, recorded_at FROM native_tv_events ORDER BY session_id, sequence").all({});
  const eventsBySession = new Map<string, typeof eventRows>();
  for (const row of eventRows)
    eventsBySession.set(row.session_id, [...(eventsBySession.get(row.session_id) ?? []), row]);
  const plays: OwnedPlay[] = [];
  for (const session of sessions) {
    let plan: NativePlan;
    try {
      plan = JSON.parse(session.data) as NativePlan;
    } catch {
      continue;
    }
    const createdAt = plan.createdAt ?? plan.expiresAt - DAY_MS;
    const byIndex = new Map<number, { event: NativeEvent; at: number | null }[]>();
    for (const row of eventsBySession.get(session.id) ?? []) {
      let event: NativeEvent;
      try {
        event = JSON.parse(row.data) as NativeEvent;
      } catch {
        continue;
      }
      byIndex.set(event.index, [...(byIndex.get(event.index) ?? []), { event, at: row.recorded_at }]);
    }
    for (const [index, events] of byIndex) {
      const item = plan.items[index];
      if (!item || !events.some(({ event }) => event.state === "playing")) continue;
      const times = events.map(({ at }) => at).filter((at): at is number => at != null);
      const isTimeApproximate = times.length === 0;
      const startedAt = isTimeApproximate ? createdAt : Math.min(...times);
      const endedAt = isTimeApproximate ? createdAt : Math.max(...times);
      if (endedAt < since) continue;
      const last = events.at(-1)!.event;
      plays.push({
        setId: plan.setId,
        entryKey: item.queueEntryKey ?? null,
        ratingKey: String(item.ratingKey),
        plexServer: item.plexServer || null,
        title: item.title ?? null,
        show: item.show ?? null,
        season: item.season ?? null,
        episode: item.episode ?? null,
        type: item.type ?? null,
        startedAt,
        endedAt,
        state: events.some(({ event }) => event.state === "ended" || event.state === "section-end")
          ? "finished"
          : "partial",
        positionMs: Math.round(last.positionMs),
        durationMs: Math.round(last.durationMs),
        source: "native-tv",
        isTimeApproximate,
        profileUuid: plan.profileUuid,
      });
    }
  }
  return plays;
}

/** Does this queue PLAY AS this profile when nobody picks one? */
export function queuePlaysAs(cfg: RoutingSetCfg, profile: plex.HomeUser): boolean {
  if (cfg.requires_profile)
    return [profile.name, profile.username].includes(cfg.requires_profile);
  const binding = routing.bindingFor(cfg);
  if (binding.user_uuid) return binding.user_uuid === profile.uuid;
  if (binding.account_id == null || binding.account_id === 1) return profile.admin;
  return binding.account_id === profile.id;
}

/** Ledger completions since `since` for the queues that play as this profile. */
export function ledgerPlays(
  since: number,
  cfgs: Readonly<Record<string, RoutingSetCfg>>,
  profile: plex.HomeUser,
  entryServer: (setId: string, entryKey: string) => string | null,
): HistoryPlay[] {
  const rows = prepareChecked<{
    set_id: string;
    entry_key: string;
    item_key: string;
    completed_at: number;
  }>(
    bookOfRecord(),
    `SELECT set_id, entry_key, item_key, completed_at FROM queue_entry_history
     WHERE is_completed = 1 AND completed_at >= :since`,
  ).all({ since: Math.max(1, Math.floor(since / 1000)) });
  return rows
    .filter((row) => cfgs[row.set_id] && queuePlaysAs(cfgs[row.set_id]!, profile))
    .map((row) => ({
      setId: row.set_id,
      entryKey: row.entry_key,
      ratingKey: String(row.item_key),
      plexServer: entryServer(row.set_id, row.entry_key),
      title: null,
      show: null,
      season: null,
      episode: null,
      type: null,
      startedAt: row.completed_at * 1000,
      endedAt: row.completed_at * 1000,
      state: "finished" as const,
      positionMs: 0,
      durationMs: 0,
      source: "queue-ledger" as const,
      isTimeApproximate: false,
    }));
}

/** One item of one queue. A home-server item carries no server id, so the entry key decides. */
const sameItem = (a: HistoryPlay, b: HistoryPlay): boolean =>
  a.setId === b.setId &&
  a.ratingKey === b.ratingKey &&
  (a.entryKey == null || b.entryKey == null || a.entryKey === b.entryKey);

/**
 * Group plays into queue → sitting. Pure.
 *
 * A SITTING is the plays of ONE queue in time order, cut wherever the next play starts more
 * than `SITTING_GAP_MINUTES` after the previous one ended. Queues are ordered by their latest
 * play, sittings and items newest first within a queue's list but items stay in watch order
 * inside their sitting.
 */
export function groupHistory(
  plays: readonly HistoryPlay[],
  titleOf: (setId: string) => string,
): HistoryQueue[] {
  const bySet = new Map<string, HistoryPlay[]>();
  for (const play of plays) bySet.set(play.setId, [...(bySet.get(play.setId) ?? []), play]);
  const queues: HistoryQueue[] = [];
  for (const [setId, list] of bySet) {
    const sorted = [...list].sort((a, b) => a.startedAt - b.startedAt || a.endedAt - b.endedAt);
    const sittings: HistorySitting[] = [];
    for (const play of sorted) {
      const current = sittings.at(-1);
      if (current && play.startedAt - current.endedAt <= SITTING_GAP_MS) {
        current.items.push(play);
        current.endedAt = Math.max(current.endedAt, play.endedAt);
      } else {
        sittings.push({ startedAt: play.startedAt, endedAt: play.endedAt, items: [play] });
      }
    }
    sittings.reverse();
    queues.push({
      setId,
      title: titleOf(setId),
      lastWatchedAt: sittings[0]!.endedAt,
      sittings,
    });
  }
  return queues.sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);
}

/** Join both sources for one profile and drop the ledger rows a native play already wrote. */
export function profilePlays(
  profile: plex.HomeUser,
  native: readonly OwnedPlay[],
  ledger: readonly HistoryPlay[],
): HistoryPlay[] {
  const mine = native.filter((play) => (play.profileUuid || null) === (profile.uuid || null));
  const kept = ledger.filter(
    (row) =>
      !native.some(
        (play) => sameItem(play, row) && Math.abs(play.endedAt - row.endedAt) <= LEDGER_DUPLICATE_MS,
      ),
  );
  return [
    ...mine.map(({ profileUuid: _profileUuid, ...play }): HistoryPlay => play),
    ...kept,
  ];
}

/** Fill in titles for ledger rows from Plex, through this profile's own grants. */
async function describeLedgerPlays(proof: string, plays: HistoryPlay[]): Promise<void> {
  const missing = plays.filter((play) => play.title == null);
  if (!missing.length) return;
  const identity = (await liveClient().container("/identity")) as { machineIdentifier?: string };
  const byServer = new Map<string, HistoryPlay[]>();
  for (const play of missing) {
    const server = play.plexServer || identity.machineIdentifier || "";
    byServer.set(server, [...(byServer.get(server) ?? []), play]);
  }
  for (const [server, list] of byServer) {
    try {
      const access = await nativeGrant(proof, server);
      const keys = [...new Set(list.map((play) => play.ratingKey))];
      for (let at = 0; at < keys.length; at += 100) {
        const mc = await nativeClient(access).container(
          `/library/metadata/${keys.slice(at, at + 100).join(",")}`,
          access.token,
        );
        for (const md of (mc.Metadata || []) as Record<string, unknown>[]) {
          for (const play of list.filter((p) => p.ratingKey === String(md.ratingKey))) {
            play.title = typeof md.title === "string" ? md.title : null;
            play.type = typeof md.type === "string" ? md.type : null;
            play.show = typeof md.grandparentTitle === "string" ? md.grandparentTitle : null;
            play.season = typeof md.parentIndex === "number" ? md.parentIndex : null;
            play.episode = typeof md.index === "number" ? md.index : null;
            play.durationMs = typeof md.duration === "number" ? md.duration : 0;
          }
        }
      }
    } catch {
      // A server this profile cannot reach leaves those rows untitled rather than failing the page.
    }
  }
}

export async function historyFor(
  profile: plex.HomeUser,
  proof: string,
  days: number,
  titleOf: (setId: string) => string,
  now = Date.now(),
): Promise<NativeHistory> {
  const since = now - Math.max(1, Math.min(365, Math.floor(days) || 30)) * DAY_MS;
  const cfgs = routing.loadSets()?.sets ?? {};
  const servers = new Map<string, string | null>();
  const entryServer = (setId: string, entryKey: string): string | null => {
    const key = `${setId}\u0000${entryKey}`;
    if (!servers.has(key)) {
      let server: string | null = null;
      try {
        server = resolve.loadEntries(setId).find((entry) => entry.key === entryKey)?.plexServer ?? null;
      } catch {
        server = null;
      }
      servers.set(key, server);
    }
    return servers.get(key) ?? null;
  };
  const plays = profilePlays(
    profile,
    nativePlays(since),
    ledgerPlays(since, cfgs, profile, entryServer),
  );
  await describeLedgerPlays(proof, plays);
  return {
    profile: { uuid: profile.uuid, name: profile.admin ? profile.username || profile.name : profile.name },
    sittingGapMinutes: SITTING_GAP_MINUTES,
    since,
    queues: groupHistory(plays, titleOf),
  };
}
