import type { RegistrySet } from "../lib/types"

/**
 * The start affordance for a queue, chosen by how that queue actually starts.
 *
 * Plex is **push**: a lineup is sent at a device, so the button opens the device menu and
 * "Play on ▾" is the honest label. Kavita is **pull** — it has no cast and no webhooks at
 * all, so there is no device to offer and a device menu listing the Shield, Plex Dash and
 * Pollycracker is offering three things that cannot possibly work
 * (docs/kavita-feasibility.md §4).
 *
 * For a pull queue the app hands back a URL instead: `/go/<id>` rebuilds the reading list
 * and 302s into the reader at the current chapter. It is a plain link so it can be
 * middle-clicked, bookmarked, or dropped on a home screen — which is the whole point of the
 * launcher being one stable URL per queue.
 *
 * Branches on `delivery`, never on the provider's name.
 */
export function OpenQueueButton({
  set,
}: {
  set: Pick<RegistrySet, "id" | "delivery">
}) {
  return (
    <a
      className="playbtn openbtn"
      href={`/go/${encodeURIComponent(set.id)}`}
      id="qopen"
      rel="noreferrer"
      // A new tab, so the queue list you launched from is still there when you come back
      // from the reader.
      target="_blank"
      title="Rebuild the reading list and open it at your current chapter"
    >
      ▶ Open ↗
    </a>
  )
}

/** True when this set starts by handing back a URL rather than by pushing at a device. */
export const isPullSet = (
  set: Pick<RegistrySet, "delivery"> | null | undefined,
) => set?.delivery === "pull"
