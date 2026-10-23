import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./store/schema.generated.js";
const f = vi.hoisted(() => ({
  db: null as unknown as DatabaseSync,
  queues: [
    { id: "watch", provider_kind: "plex", enabled: true, source: "queue" },
    { id: "read", provider_kind: "kavita", enabled: true, source: "queue" },
  ] as { id: string; [field: string]: unknown }[],
  members: new Map(),
  rosters: new Map(),
  minimums: new Map(),
  provider: { kind: "plex", profileBinding: vi.fn(), profileToken: vi.fn(), buckets: vi.fn() },
  finalize: vi.fn(),
  reconcile: vi.fn(),
  timeline: vi.fn(),
  viewCount: 1,
  entries: [] as { key: string; [field: string]: unknown }[],
  resolveMember: vi.fn(),
  ledger: new Map<string, { isCompleted: boolean; positionMs: number; durationMs: number }>(),
  markCompleted: vi.fn(),
  clearItem: vi.fn(),
  clearDone: vi.fn(),
  bumpGeneration: vi.fn(),
  routing: {
    watch: { source: "queue", account_id: 1, enabled: true },
  } as Record<string, Record<string, unknown>>,
}));
vi.mock("./store/db/open.js", async () => {
  const original = await vi.importActual<typeof import("./store/db/open.js")>("./store/db/open.js");
  return { ...original, bookOfRecord: () => f.db };
});
vi.mock("./store/db/people.js", () => ({
  listPeople: () => [
    { id: "ada", displayName: "Ada" },
    { id: "grace", displayName: "Grace" },
  ],
  rosterMembersByGroup: () => f.rosters,
  minPresentByGroup: () => f.minimums,
  getPerson: () => null,
}));
vi.mock("./store/db/queuePeople.js", () => ({ membersByQueue: () => f.members }));
vi.mock("./sets.js", () => ({
  getRegistry: async () => ({ sets: f.queues }),
  getSet: async (id: string) => f.queues.find((q) => q.id === id),
}));
vi.mock("./engine/routing.js", () => ({
  loadSets: () => ({ sets: f.routing }),
  bindingFor: () => ({ user_uuid: null, account_id: 1 }),
}));
vi.mock("./providers/index.js", () => ({ providerFor: () => f.provider }));
vi.mock("./providers/blocks.js", () => ({ providerIdForSet: () => "plex" }));
vi.mock("./plex.js", () => ({
  homeUsers: async () => [
    { id: 1, uuid: null, admin: true, name: "Ada", username: "ada" },
    { id: 2, uuid: "grace-uuid", admin: false, name: "Grace" },
  ],
}));
vi.mock("./config.js", () => ({
  PLEX_TOKEN: "fixture-owner",
  PLEX_URL: "https://media.example.com",
  PLEX_CLIENT_IDENTIFIER: "fixture-client",
}));
vi.mock("./engine/plex-live.js", () => ({
  liveClient: () => ({
    container: async () => ({
      machineIdentifier: "fixture-home-server",
      Metadata: [{ viewCount: f.viewCount, duration: 30000, viewOffset: 4000 }],
    }),
  }),
}));
vi.mock("./providers/plex.js", () => ({ plexProvider: () => f.provider }));
vi.mock("./nativePlex.js", () => ({
  nativeHomeUsers: async () => [
    { id: 1, uuid: null, admin: true, name: "Ada", username: "ada" },
    { id: 2, uuid: "grace-uuid", admin: false, name: "Grace" },
  ],
  nativeVerifiedProfile: async (proof: string) => {
    if (!proof) throw new Error("Plex sign-in is required");
    return proof === "fixture-child"
      ? { id: 2, uuid: "grace-uuid", admin: false, name: "Grace" }
      : { id: 1, uuid: null, admin: true, name: "Ada", username: "ada" };
  },
  nativeScopeProof: async () => "fixture-profile",
  nativeGrant: async () => ({
    id: "fixture-home-server",
    baseUrl: "https://media.example.com",
    token: "fixture-server-token",
  }),
  nativeClient: () => ({
    container: async () => ({
      Metadata: [{ viewCount: f.viewCount, duration: 30000, viewOffset: 4000 }],
    }),
  }),
  nativeTimeline: async (access: { baseUrl: string; token: string }, query: URLSearchParams) =>
    f.timeline(access.baseUrl + "/:/timeline?" + query, {
      headers: { "X-Plex-Token": access.token },
    }),
  verifiedFetch: (...args: Parameters<typeof fetch>) => fetch(...args),
}));
vi.mock("./finished.js", () => ({
  applyQueueWriteSide: async () => {},
  finalizeQueueProgress: f.finalize,
  reconcileQueue: f.reconcile,
}));
vi.mock("./watchedReset.js", () => ({ applySeasonalReset: async () => {} }));
vi.mock("./promote.js", () => ({ recordLead: async () => {} }));
vi.mock("./store/db/queueEntryHistory.js", () => ({
  progressFor: () => f.ledger,
  savePosition: () => {},
  markCompleted: f.markCompleted,
  clearItem: f.clearItem,
}));
vi.mock("./engine/resolve.js", () => ({
  loadEntries: () => f.entries,
  resolveMember: f.resolveMember,
  sectionOf: () => null,
  inProgress: (viewOffset?: number, viewCount?: number) =>
    Number(viewOffset) > 0 && Number(viewCount) < 1,
}));
vi.mock("./engine/select.js", () => ({ watchedForSet: async () => new Set<string>() }));
vi.mock("./queues.js", () => ({ clearDone: f.clearDone }));
vi.mock("./cache.js", () => ({ bumpGeneration: f.bumpGeneration }));
import {
  createNativePlan,
  continueNativePlan,
  nativeEvent,
  nativeFullQueue,
  nativeMarkWatched,
  nativeQueues,
  readNativePlan,
  validateNativeEvent,
  safeAvatarUrl,
  type NativeEvent,
} from "./nativeTv.js";
import { nativeTvRoutes } from "./routes/nativeTvRoutes.js";
import { layoutFor } from "./nativeQueueDetail.js";
const event = (sequence = 1): NativeEvent => ({
  id: `event-${sequence}-fixture`,
  sequence,
  index: 0,
  state: "playing",
  positionMs: 1000,
  durationMs: 30000,
});
beforeEach(() => {
  f.viewCount = 1;
  f.db = new DatabaseSync(":memory:");
  f.db.exec(SCHEMA_SQL);
  f.members.clear();
  f.rosters.clear();
  f.minimums.clear();
  f.finalize.mockClear();
  f.reconcile.mockClear();
  f.provider.buckets.mockReset();
  f.provider.profileBinding.mockReset();
  f.provider.profileToken.mockReset();
  f.provider.profileBinding.mockImplementation(async (binding) => binding);
  f.provider.profileToken.mockResolvedValue("fixture-server-token");
  f.provider.buckets.mockResolvedValue({
    play: [{ ratingKey: "102", title: "The signal" }],
    led: [],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "https://plex.tv/api/v2/user") {
        const token = (options?.headers as Record<string, string>)?.["X-Plex-Token"];
        return Response.json(
          token === "fixture-child" ? { id: 2, uuid: "grace-uuid" } : { id: 1, uuid: "ada-uuid" },
        );
      }
      if (url.includes("/:/timeline?")) {
        f.timeline(url, options);
        return new Response("", { status: 200 });
      }
      throw new Error("Unexpected request");
    }),
  );
  f.timeline.mockClear();
});
describe("native TV sessions", () => {
  it("filters by Plex and reuses required/optional/group people rules", async () => {
    f.members.set("watch", [
      { kind: "person", id: "ada", role: "required", position: 0 },
      { kind: "person", id: "grace", role: "optional", position: 1 },
    ]);
    expect(((await nativeQueues([])) as { queues: unknown[] }).queues).toHaveLength(1);
    expect(((await nativeQueues(["grace"])) as { queues: unknown[] }).queues).toHaveLength(0);
    expect(((await nativeQueues(["ada", "grace"])) as { queues: unknown[] }).queues).toHaveLength(
      1,
    );
    f.members.set("watch", [{ kind: "group", id: "friends", role: "required", position: 0 }]);
    f.rosters.set("friends", [
      { personId: "ada", role: "required" },
      { personId: "grace", role: "required" },
    ]);
    f.minimums.set("friends", 1);
    expect(((await nativeQueues(["grace"])) as { queues: unknown[] }).queues).toHaveLength(1);
  });
  it("selects through the provider and returns identities without media credentials", async () => {
    const plan = await createNativePlan("watch", "fixture-profile");
    expect(plan.items[0]?.resumeMs).toBe(4000);
    expect(f.provider.buckets).toHaveBeenCalledOnce();
    expect(JSON.stringify(plan)).not.toContain("fixture-server-token");
    expect(JSON.stringify(plan)).not.toContain("fixture-profile");
    expect(() => readNativePlan(plan.id, "wrong-key")).toThrow("authorization");
    expect(readNativePlan(plan.id, plan.sessionKey).setId).toBe("watch");
    // The database holds only the capability hash, so reopening does not need raw secrets.
    const row = f.db.prepare("SELECT key_hash,data FROM native_tv_sessions").get();
    expect(JSON.stringify(row)).not.toContain(plan.sessionKey);
  });
  it("refuses a valid profile proof for another profile before selecting or writing history", async () => {
    await expect(createNativePlan("watch", "fixture-child")).rejects.toThrow("Switch Plex profile");
    expect(f.provider.buckets).not.toHaveBeenCalled();
    expect(f.timeline).not.toHaveBeenCalled();
  });
  it("persists idempotent progress and never controls an external player", async () => {
    const plan = await createNativePlan("watch", "fixture-profile");
    const ev = event();
    expect(await nativeEvent(plan.id, plan.sessionKey, ev)).toEqual({ ok: true, cursor: 0 });
    expect(await nativeEvent(plan.id, plan.sessionKey, ev)).toEqual({
      ok: true,
      duplicate: true,
      cursor: 0,
    });
    expect(f.timeline).toHaveBeenCalledOnce();
    const [url, options] = f.timeline.mock.calls[0]!;
    expect(url).toContain("state=playing");
    expect(options.headers["X-Plex-Token"]).toBe("fixture-server-token");
    const ended = { ...event(2), state: "ended" as const, positionMs: 30000 };
    await nativeEvent(plan.id, plan.sessionKey, ended);
    expect(readNativePlan(plan.id, plan.sessionKey).cursor).toBe(1);
    expect(f.finalize).toHaveBeenCalledOnce();
    await expect(nativeEvent(plan.id, plan.sessionKey, event(3))).rejects.toThrow("out-of-order");
  });
  it("rejects malformed positions, stale events and invented section completion", async () => {
    const plan = await createNativePlan("watch", "fixture-profile");
    expect(() => validateNativeEvent(plan, { ...event(), durationMs: -1 })).toThrow("Invalid");
    expect(() => validateNativeEvent(plan, { ...event(), state: "section-end" })).toThrow(
      "no section",
    );
    expect(() => validateNativeEvent(plan, { ...event(), index: 1 })).toThrow("out-of-order");
  });
  it("continues only after the current lineup finished and honors its finite length", async () => {
    const plan = await createNativePlan("watch", "fixture-profile");
    await expect(continueNativePlan(plan.id, plan.sessionKey)).rejects.toThrow("has not finished");
    await nativeEvent(plan.id, plan.sessionKey, { ...event(), state: "ended", positionMs: 30000 });
    expect(await continueNativePlan(plan.id, plan.sessionKey)).toEqual({ complete: true });
  });
  it("refuses private or credential-bearing avatar redirects", () => {
    expect(safeAvatarUrl("https://assets.plex.tv/avatar.jpg")).toBe(true);
    expect(safeAvatarUrl("https://secure.gravatar.com/avatar/fixture")).toBe(true);
    for (const target of [
      "http://plex.tv/avatar",
      "https://127.0.0.1/avatar",
      "https://user@assets.plex.tv/avatar",
      "https://plex.tv.evil.example/avatar",
    ])
      expect(safeAvatarUrl(target)).toBe(false);
  });
  it("preserves every leaf in an engine-selected episode batch", async () => {
    f.provider.buckets.mockResolvedValueOnce({
      play: [{ ratingKey: "102" }, { ratingKey: "103" }],
      led: [],
    });
    expect(
      (await createNativePlan("watch", "fixture-profile")).items.map((i) => i.ratingKey),
    ).toEqual(["102", "103"]);
  });
  it("captures a fresh baseline when the same file starts again in another entry", async () => {
    f.provider.buckets.mockResolvedValueOnce({
      play: [
        { ratingKey: "102", queueEntryKey: "entry-a" },
        { ratingKey: "102", queueEntryKey: "entry-b" },
      ],
      led: [],
    });
    const plan = await createNativePlan("watch", "fixture-profile");
    await nativeEvent(plan.id, plan.sessionKey, event());
    await nativeEvent(plan.id, plan.sessionKey, { ...event(2), state: "ended", positionMs: 30000 });
    f.viewCount = 2;
    await nativeEvent(plan.id, plan.sessionKey, { ...event(3), index: 1 });
    const persisted = readNativePlan(plan.id, plan.sessionKey);
    expect(persisted.items[0]?.queueProviderViewCount).toBe(1);
    expect(persisted.items[1]?.queueProviderViewCount).toBe(2);
  });
  it("requires authorization on plan creation and scoped session events", async () => {
    const app = nativeTvRoutes();
    const response = await app.request("/native/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setId: "watch" }),
    });
    expect(response.status).toBe(403);
    const created = await app.request("/native/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Plex-Profile-Token": "fixture-profile" },
      body: JSON.stringify({ setId: "watch" }),
    });
    expect(created.status).toBe(200);
    const plan = (await created.json()) as { id: string };
    const progress = await app.request(`/native/sessions/${plan.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event()),
    });
    expect(progress.status).toBe(403);
  });
});

describe("native TV queue titles", () => {
  // The registry the web Queues page would draw, in registry order. Nameless sets carry their
  // id as `label`, the way the registry makes a label printable, and no `has_explicit_label`.
  const plexQueue = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    label: id,
    has_explicit_label: false,
    activity: "watching",
    provider_kind: "plex",
    enabled: true,
    source: "queue",
    ...extra,
  });
  const named = (label: string) => ({ label, has_explicit_label: true });
  const registry = [
    plexQueue("ada_named", named("Movies")),
    plexQueue("ada_first"),
    plexQueue("ada_reading", { activity: "reading", provider_kind: "kavita" }),
    plexQueue("ada_second"),
    // Written last, drawn under its parent — so it is the second card of its kind, not the third.
    plexQueue("ada_window", { filtered_from: "ada_first" }),
    plexQueue("grace_shorts", { source: "rotation", ...named("Shorts") }),
    plexQueue("rules_one", { source: "rotation" }),
    plexQueue("rules_two", { source: "rotation" }),
    plexQueue("legacy_tier", {
      source: "rotation",
      superseded_by: "grace_shorts",
      ...named("Old Tier"),
    }),
  ];
  const original = f.queues;
  const titles = async () =>
    Object.fromEntries(
      ((await nativeQueues([])) as { queues: { id: string; title: string }[] }).queues.map(
        (queue) => [queue.id, queue.title],
      ),
    );
  beforeEach(() => {
    f.queues = registry;
    const ada = [{ kind: "person", id: "ada", role: "required", position: 0 }];
    for (const id of ["ada_named", "ada_first", "ada_reading", "ada_second"])
      f.members.set(id, ada);
  });
  afterEach(() => {
    f.queues = original;
  });

  it("prints the title the web Queues page prints, for every Plex queue", async () => {
    expect(await titles()).toEqual({
      ada_named: "Movies",
      ada_first: "Movies & Shows",
      ada_window: "Movies & Shows 2",
      ada_second: "Movies & Shows 3",
      grace_shorts: "Shorts",
      rules_one: "Movies & Shows",
      rules_two: "Movies & Shows 2",
    });
  });

  it("offers no superseded legacy tier, the way no web picker does", async () => {
    const ids = ((await nativeQueues([])) as { queues: { id: string }[] }).queues.map(
      (queue) => queue.id,
    );
    expect(ids).not.toContain("legacy_tier");
    expect(ids).toContain("grace_shorts");
  });

  it("keeps a queue's number when the people filter hides its siblings", async () => {
    // Numbered over the whole registry before the filter, like the web page: hiding Ada's
    // queues must not turn the second Rules queue into the first.
    f.members.set("rules_two", [{ kind: "person", id: "grace", role: "required", position: 0 }]);
    f.members.set("rules_one", [{ kind: "person", id: "grace", role: "required", position: 0 }]);
    const shown = (await nativeQueues(["grace"])) as { queues: { id: string; title: string }[] };
    expect(shown.queues.find((queue) => queue.id === "rules_two")?.title).toBe("Movies & Shows 2");
  });
});

describe("native TV full queue, item start, and watched marks", () => {
  // One queue-owned show (three episodes and an inline special) and one Plex-history film.
  const episode = (ratingKey: string, season: number, number: number, title: string) => ({
    ratingKey,
    title,
    show: "Signal Garden",
    season,
    episode: number,
    type: "episode",
    viewCount: 0,
  });
  const originalQueues = f.queues;
  const originalRouting = f.routing;
  beforeEach(() => {
    f.queues = [
      ...originalQueues,
      { id: "rules", provider_kind: "plex", enabled: true, source: "rotation" },
    ];
    f.routing = {
      ...originalRouting,
      rules: { source: "rotation", account_id: 1, enabled: true },
    };
    f.entries = [
      { key: "signal-garden", title: "Signal Garden", watchHistory: "queue" },
      { key: "harbor-lights", title: "Harbor Lights", watchHistory: "provider" },
    ];
    f.ledger = new Map([
      ["201", { isCompleted: true, positionMs: 0, durationMs: 0 }],
      ["202", { isCompleted: false, positionMs: 600000, durationMs: 1400000 }],
    ]);
    f.resolveMember.mockReset();
    f.resolveMember.mockImplementation(async (_client: unknown, desc: { key: string }) =>
      desc.key === "signal-garden"
        ? {
            type: "show",
            title: "Signal Garden",
            items: [
              episode("201", 1, 1, "Seedlings"),
              episode("202", 1, 2, "Static Bloom"),
              episode("203", 1, 3, "Night Watering"),
              episode("290", 0, 1, "Greenhouse Special"),
            ],
          }
        : {
            type: "movie",
            title: "Harbor Lights",
            ratingKey: "301",
            items: [{ ratingKey: "301", title: "Harbor Lights", viewCount: 0 }],
          },
    );
    f.provider.buckets.mockResolvedValue({
      play: [
        { ratingKey: "202", queueEntryKey: "signal-garden", queueOwnHistory: true },
        { ratingKey: "203", queueEntryKey: "signal-garden", queueOwnHistory: true },
        { ratingKey: "301", queueEntryKey: "harbor-lights" },
      ],
      led: [],
    });
    f.markCompleted.mockClear();
    f.clearItem.mockClear();
    f.clearDone.mockClear();
    f.bumpGeneration.mockClear();
  });
  afterEach(() => {
    f.queues = originalQueues;
    f.routing = originalRouting;
    f.entries = [];
    f.ledger = new Map();
  });

  it("lists every item with its state, the next item, and where the lineup ends", async () => {
    const full = await nativeFullQueue("watch", "fixture-profile");
    expect(full).toMatchObject({
      setId: "watch",
      kind: "picks",
      layout: "list",
      isWholeQueue: true,
      lineup: { count: 3, endPosition: 4 },
      isTruncated: false,
    });
    expect(full.entries.map((entry) => entry.entryKey)).toEqual(["signal-garden", "harbor-lights"]);
    const items = full.entries.flatMap((entry) => entry.items);
    expect(
      items.map(({ ratingKey, state, offsetMs, isNext, lineupIndex, isSpecial }) => ({
        ratingKey,
        state,
        offsetMs,
        isNext,
        lineupIndex,
        isSpecial,
      })),
    ).toEqual([
      { ratingKey: "201", state: "watched", offsetMs: 0, isNext: false, lineupIndex: null, isSpecial: false },
      { ratingKey: "202", state: "in_progress", offsetMs: 600000, isNext: true, lineupIndex: 0, isSpecial: false },
      { ratingKey: "203", state: "unwatched", offsetMs: 0, isNext: false, lineupIndex: 1, isSpecial: false },
      { ratingKey: "290", state: "unwatched", offsetMs: 0, isNext: false, lineupIndex: null, isSpecial: true },
      { ratingKey: "301", state: "unwatched", offsetMs: 0, isNext: false, lineupIndex: 2, isSpecial: false },
    ]);
    expect(items.map((item) => item.canMarkWatched)).toEqual([true, true, true, true, false]);
    expect(items.every((item) => item.serverId === "fixture-home-server")).toBe(true);
  });

  it("lays a queue out as a grid only when movies outnumber episodes", () => {
    const of = (movies: number, episodes: number) =>
      layoutFor([
        ...Array.from({ length: movies }, () => ({ type: "movie" })),
        ...Array.from({ length: episodes }, () => ({ type: "episode" })),
      ]);
    expect(of(3, 2)).toBe("grid");
    expect(of(2, 2)).toBe("list");
    expect(of(1, 4)).toBe("list");
    expect(of(0, 0)).toBe("list");
  });

  it("reads the full queue only for the profile the queue plays as", async () => {
    await expect(nativeFullQueue("watch", "fixture-child")).rejects.toThrow("Switch Plex profile");
    const response = await nativeTvRoutes().request("/native/queues/watch/full");
    expect(response.status).toBe(403);
  });

  it("answers a Rules queue with its lineup only", async () => {
    f.provider.buckets.mockResolvedValue({
      play: [{ ratingKey: "301", title: "Harbor Lights", type: "movie" }],
      led: [],
    });
    const full = await nativeFullQueue("rules", "fixture-profile");
    expect(full).toMatchObject({ kind: "rules", isWholeQueue: false, layout: "grid" });
    expect(full.entries[0]?.items.map((item) => item.canMarkWatched)).toEqual([false]);
  });

  it("starts at a picked item and leaves the earlier unwatched item in the queue", async () => {
    f.routing = { ...f.routing, watch: { ...f.routing.watch, length: "infinite" } };
    const plan = await createNativePlan("watch", "fixture-profile", {
      entryKey: "signal-garden",
      ratingKey: "203",
      mode: "continue",
    });
    // The pick, the rest of its entry, then the engine's lineup without the earlier episode.
    expect(plan.items.map((item) => item.ratingKey)).toEqual(["203", "290", "301"]);
    expect(plan.items[0]?.queueEntryKey).toBe("signal-garden");
    expect(plan.items[0]?.queueOwnHistory).toBe(true);
    expect(plan.refill).toBe(true);
    // Nothing was marked: 202 is still half-watched and comes up again.
    expect(f.markCompleted).not.toHaveBeenCalled();
    const full = await nativeFullQueue("watch", "fixture-profile");
    const earlier = full.entries[0]?.items.find((item) => item.ratingKey === "202");
    expect(earlier?.state).toBe("in_progress");
  });

  it("plays only the picked item and does not refill", async () => {
    // An endless queue would refill; "play only this" still stops after the one item.
    f.routing = { ...f.routing, watch: { ...f.routing.watch, length: "infinite" } };
    const plan = await createNativePlan("watch", "fixture-profile", {
      entryKey: "harbor-lights",
      ratingKey: "301",
      mode: "only",
    });
    expect(plan.items.map((item) => item.ratingKey)).toEqual(["301"]);
    expect(plan.refill).toBe(false);
  });

  it("refuses a start the queue cannot honor, with a stated status", async () => {
    const app = nativeTvRoutes();
    const post = (body: unknown) =>
      app.request("/native/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Plex-Profile-Token": "fixture-profile" },
        body: JSON.stringify(body),
      });
    expect((await post({ setId: "watch", start: { entryKey: "signal-garden" } })).status).toBe(400);
    expect(
      (await post({ setId: "watch", start: { entryKey: "nowhere", ratingKey: "203" } })).status,
    ).toBe(404);
    expect(
      (await post({ setId: "watch", start: { entryKey: "signal-garden", ratingKey: "999" } }))
        .status,
    ).toBe(404);
    expect(
      (await post({ setId: "rules", start: { entryKey: "signal-garden", ratingKey: "203" } }))
        .status,
    ).toBe(409);
  });

  it("marks a queue-owned item watched and unwatched through the queue's ledger", async () => {
    expect(
      await nativeMarkWatched("watch", "fixture-profile", {
        entryKey: "signal-garden",
        ratingKey: "203",
        isWatched: true,
      }),
    ).toEqual({ entryKey: "signal-garden", ratingKey: "203", state: "watched" });
    expect(f.markCompleted).toHaveBeenCalledWith("watch", "signal-garden", "203");
    expect(f.reconcile).toHaveBeenCalledOnce();
    expect(f.bumpGeneration).toHaveBeenCalledOnce();
    await nativeMarkWatched("watch", "fixture-profile", {
      entryKey: "signal-garden",
      ratingKey: "201",
      isWatched: false,
    });
    expect(f.clearItem).toHaveBeenCalledWith("watch", "signal-garden", "201");
    expect(f.clearDone).toHaveBeenCalledWith("watch", ["signal-garden"]);
  });

  it("refuses a watched mark it cannot keep", async () => {
    const app = nativeTvRoutes();
    const mark = (body: unknown, proof = "fixture-profile") =>
      app.request("/native/queues/watch/watched", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Plex-Profile-Token": proof },
        body: JSON.stringify(body),
      });
    // Plex owns this film's watched state; QueuePilot never scrobbles to Plex.
    expect(
      (await mark({ entryKey: "harbor-lights", ratingKey: "301", isWatched: true })).status,
    ).toBe(409);
    expect(
      (await mark({ entryKey: "signal-garden", ratingKey: "999", isWatched: true })).status,
    ).toBe(404);
    expect((await mark({ entryKey: "signal-garden", ratingKey: "203" })).status).toBe(400);
    expect(
      (await mark({ entryKey: "signal-garden", ratingKey: "203", isWatched: true }, "fixture-child"))
        .status,
    ).toBe(403);
    expect(f.markCompleted).not.toHaveBeenCalled();
  });
});
