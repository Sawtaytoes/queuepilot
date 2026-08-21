import type { MenuItem } from "@charcuterie/ui"
import {
  Button,
  EmptyState,
  Menu,
  Spinner,
} from "@charcuterie/ui"
import { useCallback, useEffect, useState } from "react"

import { EditionBadge } from "../components/EditionBadge"
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
 * - **Add to** — it should be in a queue. Only queues whose libraries include the item are
 *   offered, the same rule the Home toolbar's search uses. A Charcuterie `Menu`, because each
 *   row PERFORMS an add and leaves no selected state behind — see the note on the `Menu`
 *   below.
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
    // No `setOpenMenu(null)` here: choosing an item is what dismisses a `Menu`, and
    // `onDismiss` already clears this.
    setStatus(`Adding to ${set.label}…`)

    try {
      // `added: false` means the queue ALREADY names this item — by a bare title, which keys
      // differently from the ratingKey posted here and so used to slip past the duplicate
      // check and land a second copy. Saying "Added" for that would be a lie, and it is the
      // exact case the owner reported.
      const { added } = await api<{ added?: boolean }>(
        "POST",
        `/api/queues/${set.id}/items`,
        {
          position: "bottom",
          value: {
            ratingKey: item.ratingKey,
            title: `${item.title}${item.year ? ` (${item.year})` : ""}`,
          },
        },
      )
      setStatus(
        added === false
          ? `“${item.title}” is already in ${set.label}`
          : `Added “${item.title}” to ${set.label}`,
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

  /**
   * The rows of one tile's Add-to menu.
   *
   * The no-compatible-queue case is a single **disabled** item rather than the loose
   * `<p>` the hand-rolled menu had. `Menu` takes `items`, and an empty `items` is an
   * empty panel that says nothing; a disabled `menuitem` keeps the sentence inside the
   * menu where a screen reader reaches it by arrowing, announces itself as unavailable,
   * and is skipped by the arrow keys because `MenuAction` never registers it. It is the
   * difference between "you cannot do this right now" and "this does not exist".
   */
  const menuItemsFor = (
    item: PendingItem,
    compatible: RegistrySet[],
  ): MenuItem[] =>
    compatible.length === 0
      ? [
          {
            isDisabled: true,
            key: "none",
            label: `No queue draws from “${item.librarySectionTitle}” — add it to one via its ⚙.`,
            onSelect: () => {},
          },
        ]
      : compatible.map((s) => ({
          key: s.id,
          label: s.label,
          onSelect: () => void addTo(item, s),
        }))

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
                  {/* The SHARED badge, not a fifth copy of the same `<span>` — this file
                      carried the copy, and a copy is exactly how the four search pickers
                      ended up with one of them drawing an edition and three not (#139).
                      `PendingItem` names `editionTitle` the same way a `SearchHit` does,
                      which is all the component asks for. */}
                  <EditionBadge hit={item} />
                </span>
                <span className="glib">
                  {item.librarySectionTitle}
                </span>
                <div className="pendingactions">
                  {/*
                    A `Menu`, NOT a `Picker`/`Listbox`, and the distinction is the one
                    Charcuterie's own `Menu` states: a `menuitem` DOES something, an
                    `option` IS something. Choosing "Bob — Movies" here POSTs the add and
                    keeps no selected value — the tile leaves the list entirely — so
                    `role="menu"` is the true role and a listbox here would be the same
                    mistake mux-magic's `TypePicker` made from the other side.

                    What the hand-rolled `.qmenu` never had, and now comes for free:
                    arrow-key navigation, Home/End, Escape, outside-press dismiss, focus
                    moved into the panel on open and returned to the trigger on close.
                  */}
                  <Menu
                    className="addtomenu"
                    isVisible={openMenu === item.ratingKey}
                    items={menuItemsFor(item, compatible)}
                    onDismiss={() => setOpenMenu(null)}
                    trigger={
                      /*
                        A Charcuterie `Button`, and the class it used to carry (`.addto`)
                        is gone rather than kept as a handle. Its only stylesheet rules
                        are `.results .addto`, and a Pending tile has no `.results`
                        ancestor — so the trigger painted as bare text on this page while
                        looking styled in the source.

                        `Menu` CLONES its trigger rather than wrapping it, so the element
                        has to forward what the clone injects. `Button` does: its props
                        are `ComponentPropsWithRef<"button">` and everything it does not
                        destructure is spread straight onto the native `<button>` — the
                        `ref`, `aria-haspopup`, `aria-expanded`, `aria-controls` and the
                        dismiss handlers all land. `useClonedChild` composes rather than
                        replaces for the two props that are not values, so this `onClick`
                        and floating-ui's own both fire.

                        `outline`/`accent` rather than `solid`: this is the affirmative
                        action on the tile, but the page is a GRID and twenty filled
                        accent buttons is a wall of indigo. Outline is also what every
                        other secondary control in this app wears, and what `Picker`'s
                        trigger wears.
                      */
                      <Button
                        appearance="outline"
                        data-testid="pending-addto"
                        /* Decoration. `useRole` already puts `aria-haspopup="menu"` and
                           `aria-expanded` on this button, so a glyph in the accessible
                           name would only say it twice. */
                        iconEnd={
                          <span aria-hidden="true">▾</span>
                        }
                        intent="accent"
                        onClick={() =>
                          setOpenMenu((cur) =>
                            cur === item.ratingKey
                              ? null
                              : item.ratingKey,
                          )
                        }
                        size="sm"
                      >
                        Add to
                      </Button>
                    }
                  />
                  {/*
                    Also a `Button`, for the same reason: `.exclude` is only ever
                    `.tile .exclude`, and this list item's class is `pendingtile`. The
                    owner's words were "Dismiss isn't a button", and it was not one.

                    `outline`/`neutral`, NOT `ghost`: ghost is transparent until hovered,
                    which is the defect being fixed rather than a fix for it. And not
                    `danger` — dismissing writes one ratingKey to `pending.yaml`, deletes
                    nothing and adds nothing, so red would overstate it twenty times over
                    on a full grid. Quiet, but visibly a control, and secondary to Add to
                    because Add to is the answer this screen is asking for.
                  */}
                  <Button
                    appearance="outline"
                    data-testid="pending-dismiss"
                    intent="neutral"
                    onClick={() => void dismiss(item)}
                    size="sm"
                  >
                    Dismiss
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
