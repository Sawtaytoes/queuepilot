import { Page } from "../components/Page"
import { ROUTE_PATHS } from "../lib/routePaths"
import { PlayView } from "../views/PlayView"

/**
 * The former Admin card wall stays unlinked while its card interactions move to their
 * focused pages. It is not a navigation destination and `/admin` does not resolve here.
 */
export function OverviewPage() {
  return (
    <Page
      back={{
        label: "‹ QueuePilot",
        target: ROUTE_PATHS.home,
      }}
      bodyClass="queue-view play-view"
      documentTitle="Overview — QueuePilot"
      editableSetId={null}
      heading="Overview"
      isSubHidden={false}
      sub="Compatibility view for queue and rules card actions."
    >
      <PlayView />
    </Page>
  )
}
