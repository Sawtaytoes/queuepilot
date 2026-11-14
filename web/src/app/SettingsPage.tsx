import { Page } from "../components/Page"
import { ROUTE_PATHS } from "../lib/routePaths"
import { SettingsView } from "../views/SettingsView"

/**
 * SETTINGS — the household TV PIN. `queue-view` hides the Queues toolbar, as on Calendar.
 */
export function SettingsPage() {
  return (
    <Page
      back={{
        label: "‹ QueuePilot",
        target: ROUTE_PATHS.home,
      }}
      bodyClass="queue-view"
      documentTitle="Settings — QueuePilot"
      editableSetId={null}
      heading="Settings"
      isSubHidden={false}
      sub="Household settings that belong to no one queue."
    >
      <SettingsView />
    </Page>
  )
}
