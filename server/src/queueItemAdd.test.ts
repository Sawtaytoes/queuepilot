import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  findDuplicateItem: vi.fn(),
  addItem: vi.fn(),
  listSet: vi.fn(),
  plexServerAccessForProfile: vi.fn(),
  plexServerGet: vi.fn(),
  routing: { watch: { source: "queue", requires_profile: "Ada" } } as Record<string, unknown>,
}));
vi.mock("./engine/plex-live.js", () => ({ liveClient: () => ({}) }));
vi.mock("./engine/routing.js", () => ({ loadSets: () => ({ sets: f.routing }) }));
vi.mock("./entryIdentity.js", () => ({ findDuplicateItem: f.findDuplicateItem }));
vi.mock("./plex.js", () => ({
  machineIdentifier: async () => "fixture-home-server",
  profileScope: async () => ({ account: "ada-uuid" }),
}));
vi.mock("./plexSources.js", () => ({
  plexServerAccessForProfile: f.plexServerAccessForProfile,
  plexServerGet: f.plexServerGet,
}));
vi.mock("./queues.js", () => ({ addItem: f.addItem, listSet: f.listSet }));
import { addQueueItem, QueueAddError } from "./queueItemAdd.js";

describe("addQueueItem", () => {
  beforeEach(() => {
    for (const spy of [
      f.findDuplicateItem,
      f.addItem,
      f.listSet,
      f.plexServerAccessForProfile,
      f.plexServerGet,
    ])
      spy.mockReset();
    f.listSet.mockResolvedValue([]);
    f.findDuplicateItem.mockResolvedValue(null);
    f.addItem.mockResolvedValue({ added: true, key: "rk:401" });
  });

  it("writes a home item where the caller asked", async () => {
    await expect(
      addQueueItem("watch", { ratingKey: "401", title: "Glass City" }, "top"),
    ).resolves.toEqual({ added: true, key: "rk:401" });
    expect(f.addItem).toHaveBeenCalledWith(
      "watch",
      { ratingKey: "401", title: "Glass City" },
      "top",
      { allowDuplicate: false },
    );
    expect(f.plexServerGet).not.toHaveBeenCalled();
  });

  it("names the line a duplicate repeats, unless a duplicate was asked for", async () => {
    f.findDuplicateItem.mockResolvedValue({ key: "rk:401" });
    await expect(
      addQueueItem("watch", { ratingKey: "401", title: "Glass City" }, "top"),
    ).resolves.toEqual({ added: false, key: "rk:401", duplicateOf: "rk:401" });
    expect(f.addItem).not.toHaveBeenCalled();
    await addQueueItem("watch", { ratingKey: "401", title: "Glass City" }, "bottom", {
      allowDuplicate: true,
    });
    expect(f.addItem).toHaveBeenCalledWith(
      "watch",
      { ratingKey: "401", title: "Glass City" },
      "bottom",
      { allowDuplicate: true },
    );
  });

  it("checks a shared-server item through the queue profile before writing it", async () => {
    f.plexServerAccessForProfile.mockResolvedValue({ baseUrl: "https://shared.example.com" });
    f.plexServerGet.mockResolvedValue({ MediaContainer: { Metadata: [{ type: "show" }] } });
    const value = { ratingKey: "402", title: "Orbit Nine", plex_server: "fixture-shared" };
    await addQueueItem("watch", value, "top");
    expect(f.plexServerAccessForProfile).toHaveBeenCalledWith("ada-uuid", "fixture-shared");
    expect(f.addItem).toHaveBeenCalled();
  });

  it("refuses a shared-server item it cannot vouch for", async () => {
    const refusal = (value: unknown) =>
      addQueueItem("watch", value as never, "top").catch((e: QueueAddError) => [
        e instanceof QueueAddError,
        e.status,
      ]);
    expect(
      await refusal({ ratingKey: "402", title: "x", plex_server: "fixture-home-server" }),
    ).toEqual([true, 400]);
    expect(await refusal({ ratingKey: "x", title: "x", plex_server: "fixture-shared" })).toEqual([
      true,
      400,
    ]);
    f.plexServerAccessForProfile.mockResolvedValue(null);
    expect(await refusal({ ratingKey: "402", title: "x", plex_server: "fixture-shared" })).toEqual(
      [true, 403],
    );
    f.plexServerAccessForProfile.mockResolvedValue({ baseUrl: "https://shared.example.com" });
    f.plexServerGet.mockResolvedValue({ MediaContainer: { Metadata: [{ type: "episode" }] } });
    expect(await refusal({ ratingKey: "402", title: "x", plex_server: "fixture-shared" })).toEqual(
      [true, 400],
    );
    expect(f.addItem).not.toHaveBeenCalled();
  });
});
