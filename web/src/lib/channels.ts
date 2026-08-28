import { api } from "./api"
import type { Binding, Profile, RegistrySet } from "./types"

/**
 * Content ratings come from Plex per-account (`GET /api/ratings`); this list is
 * only the fallback when that fetch fails (Plex down / endpoint absent).
 */
export const FALLBACK_RATINGS = [
  "G",
  "TV-Y",
  "TV-Y7",
  "TV-Y7-FV",
  "TV-G",
  "PG",
  "TV-PG",
  "PG-13",
  "TV-14",
]

/** `${set}` or `${set}::${plex_user}` -> string[] */
const ratingsCache = new Map<string, string[]>()

/**
 * The active binding for a channel. A `profiles[]` channel picks by `plex_user`;
 * a legacy set's one binding IS the set, so `ch` itself is the ultra-legacy mirror.
 */
export function activeBinding(
  ch: RegistrySet,
  currentProfile: string | null,
): Binding {
  const ps = ch.profiles || []

  if (ch.has_explicit_profiles && currentProfile) {
    const hit = ps.find(
      (p) => p.plex_user === currentProfile,
    )

    if (hit) return hit
  }

  return (
    ps[0] ||
    ({
      account_id: null,
      allowed_ratings: ch.allowed_ratings || [],
      movie_excludes: ch.movie_excludes || [],
      movie_ratings: ch.movie_ratings || [],
      plex_user: null,
      user_uuid: null,
    } as Binding)
  )
}

/**
 * Ratings facet scoped to ONE binding: a `profiles[]` channel asks by the binding's
 * uuid, so Plex returns every rating available to that account. A legacy set asks by
 * set id. Falls back to the static list when Plex is unreachable.
 */
export async function fetchRatings(
  ch: RegistrySet | undefined,
  binding: Binding | undefined,
): Promise<string[]> {
  if (!ch) return FALLBACK_RATINGS

  const b = binding ?? activeBinding(ch, null)
  const key = ch.has_explicit_profiles
    ? `${ch.id}::${b.plex_user || ""}`
    : ch.id

  if (ratingsCache.has(key)) return ratingsCache.get(key)!

  const url = ch.has_explicit_profiles
    ? `/api/ratings?uuid=${encodeURIComponent(b.user_uuid || "")}`
    : `/api/ratings?set=${encodeURIComponent(ch.id)}`

  try {
    const { ratings } = await api<{ ratings: string[] }>(
      "GET",
      url,
    )

    if (Array.isArray(ratings) && ratings.length) {
      ratingsCache.set(key, ratings)

      return ratings
    }
  } catch {
    /* fall through to the fallback list */
  }

  return FALLBACK_RATINGS
}

export const cachedRatings = (key: string) =>
  ratingsCache.get(key) || FALLBACK_RATINGS

/** Ask the ratings endpoint for one profile's complete restricted view. */
export async function fetchScopedRatings(
  uuid: string,
): Promise<string[]> {
  try {
    const qs = new URLSearchParams()

    if (uuid) qs.set("uuid", uuid)

    const r = await api<{ ratings: string[] }>(
      "GET",
      `/api/ratings?${qs}`,
    )

    if (Array.isArray(r.ratings) && r.ratings.length)
      return r.ratings
  } catch {
    /* keep the fallback list */
  }

  return FALLBACK_RATINGS
}

/**
 * A ratings checkbox universe: the fetched/known list PLUS any value that must stay
 * checked.
 *
 * `known` is scoped to ONE profile, but each binding renders its OWN saved ratings,
 * so a value another profile can't see (Older's `PG` under a Younger-scoped list)
 * must still appear as a checkable option — otherwise it can never render checked,
 * and the very next Save writes it away. Order is preserved: known first, then the
 * extras. (decision `2026-07-29-binding-ratings-render-per-profile-not-shared-scope`)
 */
