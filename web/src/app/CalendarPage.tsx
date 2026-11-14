import { Page } from "../components/Page"
import { ROUTE_PATHS } from "../lib/routePaths"
import { CalendarView } from "../views/CalendarView"

/**
 * THE CALENDAR — the second editor for the two date-based settings.
 *
 * `queue-view` is what HIDES the Queues toolbar, the same reuse Pending and What to Watch/Play
 * make of it. Without it this page's header grows the landing's add-to-any-queue search, its
 * queue filter and "New queue".
 */
export function CalendarPage() {
  return (
    <Page
      back={{
        label: "‹ QueuePilot",
        target: ROUTE_PATHS.home,
      }}
      bodyClass="queue-view"
      documentTitle="Calendar — QueuePilot"
      editableSetId={null}
      heading="Calendar"
      isSubHidden={false}
      sub="Every queue with a date, and the dates it keeps. Change one here or in the queue itself — it is the same setting."
    >
      <CalendarView />
    </Page>
  )
}
