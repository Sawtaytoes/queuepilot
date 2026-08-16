import { lazy, Suspense, useEffect } from "react"

import { Header } from "./components/Header"
import { PlayMenu } from "./components/PlayMenu"
import { SelectionBar } from "./components/SelectionBar"
import { Toolbar } from "./components/Toolbar"
import { useMediaQuery } from "./hooks/useMediaQuery"
import { activeSet } from "./lib/nowPlaying"
import type { RegistrySet } from "./lib/types"
import {
  resolveChannel,
  useChannelSelection,
} from "./state/channelSelection"
import { startLiveUpdates } from "./state/live"
import {
  closePlayMenus,
  useOverlays,
} from "./state/overlays"
import {
  getRouteOrigin,
  labelForHash,
  navigate,
  parseHash,
  useHash,
} from "./state/route"
import {
  load,
  rotationChannels,
  useStore,
} from "./state/store"
import { ChannelsView } from "./views/ChannelsView"
import { PlayView } from "./views/PlayView"
import { QueuesView } from "./views/QueuesView"
import { QueueView } from "./views/QueueView"

/**
 * The four overlays are code-split and hung off overlay state — they are ~1,400
 * lines of TSX (`DynModal` alone is 671) that the landing route never renders, and
 * the landing route is the LCP.
 *
 * **The four VIEWS are deliberately NOT split.** They stay permanently mounted and
 * toggle `hidden`, and the e2e suites read their internals in the same tick they
 * assert the container is visible — `channels-test` does
 * `waitForSelector('#queue:not([hidden])')` and then `$('#qplay:not([hidden])')`,
 * and `ui-test` reads `#search`'s placeholder the same way. A `Suspense` boundary
 * inside the view would paint the shell one commit before the body, so those reads
 * would race a fallback. That is a poor trade for ~15 KB against a DOM contract
 * seventeen suites depend on.
 *
 * The overlays have no such contract: every suite CLICKS them open first, and
 * Playwright's selectors auto-wait, so the one-time chunk fetch is invisible.
 */
const DynModal = lazy(async () => ({
  default: (await import("./components/DynModal")).DynModal,
}))
const SetModal = lazy(async () => ({
  default: (await import("./components/SetModal")).SetModal,
}))
const StartModal = lazy(async () => ({
  default: (await import("./components/StartModal"))
    .StartModal,
}))
const TileMenu = lazy(async () => ({
  default: (await import("./components/TileMenu")).TileMenu,
}))

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

      if (set?.source !== "queue") navigate("#/")
    }

    if (
      route.view === "channels" &&
      reg &&
      !rotationChannels(reg).length
    ) {
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
  const chrome = computeChrome(
    route,
    data,
    now,
    selectedChannel,
    reg,
  )

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

    for (const c of chrome.bodyClasses)
      document.body.classList.add(c)

    if (chrome.editableSetId)
      document.body.classList.add("name-editable")
  }, [chrome.bodyClasses, chrome.editableSetId])

  // Desktop: the toolbar lives in the sticky header; mobile: at the top of the Home
  // content (the header is too tight — Bob's explicit ask).
  const isMobile = useMediaQuery("(max-width: 760px)")
  const toolbar = <Toolbar />

  // Gate each lazy overlay's chunk fetch on its own overlay state, so importing it
  // is deferred until the user actually opens it. The overlays self-gate to `null`
  // when their state is falsy, but a lazy component still triggers its import the
  // moment it is mounted — so the mount itself has to be conditional, not just the
  // render inside it. `PlayMenu` stays eager: it is small and the play button is on
  // the landing route.
  const overlays = useOverlays()

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
        routeId={
          route.view === "channels" ? route.id : null
        }
      />
      <QueueView
        isHidden={route.view !== "queue"}
        setId={route.view === "queue" ? route.id : null}
      />

      <SelectionBar
        currentSet={
          route.view === "queue" ? route.id : null
        }
      />

      {/* A single Suspense with a null fallback: an overlay opens on a user gesture,
          and a spinner for the ~15 ms chunk fetch would flash worse than nothing. */}
      <Suspense fallback={null}>
        {overlays.setModal ? <SetModal /> : null}
        {overlays.dynModal ? <DynModal /> : null}
        {overlays.startModal ? <StartModal /> : null}
        {overlays.tileMenu ? <TileMenu /> : null}
      </Suspense>
      <PlayMenu />
    </>
  )
}

function computeChrome(
  route: ReturnType<typeof parseHash>,
  data: ReturnType<typeof useStore>["data"],
  now: ReturnType<typeof useStore>["now"],
  selectedChannel: RegistrySet | null,
  // The REGISTRY, for the one thing the queue payload does not carry: which provider a set
  // draws from, and therefore whether its copy says "episodes each show" or "chapters each
  // series".
  reg: ReturnType<typeof useStore>["reg"],
): Chrome {
  if (route.view === "queues") {
    return {
      back: { label: "‹ Play", target: "#/" }, // Queues is a top-level configurator
      bodyClasses: [],
      documentTitle: "Queues — QueuePilot",
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
      documentTitle: "Channels — QueuePilot",
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
    const label = q?.label ?? "QueuePilot"
    const isChannel = q?.kind === "anime"
    // Plex's words unless the registry says otherwise, so a response that predates
    // `vocabulary` renders exactly as it always did.
    const vocab = reg?.sets.find((s) => s.id === route.id)
      ?.vocabulary ?? {
      done: "watched",
      member: "show",
      name: "Plex",
      unit: "episode",
      units: "episodes",
      verb: "Play",
    }
    const playing = activeSet(now, data)
    const origin =
      getRouteOrigin() ||
      (isChannel ? "#/channels" : "#/queues")

    // This queue is the running session — say what's on screen (the matching tile
    // is highlighted too, but a long queue can scroll it out of view).
    if (playing && playing === route.id) {
      const n = now.now!
      const what = n.title || n.showTitle || ""

      return {
        back: {
          label: labelForHash(origin),
          target: origin,
        },
        bodyClasses: isChannel
          ? ["queue-view", "channel-mode"]
          : ["queue-view"],
        documentTitle: `${label} — QueuePilot`,
        editableSetId: route.id,
        heading: label,
        isSubHidden: false,
        sub: `${n.state === "paused" ? "⏸ Paused" : "▶ Now playing"}${what ? ` — ${what}` : ""}`,
      }
    }

    return {
      back: { label: labelForHash(origin), target: origin },
      bodyClasses: isChannel
        ? ["queue-view", "channel-mode"]
        : ["queue-view"],
      documentTitle: `${label} — QueuePilot`,
      editableSetId: route.id,
      heading: label,
      isSubHidden: !isChannel,
      // A channel's members play in a shuffled order — say so, and drop the ordering UI.
      // In the PROVIDER's nouns: on a reading channel this used to promise "how many
      // episodes each show plays per visit", which is two wrong words in one sentence.
      // "contributes" is the neutral verb the type declarations already use for this
      // number, so the sentence needs no per-provider branch of its own.
      sub: isChannel
        ? `A channel — members come up in random order; pick how many ${vocab.units} each ${vocab.member} contributes per visit.`
        : "",
    }
  }

  return {
    back: null,
    bodyClasses: ["queue-view", "play-view"], // hides the queues toolbar
    documentTitle: "QueuePilot",
    editableSetId: null,
    heading: "QueuePilot",
    isSubHidden: false,
    sub: "Pick something and play it. Configure ›  opens each group’s editor.",
  }
}
