import { IconButton, Slider } from "@charcuterie/ui"
import { useEffect, useRef, useState } from "react"

import { api } from "../lib/api"
import { isNowLive } from "../lib/nowPlaying"
import { setStatus, useStore } from "../state/store"
import { Tip } from "./Tip"

/**
 * Transport controls for the session that is on screen, pinned under the
 * header while something is playing.
 *
 * Before this the app could START a queue and nothing else. `stop` and
 * `seek` existed in the server with no HTTP route on them, and `advance`
 * was reachable only as an MQTT command Home Assistant publishes — so a
 * queue, once started, ran to its end. The owner's words, 2026-08-22:
 * *"I don't have any media controls from here though. So I can't stop
 * it. Once a queue starts, it keeps going."*
 *
 * ## The position is interpolated, not polled
 *
 * `now-playing` arrives over MQTT from a Home Assistant automation that
 * fires on the Shield's `media_player` state, and Plex reports a
 * position only when something actually changes — so between two of
 * those the payload's `position` is a fixed number that is quietly
 * getting older. It carries `positionAt` (epoch seconds) alongside for
 * exactly that reason: the elapsed time since the reading is added
 * locally, and a 1 Hz tick repaints it.
 *
 * The alternative was polling Plex `/status/sessions` for as long as the
 * bar is open, which is a request per second per open tab to keep a
 * progress bar honest.
 *
 * The clock stops while paused, because `positionAt` does not advance
 * when nothing is playing and adding wall-clock to it would run the
 * scrubber off the end of a paused episode.
 */

/** mm:ss, or h:mm:ss once there is an hour to show. */
const toClock = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds))

  const hrs = Math.floor(whole / 3_600)

  const mins = Math.floor((whole % 3_600) / 60)

  const secs = whole % 60

  const pad = (n: number) => String(n).padStart(2, "0")

  return hrs > 0
    ? `${hrs}:${pad(mins)}:${pad(secs)}`
    : `${mins}:${pad(secs)}`
}

type ControlAction =
  | "next"
  | "pause"
  | "resume"
  | "seek"
  | "stop"

export function NowPlayingBar() {
  const { now } = useStore()

  // Re-renders the interpolated position. Nothing else needs a clock, so
  // it is local rather than a store field.
  const [, setTick] = useState(0)

  // Held while a seek is in flight. Without it the slider snaps back to
  // the last MQTT position the moment the pointer is released and only
  // jumps forward when the next payload lands — a full second of the
  // thumb sitting where it was before the drag.
  //
  // Stamped with the payload it was made AGAINST rather than cleared by
  // an effect watching the payload. The effect version listed the two
  // payload fields as dependencies and never read them, which is a
  // "more dependencies than necessary" lint error and also one wasted
  // render per arriving payload — the signature compare below is the
  // same invalidation with neither.
  const [seek, setSeek] = useState<{
    against: string
    value: number
  } | null>(null)

  const [isBusy, setIsBusy] = useState(false)

  const seekTimer = useRef<number | null>(null)

  const isLive = isNowLive(now)

  const payload = now.now

  const isPaused = payload?.state === "paused"

  useEffect(() => {
    if (!isLive || isPaused) return

    const id = window.setInterval(() => {
      setTick((n) => n + 1)
    }, 1_000)

    return () => {
      window.clearInterval(id)
    }
  }, [isLive, isPaused])

  useEffect(
    () => () => {
      if (seekTimer.current) {
        window.clearTimeout(seekTimer.current)
      }
    },
    [],
  )

  if (!isLive || !payload) return null

  // Seconds. `duration` is milliseconds on some payload shapes and
  // seconds on this one — HA's `media_duration` is seconds, which is
  // what the automation forwards.
  const duration = Number(payload.duration) || 0

  const reported = Number(payload.position) || 0

  const reportedAt = Number(payload.positionAt) || 0

  const elapsed =
    isPaused || !reportedAt
      ? 0
      : Math.max(0, Date.now() / 1_000 - reportedAt)

  const live = Math.min(
    duration || Number.POSITIVE_INFINITY,
    reported + elapsed,
  )

  // A new payload means the server has caught up, so the override is
  // spent: its signature no longer matches and it evaporates.
  const signature = `${payload.ratingKey ?? ""}:${reported}`

  const position =
    seek && seek.against === signature ? seek.value : live

  const control = async (
    action: ControlAction,
    offset?: number,
  ): Promise<void> => {
    setIsBusy(true)

    try {
      await api("POST", "/api/control", { action, offset })
    } catch (e) {
      setStatus(
        `${action} failed: ${(e as Error).message}`,
        "err",
      )
    } finally {
      setIsBusy(false)
    }
  }

  const onSeekEnd = (next: number): void => {
    setSeek({ against: signature, value: next })

    // A safety net, not a debounce: the override is cleared by the next
    // payload, and if that payload never arrives — the Shield dropped
    // off, HA is down — the thumb would stay frozen at the requested
    // offset forever, which reads as a working seek that did nothing.
    if (seekTimer.current) {
      window.clearTimeout(seekTimer.current)
    }

    seekTimer.current = window.setTimeout(() => {
      setSeek(null)
    }, 10_000)

    void control("seek", Math.round(next * 1_000))
  }

  const what =
    payload.showTitle && payload.title
      ? `${payload.showTitle} — ${payload.title}`
      : payload.title || payload.showTitle || "Playing"

  return (
    // A named `<section>`, not a `role="group"` div: the name makes it a
    // region landmark, which is a real answer to "what is this bar", and
    // it needs no invented role.
    //
    // Deliberately NOT a live region. It would announce every one of the
    // 1 Hz ticks; the controls name themselves and the slider announces
    // its own value on focus, which is the whole of what there is to say.
    <section aria-label="Now playing" className="npbar">
      <div className="npbar-what" title={what}>
        {what}
      </div>

      <div className="npbar-controls">
        <Tip label={isPaused ? "Resume" : "Pause"}>
          <IconButton
            appearance="solid"
            intent="accent"
            isDisabled={isBusy}
            label={isPaused ? "Resume" : "Pause"}
            onClick={() => {
              void control(isPaused ? "resume" : "pause")
            }}
          >
            {isPaused ? "▶" : "⏸"}
          </IconButton>
        </Tip>

        <Tip label="Play the next entry">
          <IconButton
            appearance="outline"
            intent="neutral"
            isDisabled={isBusy}
            label="Play the next entry"
            onClick={() => {
              void control("next")
            }}
          >
            ⏭
          </IconButton>
        </Tip>

        <Tip label="Stop the session">
          <IconButton
            appearance="outline"
            intent="danger"
            isDisabled={isBusy}
            label="Stop the session"
            onClick={() => {
              void control("stop")
            }}
          >
            ⏹
          </IconButton>
        </Tip>
      </div>

      <div className="npbar-seek">
        <span className="npbar-time tabular-nums">
          {toClock(position)}
        </span>

        {/* A duration of 0 means the payload has not carried one yet —
            a Shield mid-launch, or a live stream. The scrubber is
            read-only rather than absent, so the row does not reflow
            under the pointer the moment the first real payload lands. */}
        <Slider
          intent="accent"
          isReadOnly={duration <= 0}
          label="Position"
          max={duration || 1}
          onChangeEnd={onSeekEnd}
          size="sm"
          step={1}
          value={Math.min(position, duration || 1)}
          valueFormat={toClock}
        />

        <span className="npbar-time tabular-nums">
          {duration > 0 ? toClock(duration) : "--:--"}
        </span>
      </div>
    </section>
  )
}
