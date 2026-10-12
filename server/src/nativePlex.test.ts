import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./config.js", () => ({
  PLEX_CLIENT_IDENTIFIER: "fixture-client",
  PLEX_TOKEN: "fixture-owner",
}));
import { nativeGrant, nativeVerifiedProfile, verifiedFetch } from "./nativePlex.js";
let connections: { uri: string; local: boolean; relay: boolean }[];
let actualIdentity = "fixture-server";
beforeEach(() => {
  connections = [{ uri: "http://10.0.0.2:32400", local: true, relay: false }];
  actualIdentity = "fixture-server";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, options?: RequestInit & { dispatcher?: unknown }) => {
      expect(options?.dispatcher).toBeDefined(); // Every new call opts into certificate verification.
      if (input.endsWith("/api/v2/user"))
        return Response.json(
          (options?.headers as Record<string, string>)["X-Plex-Token"] === "fixture-child"
            ? { id: 2, uuid: "grace-uuid" }
            : { id: 11, uuid: "owner-uuid" },
        );
      if (input.endsWith("/home/users"))
        return Response.json({
          users: [
            { id: 11, admin: true, title: "Ada" },
            { id: 2, uuid: "grace-uuid", title: "Grace" },
          ],
        });
      if (input.includes("/resources?"))
        return Response.json([
          {
            clientIdentifier: "fixture-server",
            provides: "server",
            accessToken: "fixture-scoped",
            connections,
          },
        ]);
      if (input.endsWith("/identity")) {
        expect((options?.headers as Record<string, string>)["X-Plex-Token"]).toBe("fixture-scoped");
        return Response.json({ MediaContainer: { machineIdentifier: actualIdentity } });
      }
      throw new Error("Unexpected fixture request");
    }),
  );
});
describe("native direct Plex grants", () => {
  it("verifies actual managed and owner identities", async () => {
    expect((await nativeVerifiedProfile("fixture-child")).uuid).toBe("grace-uuid");
    expect((await nativeVerifiedProfile("fixture-owner")).uuid).toBeNull();
    await expect(nativeVerifiedProfile("")).rejects.toThrow("sign-in");
  });
  it("derives a scoped direct connection and requires matching server identity", async () => {
    expect((await nativeGrant("fixture-child", "fixture-server")).token).toBe("fixture-scoped");
    actualIdentity = "another-server";
    await expect(nativeGrant("fixture-child", "fixture-server")).rejects.toThrow("verified direct");
  });
  it("rejects relays, public HTTP, credentials and URL suffixes before probing", async () => {
    for (const c of [
      { uri: "https://relay.example.com", local: false, relay: true },
      { uri: "http://public.example.com", local: false, relay: false },
      { uri: "http://8.8.8.8", local: true, relay: false },
      { uri: "https://user@media.example.com", local: false, relay: false },
      { uri: "https://media.example.com/path", local: false, relay: false },
    ]) {
      connections = [c];
      await expect(nativeGrant("fixture-child", "fixture-server")).rejects.toThrow(
        "verified direct",
      );
    }
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/identity"))).toBe(
      false,
    );
  });
  it("uses an explicit TLS dispatcher for credential-free image requests too", async () => {
    await verifiedFetch("https://plex.tv/api/v2/user", {
      headers: { "X-Plex-Token": "fixture-owner" },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
