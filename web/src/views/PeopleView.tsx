import { Button, Card } from "@charcuterie/ui"

import {
  openGroupsModal,
  openPeopleModal,
} from "../state/overlays"
import { usePeople } from "../state/people"

/** A focused address for the two related editors that previously hid on the Admin page. */
export function PeopleView() {
  const { groups, isLoaded, people } = usePeople()

  return (
    <div className="people-management" id="people">
      <Card
        actions={
          <Button intent="accent" onClick={openPeopleModal}>
            Edit people
          </Button>
        }
        heading="People"
      >
        <p>
          {isLoaded
            ? `${people.length} ${people.length === 1 ? "person" : "people"}. Add, rename, or remove somebody from the roster.`
            : "Loading the roster…"}
        </p>
      </Card>

      <Card
        actions={
          <Button
            appearance="outline"
            intent="neutral"
            onClick={() =>
              openGroupsModal(groups[0]?.id ?? null)
            }
          >
            Edit groups
          </Button>
        }
        heading="People groups"
      >
        <p>
          {isLoaded
            ? `${groups.length} saved ${groups.length === 1 ? "group" : "groups"}. Define the audience rules that queues can reuse.`
            : "Loading the saved groups…"}
        </p>
      </Card>
    </div>
  )
}
