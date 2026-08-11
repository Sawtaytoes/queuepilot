import { useSyncExternalStore } from "react"

import type {
  RegistrySet,
  SetsResponse,
} from "../lib/types"
import { rotationChannels } from "./store"

/**
 * Which rotation channel and which of its profile bindings the Channels view is
 * showing. Module state rather than component state because the header's sub-line
 * and the `movies-channel` body class are decided by it and are rendered by `App`,
 * one level above the view — exactly the split the vanilla app had when these were
 * `currentChannel` / `currentProfile` globals.
 */

let selection: {
  channelId: string | null
  profile: string | null
} = {
  channelId: null,
  profile: null,
}

const listeners = new Set<() => void>()

export const getChannelSelection = () => selection

export const useChannelSelection = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)

      return () => {
        listeners.delete(l)
      }
    },
    () => selection,
  )

export function setChannelSelection(
  channelId: string | null,
  profile: string | null,
) {
  if (
    selection.channelId === channelId &&
    selection.profile === profile
  )
    return

  selection = { channelId, profile }

  for (const l of listeners) l()
}

/**
 * Select by id; fall back to the last-selected channel, then the first — which is
 * what makes the bare `#/channels` route land somewhere sensible.
 */
export function resolveChannel(
  reg: SetsResponse | null,
  routeId: string | null,
  lastId: string | null,
): RegistrySet | null {
  const all = rotationChannels(reg)

  return (
    all.find((s) => s.id === routeId) ??
    all.find((s) => s.id === lastId) ??
    all[0] ??
    null
  )
}
