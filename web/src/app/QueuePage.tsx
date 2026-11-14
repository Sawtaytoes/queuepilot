import { useEffect } from "react"
import { useNavigate, useParams } from "react-router"
import { Page } from "../components/Page"
import { isRandomOrder } from "../lib/kind"
import { activeSet } from "../lib/nowPlaying"
import { ROUTE_PATHS } from "../lib/routePaths"
import { useStore } from "../state/store"
import { QueueView } from "../views/QueueView"

/** One curated queue or rules pool as a grid — the only page whose chrome is data. */
export function QueuePage() {
  const navigate = useNavigate()
  const { setId = "" } = useParams()
  const { data, now, reg } = useStore()

  // A redirect the vanilla render functions did with `location.assign`. Waits for `data`:
  // before it lands, "no such queue" and "not fetched yet" look the same.
  useEffect(() => {
    if (!data) return

    if (data.sets[setId]?.source !== "queue")
      navigate(ROUTE_PATHS.queues.replace("/*", ""))
  }, [data, navigate, setId])

  const queueSet = data?.sets[setId]
  const registrySet = reg?.sets.find(
    (set) => set.id === setId,
  )
  const label = queueSet?.label ?? "QueuePilot"
  const isChannel = isRandomOrder(registrySet ?? queueSet)
  // Plex's words unless the registry says otherwise, so a response that predates
  // `vocabulary` renders exactly as it always did.
  const vocab = registrySet?.vocabulary ?? {
    done: "watched",
    member: "show",
    name: "Plex",
    unit: "episode",
    units: "episodes",
    verb: "Play",
  }
  const playing = activeSet(now, data)
  const queuesPath = ROUTE_PATHS.queues.replace("/*", "")
  const isPlayingThis = Boolean(
    playing && playing === setId,
  )
  const nowPlaying = now.now

  return (
    <Page
      back={{ label: "‹ Queues", target: queuesPath }}
      bodyClass={
        isChannel ? "queue-view channel-mode" : "queue-view"
      }
      documentTitle={`${label} — QueuePilot`}
      editableSetId={setId}
      heading={label}
      // This queue is the running session — say what's on screen (the matching tile is
      // highlighted too, but a long queue can scroll it out of view).
      isSubHidden={isPlayingThis ? false : !isChannel}
      navigationHref={queuesPath}
      sub={
        isPlayingThis && nowPlaying
          ? `${nowPlaying.state === "paused" ? "⏸ Paused" : "▶ Now playing"}${nowPlaying.title || nowPlaying.showTitle ? ` — ${nowPlaying.title || nowPlaying.showTitle}` : ""}`
          : isChannel
            ? // A curated pool's members play in a shuffled order — say so, and drop the
              // ordering UI. In the PROVIDER's nouns: on a reading pool this used to promise
              // "how many episodes each show plays per visit", which is two wrong words in
              // one sentence. "contributes" is the neutral verb the type declarations already
              // use for this number, so the sentence needs no per-provider branch.
              `A Picks queue — members come up in random order; pick how many ${vocab.units} each ${vocab.member} contributes per visit.`
            : ""
      }
    >
      <QueueView setId={setId} />
    </Page>
  )
}
