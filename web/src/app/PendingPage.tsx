import { Page } from "../components/Page"
import { ROUTE_PATHS } from "../lib/routePaths"
import { PendingView } from "../views/PendingView"

export function PendingPage() {
  return (
    <Page
      back={{
        label: "‹ QueuePilot",
        target: ROUTE_PATHS.home,
      }}
      // `queue-view` is what HIDES the Queues toolbar. Without it the landing's
      // add-to-any-queue search, queue filter and "New queue" all leak into this page's
      // header.
      bodyClass="queue-view"
      documentTitle="Pending — QueuePilot"
      editableSetId={null}
      heading="Pending"
      isSubHidden={false}
      sub="New in your libraries, and not picked up by any Picks or Rules queue yet."
    >
      <PendingView />
    </Page>
  )
}
