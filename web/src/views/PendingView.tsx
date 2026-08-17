import {
  Button,
  EmptyState,
  Spinner,
} from "@charcuterie/ui"
import { useCallback, useEffect, useState } from "react"

import { Poster } from "../components/Poster"
import { api } from "../lib/api"
import type { PendingItem, RegistrySet } from "../lib/types"
import { refreshData } from "../state/live"
import { setStatus, useStore } from "../state/store"

/**
 * PENDING — what arrived in the libraries that nothing is going to play.
 *
 * The owner's ask (2026-08-17): *"a 'Pending' or 'New' area to show if there are new movies or
 * shows added and allow me to specify the queues to add them IF they're not already picked up
 * by one."* The **if** is the feature. Everything recently added is Plex's own Recently Added
 * and needs no app; the useful list is the one that has already subtracted every pool rule and
 * every queue entry.
 *
 * So the three affordances are the three answers to "why is this here?":
 *
 * - **Add to ▾** — it should be in a queue. Only queues whose libraries include the item are
 *   offered, the same rule the Home toolbar's search uses.
 * - **Dismiss** — no. Per item, because skipping one film must not hide the twelve after it.
 * - **Mark all as seen** — none of this, and do not ask again. One watermark, one write.
 */
export function PendingView({
  isHidden,
}: {
  isHidden: boolean
}) {
  const { reg } = useStore()
  const [items, setItems] = useState<PendingItem[] | null>(
    null,
  )
  const [openMenu, setOpenMenu] = useState<string | null>(
    null,
  )

  const load = useCallback(async () => {
    setItems(null)

    try {
      const { items: found } = await api<{
        items: PendingItem[]
      }>("GET", "/api/pending")

      setItems(found)
    } catch (e) {
      setItems([])
      setStatus(
        `Pending failed: ${(e as Error).message}`,
        "err",
      )
    }
  }, [])

  useEffect(() => {
    // Only when the view is actually on screen: this is one container read per video
    // library, and the landing route must not pay for a screen nobody opened.
    if (!isHidden) void load()
  }, [isHidden, load])

  const queuesFor = (sectionId: number): RegistrySet[] =>
    (reg?.sets ?? []).filter(
      (s) =>
        s.source === "queue" &&
        s.sections.includes(sectionId),
    )

  const addTo = async (
    item: PendingItem,
    set: RegistrySet,
  ) => {
    setOpenMenu(null)
    setStatus(`Adding to ${set.label}…`)

    try {
      await api("POST", `/api/queues/${set.id}/items`, {
        position: "bottom",
        value: {
          ratingKey: item.ratingKey,
          title: `${item.title}${item.year ? ` (${item.year})` : ""}`,
        },
      })
      setStatus(
        `Added “${item.title}” to ${set.label}`,
        "ok",
      )
      refreshData()
      // It is covered now, so it leaves the list without a second round trip.
      setItems((prev) =>
        (prev ?? []).filter(
          (x) => x.ratingKey !== item.ratingKey,
        ),
      )
    } catch (e) {
      setStatus(
        `Add failed: ${(e as Error).message}`,
        "err",
      )
    }
  }

  const dismiss = async (item: PendingItem) => {
    setItems((prev) =>
      (prev ?? []).filter(
        (x) => x.ratingKey !== item.ratingKey,
      ),
    )

    try {
      await api("POST", "/api/pending/dismiss", {
        ratingKey: item.ratingKey,
      })
      setStatus(`Dismissed “${item.title}”`, "ok")
    } catch (e) {
      setStatus(
        `Dismiss failed: ${(e as Error).message}`,
        "err",
      )
      await load()
    }
  }

  const markAllSeen = async () => {
    if (!items?.length) return
    if (
      !confirm(
        `Mark all ${items.length} as seen?\n\nThey stop showing up here. Nothing is deleted and nothing is added to a queue.`,
      )
    )
      return

    setItems([])

    try {
      await api("POST", "/api/pending/seen", {})
      setStatus("Marked all as seen", "ok")
    } catch (e) {
      setStatus(`Failed: ${(e as Error).message}`, "err")
      await load()
    }
  }

  return (
    <main className="view" hidden={isHidden} id="pending">
      <div className="pendinghead">
        <p className="muted">
          Added to your libraries, and <strong>not</strong>{" "}
          picked up by any pool rule or queue. Anything a
          Filtered Pool already sweeps up is not listed —
          that is the point of the screen.
        </p>
        <Button
          appearance="ghost"
          id="pending-seen"
          intent="neutral"
          isDisabled={!items?.length}
          onClick={() => void markAllSeen()}
        >
          Mark all as seen
        </Button>
      </div>

      {items === null ? (
        <Spinner label="Looking for new titles…" />
      ) : items.length === 0 ? (
        <EmptyState
          description="Everything in your libraries is already covered by a pool or a queue."
          heading="Nothing pending"
        />
      ) : (
        <ul className="grid" id="pendinggrid">
          {items.map((item) => {
            const compatible = queuesFor(item.sectionId)

            return (
              <li
                className="pendingtile"
                key={item.ratingKey}
              >
                <Poster
                  cover={null}
                  ratingKey={item.ratingKey}
                />
                <span className="ptitle">
                  {item.title}
                  {item.year ? (
                    <span className="y"> {item.year}</span>
                  ) : null}
                  {item.editionTitle ? (
                    <span className="editionbadge">
                      {item.editionTitle}
                    </span>
                  ) : null}
                </span>
                <span className="glib">
                  {item.librarySectionTitle}
                </span>
                <div className="pendingactions">
                  <button
                    className="addto"
                    onClick={() =>
                      setOpenMenu((cur) =>
                        cur === item.ratingKey
                          ? null
                          : item.ratingKey,
                      )
                    }
                    type="button"
                  >
                    Add to ▾
                  </button>
                  <button
                    className="exclude"
                    onClick={() => void dismiss(item)}
                    type="button"
                  >
                    Dismiss
                  </button>
                  {openMenu === item.ratingKey ? (
                    <div
                      className="qmenu"
                      data-density="compact"
                    >
                      {compatible.length === 0 ? (
                        <p>{`No queue draws from “${item.librarySectionTitle}” — add it to one via its ⚙.`}</p>
                      ) : (
                        compatible.map((s) => (
                          <Button
                            appearance="ghost"
                            intent="neutral"
                            isFullWidth
                            key={s.id}
                            onClick={() =>
                              void addTo(item, s)
                            }
                          >
                            {s.label}
                          </Button>
                        ))
                      )}
                    </div>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
