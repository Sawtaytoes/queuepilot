import { Page } from "../components/Page"
import { ROUTE_PATHS } from "../lib/routePaths"
import { CollectionView } from "../views/CollectionView"

export function BoardGameCollectionPage() {
  return (
    <Page
      back={{
        label: "‹ Collection",
        target: ROUTE_PATHS.collection,
      }}
      bodyClass="queue-view"
      documentTitle="Board Games — QueuePilot"
      editableSetId={null}
      heading="Board Games"
      isSubHidden={false}
      sub="Every board game on the shelf. Mark one played, and say who was at the table."
    >
      <CollectionView />
    </Page>
  )
}
