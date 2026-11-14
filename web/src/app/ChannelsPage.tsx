import { useEffect } from "react"
import { useNavigate, useParams } from "react-router"
import { Page } from "../components/Page"
import { ROUTE_PATHS } from "../lib/routePaths"
import {
  resolveChannel,
  useChannelSelection,
} from "../state/channelSelection"
import { rotationChannels, useStore } from "../state/store"
import { ChannelsView } from "../views/ChannelsView"

export function ChannelsPage() {
  const navigate = useNavigate()
  const { channelId: routeId } = useParams()
  const { reg } = useStore()

  // WHICH channel is selected is module state, not route state — the bare `/channels` route
  // names none — and the heading's sub-line and the `movies-channel` body class both depend
  // on it. Same split the vanilla app had.
  const { channelId } = useChannelSelection()
  const channel = resolveChannel(
    reg,
    routeId ?? null,
    channelId,
  )
  const isMovies = channel?.behavior === "rewatch"

  // A redirect the vanilla render functions did with `location.assign`.
  useEffect(() => {
    if (reg && !rotationChannels(reg).length)
      navigate(ROUTE_PATHS.home)
  }, [navigate, reg])

  return (
    <Page
      back={{
        label: "‹ Queues",
        target: ROUTE_PATHS.queues.replace("/*", ""),
      }}
      // `queue-view` reuse: it hides the queues toolbar.
      bodyClass={
        isMovies
          ? "queue-view movies-channel"
          : "queue-view"
      }
      documentTitle={`${channel?.label ?? "Rules queue"} — QueuePilot`}
      editableSetId={null}
      heading={channel?.label ?? "Rules queue"}
      isSubHidden={false}
      sub={
        isMovies
          ? "The Movies rules queue: a weighted rewatch of films this account has seen — least-watched most likely."
          : "A rules queue: these filters shape what it can draw from the library."
      }
    >
      <ChannelsView routeId={routeId ?? null} />
    </Page>
  )
}
