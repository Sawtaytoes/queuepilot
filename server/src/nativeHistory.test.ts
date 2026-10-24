import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./store/schema.generated.js";

const f = vi.hoisted(() => ({
  db: null as unknown as DatabaseSync,
  routing: {} as Record<string, Record<string, unknown>>,
  bindings: {} as Record<string, { user_uuid: string | null; account_id: number | null }>,
}));
vi.mock("./store/db/open.js", async () => {
  const original = await vi.importActual<typeof import("./store/db/open.js")>("./store/db/open.js");
  return { ...original, bookOfRecord: () => f.db };
});
vi.mock("./engine/routing.js", () => ({
  loadSets: () => ({ sets: f.routing }),
  bindingFor: (cfg: { id: string }) => f.bindings[cfg.id] ?? { user_uuid: null, account_id: 1 },
}));
vi.mock("./engine/resolve.js", () => ({ loadEntries: () => [] }));
vi.mock("./engine/plex-live.js", () => ({
  liveClient: () => ({ container: async () => ({ machineIdentifier: "fixture-home-server" }) }),
}));
vi.mock("./nativeAccess.js", () => ({
  // The real one is `nativeAccess.queuePlayAs`; history only needs "who can read this queue".
  queuePlayAs: (cfg: { requires_profile?: string }, users: { name: string; admin: boolean }[]) =>
    cfg.requires_profile
      ? (users.find((u) => u.name === cfg.requires_profile) ?? null)
      : (users.find((u) => u.admin) ?? null),
}));
vi.mock("./nativePlex.js", () => ({
  nativeHomeUsers: async () => [
    { id: 1, uuid: null, admin: true, restricted: false, name: "Ada", username: "ada" },
    { id: 2, uuid: "grace-uuid", admin: false, restricted: true, name: "Grace", username: null },
  ],
  nativeScopeProof: async (uuid: string | null) => (uuid ? "fixture-child" : "fixture-owner"),
  nativeGrant: async (_proof: string, id: string) => ({ id, token: "fixture-server-token" }),
  nativeClient: () => ({
    container: async () => ({
      Metadata: [
        {
          ratingKey: "501",
          title: "Lantern Walk",
          type: "episode",
          grandparentTitle: "Harbor Tales",
          parentIndex: 1,
          index: 4,
          duration: 1300000,
        },
      ],
    }),
  }),
}));

import {
  groupHistory,
  historyFor,
  ledgerPlays,
  householdPlays,
  nativePlays,
  type HistoryPlay,
} from "./nativeHistory.js";
import type { HomeUser } from "./plex.js";

const ada: HomeUser = { id: 1, uuid: null, admin: true, restricted: false, name: "Ada", username: "ada" };
const grace: HomeUser = {
  id: 2,
  uuid: "grace-uuid",
  admin: false,
  restricted: true,
  name: "Grace",
  username: null,
};
const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 22, 20, 0, 0);

const play = (setId: string, ratingKey: string, startedAt: number, endedAt = startedAt): HistoryPlay => ({
  setId,
  entryKey: null,
  ratingKey,
  plexServer: null,
  title: ratingKey,
  show: null,
  season: null,
  episode: null,
  type: "movie",
  startedAt,
  endedAt,
  state: "finished",
  positionMs: 0,
  durationMs: 0,
  source: "native-tv",
  isTimeApproximate: false,
});

function session(
  id: string,
  plan: Record<string, unknown>,
  events: { index: number; state: string; positionMs: number; at: number | null }[],
): void {
  f.db
    .prepare("INSERT INTO native_tv_sessions(id,key_hash,data) VALUES(?,?,?)")
    .run(id, `hash-${id}`, JSON.stringify({ id, ...plan }));
  events.forEach((event, sequence) =>
    f.db
      .prepare(
        "INSERT INTO native_tv_events(session_id,id,sequence,data,recorded_at) VALUES(?,?,?,?,?)",
      )
      .run(
        id,
        `${id}-${sequence}`,
        sequence + 1,
        JSON.stringify({ ...event, id: `${id}-${sequence}`, sequence: sequence + 1, durationMs: 1400000 }),
        event.at,
      ),
  );
}

