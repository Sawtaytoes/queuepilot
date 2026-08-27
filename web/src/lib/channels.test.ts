import { describe, expect, it } from "vitest"

import { channelAccountLabel } from "./channels"
import type { Binding, RegistrySet } from "./types"

/** The cast is the landing fixture's — anonymized, never captured from the house. */
const binding = (plexUser: string | null): Binding => ({
  account_id: null,
  allowed_ratings: [],
  movie_ratings: [],
  plex_user: plexUser,
  user_uuid: null,
})

const channel = (
  patch: Partial<RegistrySet>,
): RegistrySet =>
  ({
    id: "shows",
    kind: "rules",
    label: "Shows",
    sections: [5],
    source: "rotation",
    ...patch,
  }) as RegistrySet

describe("a rules row says which account it plays as", () => {
  it("names the one account the pool is bound to", () => {
    expect(
      channelAccountLabel(
        channel({
          has_explicit_profiles: true,
          profiles: [binding("Younger Kids")],
        }),
      ),
    ).toBe("Younger Kids")
  })

  it("names every binding a hand-edit left behind", () => {
    expect(
      channelAccountLabel(
        channel({
          has_explicit_profiles: true,
          profiles: [
            binding("Younger Kids"),
            binding("Older Kids"),
          ],
        }),
      ),
    ).toBe("Younger Kids, Older Kids")
  })

  it("counts past three, so the chip cannot push the row into a wrap", () => {
    expect(
      channelAccountLabel(
        channel({
          has_explicit_profiles: true,
          profiles: [
            binding("Ada"),
            binding("Grace"),
            binding("Linus"),
            binding("Bob"),
            binding("Carol"),
          ],
        }),
      ),
    ).toBe("Ada, Grace, Linus +2")
  })

  /**
   * THE ONE THAT MATTERS, and the reason the gate is the LABEL rather than
   * `has_explicit_profiles`. The failure being avoided is a row that says itself twice —
   * which happens when a pool is NAMED after the account it plays as, and is true of two
   * sets in the live file.
   */
  it("says nothing when the account is already the row's own name", () => {
    expect(
      channelAccountLabel(
        channel({
          has_explicit_profiles: true,
          label: "Younger Kids",
          profiles: [binding("younger kids")],
        }),
      ),
    ).toBeNull()
  })

  /**
   * The half the old gate got wrong. A legacy flat set (`plex_user:` at the top level, no
   * `profiles:`) has ONE synthesized binding, and the server fills it with the real account —
   * measured on `/api/sets`: `younger | Shows & Shorts | explicit: false | ["Younger Kids"]`.
   * Refusing it on the flag dropped the account from every legacy pool, which is most of them.
   */
  it("names the account of a LEGACY flat set, whose binding is synthesized", () => {
    expect(
      channelAccountLabel(
        channel({
          has_explicit_profiles: false,
          label: "Shows & Shorts",
          profiles: [binding("Younger Kids")],
        }),
      ),
    ).toBe("Younger Kids")
  })

  it("says nothing rather than an empty chip", () => {
    expect(
      channelAccountLabel(
        channel({
          has_explicit_profiles: true,
          profiles: [binding(null), binding("  ")],
        }),
      ),
    ).toBeNull()
    expect(
      channelAccountLabel(
        channel({ has_explicit_profiles: true }),
      ),
    ).toBeNull()
    expect(
      channelAccountLabel(channel({ profiles: [] })),
    ).toBeNull()
    expect(channelAccountLabel(null)).toBeNull()
  })
})
