import { Badge, ButtonLink, Card } from "@charcuterie/ui"

import { COLLECTIONS } from "../lib/collections"
import styles from "./CollectionLandingView.module.css"

/** Select one QueuePilot-maintained collection before loading its full shelf. */
export function CollectionLandingView() {
  return (
    <div className="view" id="collection-picker">
      <section
        className="tsection"
        aria-labelledby="collections-heading"
      >
        <div className={styles.intro}>
          <h2 className="tlabel" id="collections-heading">
            Your collections
          </h2>
          <p className="subhint">
            Choose one collection to browse. QueuePilot
            keeps each collection separate, so its search,
            details, and actions fit the items inside it.
          </p>
        </div>

        <ul className={styles.grid}>
          {COLLECTIONS.map((collection) => (
            <li key={collection.id}>
              <Card
                heading={collection.label}
                headingLevel={3}
                padding="md"
                surface="raised"
              >
                <div className={styles.cardBody}>
                  <p className={styles.description}>
                    {collection.description}
                  </p>
                  <div className={styles.actions}>
                    <Badge>{collection.status}</Badge>
                    <ButtonLink
                      href={collection.href}
                      size="sm"
                    >
                      View collection
                    </ButtonLink>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
