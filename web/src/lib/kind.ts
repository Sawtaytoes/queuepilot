/**
 * Product kind helpers mirrored from the server (decision 2026-08-23-kind-is-picks-or-rules).
 *
 * The registry response already normalizes `kind` to picks|rules and reports effective
 * `add_as`. These helpers still tolerate a stale client cache that has the legacy
 * movies/anime/cartoons spellings.
 */

export type ProductKind = "picks" | "rules"
export type AddAs = "priority" | "random"

export function normalizeProductKind(
  raw: unknown,
  source?: unknown,
): ProductKind {
  const k = String(raw ?? "")
    .trim()
    .toLowerCase()
  if (k === "picks" || k === "rules") return k
  const src = String(source ?? "")
    .trim()
    .toLowerCase()
  if (src === "rotation") return "rules"
  if (k === "cartoons" || k === "cartoon") return "rules"
  if (
    k === "movies" ||
    k === "anime" ||
    k === "demo" ||
    k === "movie"
  )
    return "picks"
  if (src === "queue" || src === "") return "picks"
  return "rules"
}

export function normalizeAddAs(
  raw: unknown,
  opts: { kind?: unknown; source?: unknown } = {},
): AddAs {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase()
  if (v === "priority" || v === "random") return v
  const product = normalizeProductKind(
    opts.kind,
    opts.source,
  )
  if (product !== "picks") return "random"
  const legacy = String(opts.kind ?? "")
    .trim()
    .toLowerCase()
  if (
    legacy === "movies" ||
    legacy === "movie" ||
    legacy === "demo"
  )
    return "priority"
  if (legacy === "anime") return "random"
  // No kind on disk used to mean movies (ordered). Explicit `picks` with no
  // add_as means random (ADR curated default).
  if (!legacy) return "priority"
  return "random"
}

/** Random-pool Picks (legacy curated / kind: anime). */
export function isRandomOrder(
  set:
    | {
        kind?: unknown
        source?: unknown
        add_as?: unknown
      }
    | null
    | undefined,
): boolean {
  if (!set) return false
  const source = String(set.source ?? "")
    .trim()
    .toLowerCase()
  if (source === "rotation") return false
  return (
    normalizeAddAs(set.add_as, {
      kind: set.kind,
      source: set.source,
    }) === "random"
  )
}

/**
 * The lead cooldown when neither the entry nor the queue names one — the server's
 * `DEFAULT_PROMOTE_WINDOW_MS`, spelled the way it is written on disk.
 */
export const DEFAULT_LEAD_WINDOW = "24h"

/**
 * A lead window as a person says it.
 *
 * Only the two durations that have an English name get one; everything else is read back
 * as typed. A queue set to `20h` says "once every 20h", which is exact and short — the
 * alternative ("once every 20 hours") is a units expander this app has no other use for,
 * and rounding it to "a day" is the lie the control exists to stop telling.
 */
export function leadWindowLabel(raw: string): string {
  const w = raw.trim().toLowerCase()
  if (w === "24h" || w === "1d") return "a day"
  if (w === "7d" || w === "1w") return "a week"
  return w
}
