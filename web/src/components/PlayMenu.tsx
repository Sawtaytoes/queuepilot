import { Button } from "@charcuterie/ui"
import {
  useMutation,
  useQuery,
} from "@tanstack/react-query"
import { useEffect } from "react"

import { api } from "../lib/api"
import type { Device } from "../lib/types"
import {
  closePlayMenus,
  useOverlays,
} from "../state/overlays"
import { setStatus } from "../state/store"

/**
 * "Play on ▾" — the device menu. Devices come from the MQTT service's retained
 * MQTT registry; picking one publishes the same start command an NFC scan does,
 * plus a target. The result lands back via the SSE `state` event as a status toast.
 *
 * Every play is EXPLICIT — a specific channel + tier. The old "Shield pick"
 * (`set: "auto"`) was dropped from the UI
 * (decision `2026-07-29-drop-set-auto-from-ui-every-play-explicit`).
 *
 * With no MQTT broker the fetch fails and the menu shows the error text — which is
 * what `channels-test` asserts (`.playmenu p` matching `/MQTT/i`), so the failure
 * message must stay inside the menu rather than becoming a toast.
 *
 * ## Why this one is still hand-rolled, when the two Add-to menus are not
 *
 * On 2026-08-21 the Pending tile's and the Home toolbar's Add-to menus became
 * Charcuterie `Menu`s. This is the third hand-rolled `.qmenu` and it is a menu by the
 * same test — a device row STARTS playback and keeps no selected value — so the role is
 * right and only the mechanism is wrong. It was left alone deliberately, because
 * converting it is a different change from converting those two:
 *
 *  - **`Menu` clones a TRIGGER; this component has none.** It is a singleton, rendered
 *    once in `App`, and it is opened from six unrelated places (`QueuesView`,
 *    `QueueView` twice, `ChannelsView`, `SelectionBar`, `EntrySettings`) through
 *    `openPlayMenu({ anchor: e.currentTarget.getBoundingClientRect(), … })`. The anchor
 *    is a DOMRect in module state, not an element `Menu` could clone. `Menu` would have
 *    to be rendered at each of the six ▶ buttons instead, which deletes the
 *    `overlays.playMenu` singleton and rewrites all six call sites.
 *  - **The devices query would move with it.** `useQuery({ enabled: Boolean(playMenu) })`
 *    is one fetch today because there is one menu. Six mounted `Menu`s mean six copies of
 *    that hook, which react-query dedupes on the key but which still changes when and how
 *    often the registry is read.
 *  - **A wrong conversion is worse than none.** The obvious half-measure — keep the
 *    singleton and feed `Menu` a hidden trigger positioned at the rect — is the
 *    hand-rolled positioning again, with a component wrapped around it.
 *
 * So this is a KNOWN gap, not an oversight: `.qmenu` below is the last hand-rolled menu
 * in the app, and its conversion is its own change.
 */
export function PlayMenu() {
  const { playMenu } = useOverlays()

  // Request/response GET through the shared TanStack Query client
  // (`@charcuterie/logic/query`). Only runs while the menu is open. `retry: false`
  // keeps the existing UX: the device registry is served by the Python side over
  // MQTT, so with no broker the fetch fails and the menu must show that error
  // immediately (`channels-test` asserts `.playmenu p` matches /MQTT/i) rather than
  // spending react-query's default backoff first.
  const { data: devicesData, error } = useQuery({
    enabled: Boolean(playMenu),
    queryFn: () =>
      api<{ devices: Device[] }>("GET", "/api/devices"),
    queryKey: ["devices"],
    retry: false,
  })
  const devices = devicesData?.devices ?? null

  // Fire-and-forget POST as a mutation through the same client. react-query does not
  // retry mutations by default, so a play command is never double-issued. `PlayMenu`
  // is always mounted (it renders null when closed), so this observer's `onError`
  // still fires after `closePlayMenus()` hides the menu.
  const playMutation = useMutation({
    mutationFn: (body: {
      kind: "movie" | undefined
      only: string | undefined
      profile: string | undefined
      set: string
      target: string | undefined
    }) => api("POST", "/api/play", body),
    onError: (e: Error) => {
      setStatus(`Play failed: ${e.message}`, "err")
    },
  })

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement

      // A click whose target was already detached (a just-removed menu button) is
      // an INSIDE click: the closest() walk can't see its old ancestors.
      if (!document.contains(t)) return
      if (
        !t.closest(".playmenu") &&
        !t.closest(".playbtn") &&
        !t.closest(".shelfplay")
      ) {
        closePlayMenus()
      }
    }

    document.addEventListener("click", onClick)

    return () =>
      document.removeEventListener("click", onClick)
  }, [])

  if (!playMenu) return null

  const { anchor, kind, only, onlyLabel, profile, setId } =
    playMenu

  return (
    <div
      className="qmenu playmenu"
      // The token density axis, not a hand-written height: `compact` takes the 44px
      // MIN_TOUCH_TARGET floor down over --control-height, which is what made the rows
      // read too tall in the Narrow View (F1). One attribute, zero overrides.
      data-density="compact"
      style={{
        left: `${Math.max(8, Math.min(anchor.left, window.innerWidth - 260))}px`,
        position: "fixed",
        // `.qmenu` sets `right: 8px` for its in-flow (absolute) use. We pin an explicit
        // `left` here, so `right` MUST be released — otherwise left+right both apply and
        // the menu stretches edge-to-edge instead of sizing to its 220px min-width.
        right: "auto",
        top: `${anchor.bottom + 6}px`,
      }}
    >
      {error ? (
        <p>{error.message}</p>
      ) : devices == null ? (
        <p>Loading devices…</p>
      ) : devices.length === 0 ? (
        <p>
          No devices announced yet (the queue service
          refreshes the registry every few minutes).
        </p>
      ) : (
        devices.map((d) => (
          // Charcuterie `Button`, `ghost` (nothing until hover) — the app's own row
          // skin is DELETED per 2026-08-02-adopting-a-component-means-deleting-its-skin;
          // `.qmenu button` keeps only layout. Still a native <button> with the label,
          // so `channels-test`/`live-smoke`'s `.playmenu button` reads are unchanged.
          <Button
            appearance="ghost"
            intent="neutral"
            isFullWidth
            key={d.id}
            onClick={() => {
              closePlayMenus()
              setStatus(
                onlyLabel
                  ? `Starting ${onlyLabel} on ${d.name}…`
                  : `Starting on ${d.name}…`,
              )

              playMutation.mutate({
                kind,
                only,
                profile,
                set: setId,
                target: d.default ? undefined : d.id,
              })
            }}
          >
            {d.default ? `${d.name} (default)` : d.name}
          </Button>
        ))
      )}
    </div>
  )
}
