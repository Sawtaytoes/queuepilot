import { useEffect } from "react"

import { DynModal } from "./components/DynModal"
import { Header } from "./components/Header"
import { PlayMenu } from "./components/PlayMenu"
import { SelectionBar } from "./components/SelectionBar"
import { SetModal } from "./components/SetModal"
import { StartModal } from "./components/StartModal"
import { TileMenu } from "./components/TileMenu"
import { Toolbar } from "./components/Toolbar"
import { useMediaQuery } from "./hooks/useMediaQuery"
import { activeSet } from "./lib/nowPlaying"
import {
  resolveChannel,
  useChannelSelection,
} from "./state/channelSelection"
import { startLiveUpdates } from "./state/live"
import { closePlayMenus } from "./state/overlays"
import {
  getRouteOrigin,
  labelForHash,
  navigate,
  parseHash,
  useHash,
} from "./state/route"
import type { RegistrySet } from "./lib/types"
import { load, rotationChannels, useStore } from "./state/store"
import { ChannelsView } from "./views/ChannelsView"
import { PlayView } from "./views/PlayView"
import { QueuesView } from "./views/QueuesView"
import { QueueView } from "./views/QueueView"

/**
 * The whole editor. Four view containers are ALWAYS mounted and toggle the `hidden`
 * attribute, exactly as the vanilla app did — the e2e suites select
 * `#queue:not([hidden])` / `#channels:not([hidden])`, the body classes drive
 * `display` on several children, and `#tools` has to exist (hidden) even in the
 * queue view for its computed style to be asserted. Their CONTENT is only rendered
 * for the active view, so a hidden pane never holds stale data.
 *
 * The header chrome — heading, sub-line, back target, whether the heading is
 * renameable — is computed here rather than inside each view, which is what the
 * vanilla `renderPlay()` / `renderHome()` / `renderQueue()` / `renderChannels()`
 * each did for themselves.
 */

type Chrome = {
  documentTitle: string
  heading: string
  sub: string
  isSubHidden: boolean
  back: { target: string; label: string } | null
  editableSetId: string | null
  bodyClasses: string[]
}

export function App() {
  const hash = useHash()
  const route = parseHash(hash)
  const { data, now, reg } = useStore()

  useEffect(() => {
    void load()

    return startLiveUpdates()
  }, [])

  // A route change closes any floating device menu, as the vanilla `route()` did.
  useEffect(closePlayMenus, [hash])

  // Redirects the vanilla render functions did with `location.assign`.
  useEffect(() => {
    if (!data) return

    if (route.view === "queue") {
      const set = data.sets[route.id]

      if (!set || set.source !== "queue") navigate("#/")
    }

    if (route.view === "channels" && reg && !rotationChannels(reg).length) {
      navigate("#/")
    }
  }, [data, reg, route])

  // The Channels chrome depends on WHICH channel is selected, which is module
  // state rather than route state (the bare `#/channels` route names none).
  const { channelId } = useChannelSelection()
  const selectedChannel = resolveChannel(
    reg,
    route.view === "channels" ? route.id : null,
    channelId,
  )
  const chrome = computeChrome(route, data, now, selectedChannel)

  useEffect(() => {
    document.title = chrome.documentTitle
  }, [chrome.documentTitle])

  useEffect(() => {
    const all = [
      "queue-view",
      "play-view",
      "channel-mode",
      "movies-channel",
      "name-editable",
    ]

    for (const c of all) document.body.classList.remove(c)

    for (const c of chrome.bodyClasses) document.body.classList.add(c)

    if (chrome.editableSetId) document.body.classList.add("name-editable")
  }, [chrome.bodyClasses, chrome.editableSetId])

  // Desktop: the toolbar lives in the sticky header; mobile: at the top of the Home
  // content (the header is too tight — Bob's explicit ask).
  const isMobile = useMediaQuery("(max-width: 760px)")
  const toolbar = <Toolbar />

  return (
    <>
      <Header
        back={chrome.back}
        editableSetId={chrome.editableSetId}
        heading={chrome.heading}
        isSubHidden={chrome.isSubHidden}
        sub={chrome.sub}
      >
        {isMobile ? null : toolbar}
      </Header>

      <PlayView isHidden={route.view !== "play"} />
      <QueuesView
        isHidden={route.view !== "queues"}
        toolbar={isMobile ? toolbar : null}
      />
      <ChannelsView
        isHidden={route.view !== "channels"}
        routeId={route.view === "channels" ? route.id : null}
      />
      <QueueView
        isHidden={route.view !== "queue"}
        setId={route.view === "queue" ? route.id : null}
      />

      <SelectionBar currentSet={route.view === "queue" ? route.id : null} />

      <SetModal />
      <DynModal />
      <StartModal />
      <TileMenu />
      <PlayMenu />
    </>
  )
}