beforeEach(() => {
  f.db = new DatabaseSync(":memory:");
  f.db.exec(SCHEMA_SQL);
  f.routing = {
    family_shows: { id: "family_shows", source: "queue" },
    grace_films: { id: "grace_films", source: "queue", requires_profile: "Grace" },
  };
  f.bindings = {};
});

describe("native TV watch history", () => {
  it("groups one queue's plays into sittings split by a gap over 75 minutes", () => {
    const start = NOW - 10 * 3600_000;
    const queues = groupHistory(
      [
        play("family_shows", "a", start, start + 25 * MINUTE),
        // Exactly 75 minutes after the last one ended: the same sitting.
        play("family_shows", "b", start + 100 * MINUTE, start + 125 * MINUTE),
        // 76 minutes later: a new sitting.
        play("family_shows", "c", start + 201 * MINUTE, start + 225 * MINUTE),
        play("grace_films", "d", start + 300 * MINUTE, start + 400 * MINUTE),
      ],
      (setId) => `Title of ${setId}`,
    );
    expect(queues.map((queue) => queue.setId)).toEqual(["grace_films", "family_shows"]);
    const family = queues[1]!;
    expect(family.title).toBe("Title of family_shows");
    // Newest sitting first; items stay in watch order inside a sitting.
    expect(family.sittings.map((sitting) => sitting.items.map((item) => item.ratingKey))).toEqual([
      ["c"],
      ["a", "b"],
    ]);
    expect(family.sittings[1]).toMatchObject({ startedAt: start, endedAt: start + 125 * MINUTE });
    expect(family.lastWatchedAt).toBe(start + 225 * MINUTE);
  });

  it("reads native plays from session events, finished or partial", () => {
    const at = NOW - 3600_000;
    session(
      "s1",
      {
        setId: "family_shows",
        profileUuid: null,
        createdAt: at - MINUTE,
        expiresAt: NOW,
        items: [
          { ratingKey: "501", title: "Lantern Walk", show: "Harbor Tales", season: 1, episode: 4, type: "episode", queueEntryKey: "harbor-tales" },
          { ratingKey: "502", title: "Tide Clock", show: "Harbor Tales", season: 1, episode: 5, type: "episode", queueEntryKey: "harbor-tales" },
          { ratingKey: "503", title: "Never Started", type: "episode" },
        ],
      },
      [
        { index: 0, state: "playing", positionMs: 0, at },
        { index: 0, state: "ended", positionMs: 1400000, at: at + 23 * MINUTE },
        { index: 1, state: "playing", positionMs: 0, at: at + 24 * MINUTE },
        { index: 1, state: "stopped", positionMs: 300000, at: at + 29 * MINUTE },
      ],
    );
    const plays = nativePlays(NOW - 24 * 3600_000);
    expect(
      plays.map(({ ratingKey, state, positionMs, startedAt, endedAt, entryKey }) => ({
        ratingKey,
        state,
        positionMs,
        startedAt,
        endedAt,
        entryKey,
      })),
    ).toEqual([
      { ratingKey: "501", state: "finished", positionMs: 1400000, startedAt: at, endedAt: at + 23 * MINUTE, entryKey: "harbor-tales" },
      { ratingKey: "502", state: "partial", positionMs: 300000, startedAt: at + 24 * MINUTE, endedAt: at + 29 * MINUTE, entryKey: "harbor-tales" },
    ]);
  });

  it("dates a play recorded before event times existed by its session, and says so", () => {
    session(
      "legacy",
      { setId: "family_shows", profileUuid: null, expiresAt: NOW + 20 * 3600_000, items: [{ ratingKey: "501" }] },
      [{ index: 0, state: "playing", positionMs: 0, at: null }],
    );
    const [legacy] = nativePlays(NOW - 24 * 3600_000);
    expect(legacy).toMatchObject({ isTimeApproximate: true, startedAt: NOW - 4 * 3600_000 });
  });

  it("counts a ledger row for every queue, whoever it plays as", () => {
    const completed = Math.floor((NOW - 3600_000) / 1000);
    const insert = f.db.prepare(
      `INSERT INTO queue_entry_history(set_id,entry_key,item_key,completed_at,is_completed,position_ms,duration_ms)
       VALUES(?,?,?,?,?,?,?)`,
    );
    insert.run("grace_films", "lighthouse", "601", completed, 1, 0, 0);
    insert.run("family_shows", "harbor-tales", "501", completed, 1, 0, 0);
    // A partial position has no time, so it never reaches the history.
    insert.run("grace_films", "lighthouse", "602", 0, 0, 500000, 6000000);
    // A queue the registry no longer knows is not a queue anybody can open.
    insert.run("retired_queue", "gone", "701", completed, 1, 0, 0);
    const rows = ledgerPlays(NOW - 24 * 3600_000, f.routing as never, () => null);
    expect(rows.map((row) => [row.setId, row.ratingKey, row.endedAt, row.source]).sort()).toEqual([
      ["family_shows", "501", completed * 1000, "queue-ledger"],
      ["grace_films", "601", completed * 1000, "queue-ledger"],
    ]);
  });

  it("keeps every profile's native plays and drops the ledger row a native play wrote", () => {
    const at = NOW - 3600_000;
    const owners = { ...play("family_shows", "501", at, at + 20 * MINUTE), entryKey: "harbor-tales", profileUuid: null };
    const childs = { ...play("grace_films", "601", at, at + 90 * MINUTE), profileUuid: "grace-uuid" };
    const echo = { ...play("family_shows", "501", at + 21 * MINUTE), entryKey: "harbor-tales", source: "queue-ledger" as const };
    const elsewhere = { ...play("family_shows", "502", at + 120 * MINUTE), entryKey: "harbor-tales", source: "queue-ledger" as const };
    const kept = householdPlays([owners, childs], [echo, elsewhere]);
    expect(kept.map((p) => [p.ratingKey, p.source])).toEqual([
      ["501", "native-tv"],
      ["601", "native-tv"],
      ["502", "queue-ledger"],
    ]);
    expect(kept.every((p) => !("profileUuid" in p))).toBe(true);
  });

  it("answers queue, sitting, and item for every queue, titled through each queue's profile", async () => {
    const completed = Math.floor((NOW - 2 * 3600_000) / 1000);
    const insert = f.db.prepare(
      `INSERT INTO queue_entry_history(set_id,entry_key,item_key,completed_at,is_completed,position_ms,duration_ms)
       VALUES(?,?,?,?,1,0,0)`,
    );
    insert.run("family_shows", "harbor-tales", "501", completed);
    insert.run("grace_films", "lighthouse", "501", completed);
    const history = await historyFor(grace, 30, (setId) => `Title of ${setId}`, { now: NOW });
    expect(history).toMatchObject({
      // The signed-in account is reported, and does NOT filter what is returned.
      profile: { uuid: "grace-uuid", name: "Grace" },
      hiddenLockedQueues: 0,
      sittingGapMinutes: 75,
      since: NOW - 30 * 24 * 3600_000,
    });
    expect(history.queues.map((q) => q.title).sort()).toEqual([
      "Title of family_shows",
      "Title of grace_films",
    ]);
    expect(history.queues[0]?.sittings[0]?.items[0]).toMatchObject({
      ratingKey: "501",
      title: "Lantern Walk",
      show: "Harbor Tales",
      season: 1,
      episode: 4,
      source: "queue-ledger",
    });
  });

  it("leaves out a queue the device may not see, and says how many it left out", async () => {
    const completed = Math.floor((NOW - 2 * 3600_000) / 1000);
    const insert = f.db.prepare(
      `INSERT INTO queue_entry_history(set_id,entry_key,item_key,completed_at,is_completed,position_ms,duration_ms)
       VALUES(?,?,?,?,1,0,0)`,
    );
    insert.run("family_shows", "harbor-tales", "501", completed);
    insert.run("grace_films", "lighthouse", "601", completed);
    const history = await historyFor(ada, 30, (setId) => setId, {
      isHidden: (setId) => setId === "grace_films",
      now: NOW,
    });
    expect(history.queues.map((q) => q.setId)).toEqual(["family_shows"]);
    expect(history.hiddenLockedQueues).toBe(1);
  });
});
