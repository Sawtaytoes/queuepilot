import { Page } from "../components/Page"
import { PeopleView } from "../views/PeopleView"

export function PeoplePage() {
  return (
    <Page
      back={{ label: "‹ QueuePilot", target: "/" }}
      bodyClass="queue-view"
      documentTitle="People — QueuePilot"
      editableSetId={null}
      heading="People"
      isSubHidden={false}
      sub="Manage the roster and the saved audience rules that queues can reuse."
    >
      <PeopleView />
    </Page>
  )
}