export const ratingOptions = (
  known: string[],
  keep: string[] = [],
) => [...new Set([...known, ...keep])]

// Plex Home users for the profile dropdown. Cached; `[]` on failure so the Advanced
// manual fields stay the fallback.
let PROFILES: Profile[] | null = null

export async function fetchProfiles(): Promise<Profile[]> {
  if (PROFILES) return PROFILES

  try {
    const { profiles } = await api<{ profiles: Profile[] }>(
      "GET",
      "/api/profiles",
    )

    PROFILES = Array.isArray(profiles) ? profiles : []
  } catch {
    PROFILES = []
  }

  return PROFILES
}

export const getCachedProfiles = () => PROFILES || []

/** A stable `<option>` value per profile (managed users key on uuid; the admin has
 * none). */
export const profileValue = (p: Profile) =>
  p.admin ? "admin" : String(p.uuid || p.id || p.name)

/**
 * Which libraries a channel has checked, per picker group.
 *
 * A REWATCH channel pools from every library it names, and legacy ones stored the
 * Movies library under `sections` (back when the pool was hardwired to it), so both
 * groups pre-check from the UNION — whichever field a library sits in, its box is
 * checked. Progress channels keep the strict split: show libraries in `sections`,
 * movie/other libraries in `item_sections`.
 * (decision `2026-07-29-rewatch-pool-follows-the-channels-own-libraries`)
 */
export function libSelection(
  ch: RegistrySet | null | undefined,
) {
  const secs = ch?.sections || []
  const items = ch?.item_sections || []

  if ((ch?.behavior || ch?.mode) !== "rewatch")
    return { item: items, show: secs }

  const both = [...secs, ...items]

  return { item: both, show: both }
}

/**
 * WHICH ACCOUNT a rules queue plays as, in one short string.
 *
 * *"Shows" and "Shows & Shorts" are the same words until you know one is Younger Kids and the
 * other Older Kids* — the Play landing's card has said so in its meta line since 2026-08-17.
 * The rules PICKER had no version of it: four rows named after what they hold, and nothing
 * saying who they are for. The owner, looking at it on 2026-08-26: *"Do we not have a way to
 * show the associated account too in this dropdown?"*
 *
 * ⚠️ **The gate is the LABEL, not `has_explicit_profiles`.** `PlayView` used the flag and said
 * why: *"the synthesized [binding] a legacy flat set reports, whose `plex_user` is the
 * channel's own label"*. That is not what the server does — a legacy flat set's synthesized
 * binding carries its real `plex_user`, measured on `/api/sets`:
 *
 *     younger | Shows & Shorts | explicit: false | profiles: ["Younger Kids"]
 *
 * The claim reads as true against the LIVE `sets.yaml` only because those two sets are named
 * after the accounts they play as, so the label and the account are the same words. Gate on
 * the flag and every legacy pool silently loses its account; gate on the label and the one
 * real failure — a row saying itself twice — is the only thing dropped.
 *
 * Returns null rather than an empty string when there is nothing to say, so a caller drops the
 * chip instead of drawing a blank one.
 *
 * Three names at most, then a `+n`. A pool carrying several bindings is rare — they are locked
 * to one account since 2026-08-17, and the picker beside this one only appears when a
 * hand-edit left more — but the badge sits at the right-hand end of a row that already holds a
 * name.
 */
export function channelAccountLabel(
  channel: RegistrySet | null | undefined,
): string | null {
  if (!channel) return null

  const label = channel.label?.trim().toLowerCase() ?? ""
  const accounts = (channel.profiles || [])
    .map((b) => b.plex_user?.trim() ?? "")
    .filter(
      (name) =>
        Boolean(name) && name.toLowerCase() !== label,
    )

  if (accounts.length === 0) return null
  if (accounts.length <= 3) return accounts.join(", ")

  return `${accounts.slice(0, 3).join(", ")} +${accounts.length - 3}`
}
