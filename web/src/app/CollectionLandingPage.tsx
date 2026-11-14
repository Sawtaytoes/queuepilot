import { Page } from "../components/Page"
import { ROUTE_PATHS } from "../lib/routePaths"
import { CollectionLandingView } from "../views/CollectionLandingView"

export function CollectionLandingPage() {
  return (
    <Page
      back={{
        label: "‹ QueuePilot",
        target: ROUTE_PATHS.home,
      }}
      // `queue-view` is what HIDES the Queues toolbar — the same reuse Pending and What to
      // Watch/Play make of it.
      bodyClass="queue-view"
      documentTitle="Collection — QueuePilot"
      editableSetId={null}
      heading="Collection"
      isSubHidden={false}
      sub="Choose which QueuePilot-maintained collection to view."
    >
      <CollectionLandingView />
    </Page>
  )
}
