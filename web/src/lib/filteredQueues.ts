import type { RegistrySet } from "./types"

/**
 * A FILTERED queue is a narrower view of another queue — same entries, same order, same
 * progress, fewer of them. It sits UNDER the queue it views, everywhere the two can appear
 * together, so the shelf list reads as one queue with a window on it rather than as two
 * queues that happen to be alike.
 *
 * Registry order is the file's order, and nothing stops a filtered queue being written a long
 * way from its parent (or the parent being dragged past it). So the nesting is COMPUTED here
 * rather than trusted off the file: every filtered queue is lifted out and re-inserted
 * directly after its parent, in the order it was already in.
 *
 * An ORPHAN — a filtered queue whose parent is not in this list, because it was filtered out
 * by the people/kind bar or because the reference is a typo — keeps its own place instead of
 * disappearing. Losing a queue quietly is the worse failure; showing one out of place is
 * visible and self-explains.
 *
 * The implementation lives in `shared/queueTitle.ts`, because the native TV catalog numbers
 * duplicate queues in this nested order too and must agree with the Queues page.
 */
export { nestFilteredQueues } from "../../../shared/queueTitle"

/** The queue a filtered one views, resolved to `{id, label}` for the line under its name. */
export function filteredParent(
  set: RegistrySet | null | undefined,
  byId: (id: string) => RegistrySet | null | undefined,
): { id: string; label: string } | null {
  const parentId = set?.filtered_from

  if (!parentId) return null

  return {
    id: parentId,
    label: byId(parentId)?.label || parentId,
  }
}

/** Keep a parent and its filtered descendants in one grid cell and drag unit.
 * Call separately for exact and also-in tiers so a near match never moves above its divider.
 * Missing parents remain visible as standalone families.
 */
export function groupQueueFamilies(
  ids: readonly string[],
  byId: (id: string) => RegistrySet | null | undefined,
): string[][] {
  const families: string[][] = []
  const familyById = new Map<string, string[]>()
  for (const id of ids) {
    const parent = byId(id)?.filtered_from
    const family = parent ? familyById.get(parent) : undefined
    if (family) {
      family.push(id)
      familyById.set(id, family)
    } else {
      const next = [id]
      families.push(next)
      familyById.set(id, next)
    }
  }
  return families
}