function computeChrome(
  route: ReturnType<typeof parseHash>,
  data: ReturnType<typeof useStore>["data"],
  now: ReturnType<typeof useStore>["now"],
  selectedChannel: RegistrySet | null,
): Chrome {
  if (route.view === "queues") {
    return {
      back: { label: "‹ Play", target: "#/" }, // Queues is a top-level configurator
      bodyClasses: [],
      documentTitle: "Queues — Plex Channels",
      editableSetId: null,
      heading: "Queues",
      isSubHidden: false,
      sub: "Top plays next. Tap a queue to open it, reorder, or move titles between queues.",
    }
  }

  if (route.view === "channels") {
    // The kind derives from the selected channel's `behavior`, not from a
    // `sub`-view argument — that is what lets each rotation be first-class.
    const isMovies = selectedChannel?.behavior === "rewatch"

    return {
      back: { label: "‹ Play", target: "#/" },
      bodyClasses: isMovies
        ? ["queue-view", "movies-channel"]
        : ["queue-view"], // reuse: hides the queues toolbar
      documentTitle: "Channels — Plex Channels",
      editableSetId: null,
      heading: "Channels",
      isSubHidden: false,
      sub: isMovies
        ? "The Movies channel: a weighted rewatch of films this tier has seen — least-watched most likely."
        : "Rule-based rotation (not a queue): pick a tier, and these filters shape the pool.",
    }
  }

  if (route.view === "queue") {
    const q = data?.sets[route.id]
    const label = q?.label ?? "Plex Channels"
    const isChannel = q?.kind === "anime"
    const playing = activeSet(now, data)
    const origin = getRouteOrigin() || (isChannel ? "#/channels" : "#/queues")

    // This queue is the running session — say what's on screen (the matching tile
    // is highlighted too, but a long queue can scroll it out of view).
    if (playing && playing === route.id) {
      const n = now.now!
      const what = n.title || n.showTitle || ""

      return {
        back: { label: labelForHash(origin), target: origin },
        bodyClasses: isChannel ? ["queue-view", "channel-mode"] : ["queue-view"],
        documentTitle: `${label} — Plex Channels`,
        editableSetId: route.id,
        heading: label,
        isSubHidden: false,
        sub: `${n.state === "paused" ? "⏸ Paused" : "▶ Now playing"}${what ? ` — ${what}` : ""}`,
      }
    }

    return {
      back: { label: labelForHash(origin), target: origin },
      bodyClasses: isChannel ? ["queue-view", "channel-mode"] : ["queue-view"],
      documentTitle: `${label} — Plex Channels`,
      editableSetId: route.id,
      heading: label,
      isSubHidden: !isChannel,
      // A channel's members play in a shuffled order — say so, and drop the
      // ordering UI.
      sub: isChannel
        ? "A channel — members play in random order; pick how many episodes each show plays per visit."
        : "",
    }
  }

  return {
    back: null,
    bodyClasses: ["queue-view", "play-view"], // hides the queues toolbar
    documentTitle: "Plex Channels",
    editableSetId: null,
    heading: "Plex Channels",
    isSubHidden: false,
    sub: "Pick something and play it. Configure ›  opens each group’s editor.",
  }
}
