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

/** Create-UI / Type picker: map a product+lane choice to what POST /api/sets accepts. */
export function createKindPayload(
  choice: "priority-picks" | "random-picks" | "rules",
): {
  kind: ProductKind
  add_as?: AddAs
  source?: "rotation"
} {
  if (choice === "rules")
    return { kind: "rules", source: "rotation" }
  if (choice === "random-picks")
    return { kind: "picks", add_as: "random" }
  return { kind: "picks", add_as: "priority" }
}
