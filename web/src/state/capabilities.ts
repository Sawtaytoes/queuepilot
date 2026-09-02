import { useSyncExternalStore } from "react"

import { api } from "../lib/api"
import type {
  ProviderInfo,
  RegistrySet,
} from "../lib/types"

/**
 * What each PROVIDER can do, read once from `GET /api/providers` and answered per queue.
 *
 * A queue's registry row carries `provider_kind`, not the capability itself, so the browser
 * has to join the two. It is a module store rather than a field on the main snapshot for the
 * same reason `overlays.ts` is one: the answer outlives a view, several unrelated components
 * ask for it, and it is not part of the payload `revalidate()` swaps in and out.
 *
 * ONE fetch for the life of the page. The provider list changes when somebody edits the
 * config file and restarts the server, which is not a thing that happens while a tab is open,
 * and a per-tile request would put an uncached read back on a page that spent a lot of work
 * getting to zero (`AGENTS.md`, "The page loads from CACHE").
 */

let providers: ProviderInfo[] | null = null
let isLoading = false

const listeners = new Set<() => void>()

const emit = () => {
  for (const listener of listeners) listener()
}

/**
 * Fetch the list once. A failure leaves `providers` as an EMPTY list rather than null, so the
 * page does not retry on every render — and an empty list reads as "no capability", which is
 * the safe direction: no control beats a control nothing serves.
 */
function load(): void {
  if (providers || isLoading) return

  isLoading = true

  void api<{ providers: ProviderInfo[] }>(
    "GET",
    "/api/providers",
  )
    .then((response) => {
      providers = response.providers ?? []
    })
    .catch(() => {
      providers = []
    })
    .finally(() => {
      isLoading = false
      emit()
    })
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

/** Test seam and the SSR-safe snapshot. Never null, so `useSyncExternalStore` is stable. */
const EMPTY: ProviderInfo[] = []

const getSnapshot = () => providers ?? EMPTY

export const useProviders = (): ProviderInfo[] => {
  load()

  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY,
  )
}

/**
 * Can a queue on this set play a SECTION of an item — start at a mark and stop at one?
 *
 * Plex alone today. The check is the provider's declared capability and never
 * `kind === "plex"`: a UI that branches on a backend's NAME has to be edited again for every
 * future backend, which is the leak the seam exists to prevent
 * (`docs/decisions/2026-09-01-a-start-point-carries-a-position-and-end-is-its-mirror.md`,
 * following the watch-history capability).
 *
 * FALSE while the list is still in flight, and false for a kind this build has not heard of.
 * A control that appears a beat late is better than one that appears and cannot work — and a
 * reading queue must show no section control at all rather than a disabled one.
 */
export function usePlaysSections(
  set:
    | Pick<RegistrySet, "provider_kind">
    | null
    | undefined,
): boolean {
  const list = useProviders()

  if (!set?.provider_kind) return false

  return list.some(
    (provider) =>
      provider.kind === set.provider_kind &&
      provider.plays_sections === true,
  )
}
