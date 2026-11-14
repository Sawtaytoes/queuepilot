import { Page } from "../components/Page"
import { Toolbar } from "../components/Toolbar"
import { ROUTE_PATHS } from "../lib/routePaths"
import { QueuesView } from "../views/QueuesView"

export function QueuesPage() {
  return (
    <Page
      // Picks is a top-level configurator.
      back={{
        label: "‹ QueuePilot",
        target: ROUTE_PATHS.home,
      }}
      bodyClass=""
      documentTitle="Queues — QueuePilot"
      editableSetId={null}
      heading="Queues"
      isSubHidden={false}
      sub="Choose a Picks or Rules queue to view it, or create a new queue."
    >
      <QueuesView toolbar={<Toolbar />} />
    </Page>
  )
}
