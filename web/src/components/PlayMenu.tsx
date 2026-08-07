import { Button } from "@charcuterie/ui"
import { useEffect, useState } from "react"

import { api } from "../lib/api"
import type { Device } from "../lib/types"
import { closePlayMenus, useOverlays } from "../state/overlays"
import { setStatus } from "../state/store"

/**
 * "Play on ▾" — the device menu. Devices come from the Python service's retained
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
 */
export function PlayMenu() {
  const { playMenu } = useOverlays()
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!playMenu) return

    let isStale = false

    setDevices(null)
    setError(null)

    api<{ devices: Device[] }>("GET", "/api/devices")
      .then(({ devices: d }) => {
        if (!isStale) setDevices(d)
      })
      .catch((e: Error) => {
        if (!isStale) setError(e.message)
      })

    return () => {
      isStale = true
    }
  }, [playMenu])

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

    return () => document.removeEventListener("click", onClick)
  }, [])

  if (!playMenu) return null

  const { anchor, kind, profile, setId } = playMenu

  return (
    <div
      className="qmenu playmenu"
      // The token density axis, not a hand-written height: `compact` takes the 44px
      // MIN_TOUCH_TARGET floor down over --control-height, which is what made the rows
      // read too tall on a phone (F1). One attribute, zero overrides.
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
      {error
        ? <p>{error}</p>
        : devices == null
          ? <p>Loading devices…</p>
          : devices.length === 0
            ? (
                <p>
                  No devices announced yet (the queue service refreshes the registry
                  every few minutes).
                </p>
              )
            : devices.map((d) => (
                // Charcuterie `Button`, `ghost` (nothing until hover) — the app's own row
                // skin is DELETED per 2026-08-02-adopting-a-component-means-deleting-its-skin;
                // `.qmenu button` keeps only layout. Still a native <button> with the label,
                // so `ui-test`/`kbd-undo`'s `.qmenu button` reads are unchanged.
                <Button
                  appearance="ghost"
                  intent="neutral"
                  isFullWidth
                  key={d.id}
                  onClick={async () => {
                    closePlayMenus()
                    setStatus(`Starting on ${d.name}…`)

                    try {
                      await api("POST", "/api/play", {
                        kind,
                        profile,
                        set: setId,
                        target: d.default ? undefined : d.id,
                      })
                    }
                    catch (e) {
                      setStatus("Play failed: " + (e as Error).message, "err")
                    }
                  }}
                >
                  {d.default ? `${d.name} (default)` : d.name}
                </Button>
              ))}
    </div>
  )
}
