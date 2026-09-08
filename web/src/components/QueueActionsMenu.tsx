import type { MenuItem } from "@charcuterie/ui"
import { Button, Dialog, Menu } from "@charcuterie/ui"
import { useEffect, useState } from "react"

import { api } from "../lib/api"
import type { QueueItem } from "../lib/types"
import { busy } from "../state/busy"
import { load, setStatus } from "../state/store"

/**
 * THE QUEUE'S DESTRUCTIVE ACTIONS — one menu, each row behind a confirm.
 *
 * decision `2026-09-08-a-destructive-queue-action-lives-in-an-actions-menu-behind-a-confirm`
 *
 * Two rows on day one, and both throw away a season of watching:
 *
 *  - **Mark all unwatched** — `POST /api/queues/:set/reset-watched`, the manual twin of the
 *    reset date. It is the SAME server function the seasonal reset and the MQTT topic call;
 *    there is no second implementation and there must not be one
 *    (decision `2026-09-08-the-reset-is-exposed-on-the-api-and-mqtt-without-a-home-assistant-automation`).
 *  - **Remove all completed** — `POST /api/queues/:set/remove-completed`. It was a toolbar
 *    button (`#qremovedone`) and it MOVED here; the toolbar loses a button on the day it
 *    gains a menu, which is half the reason for the change.
 *
 * Four things are rules rather than choices:
 *
 *  1. **It is a `Menu`, not a `Picker`.** A `menuitem` DOES something; an `option` IS
 *     something. Both rows perform an action and leave no selected value behind, so the
 *     picker rule does not reach this control
 *     (decision `2026-08-21-an-add-to-menu-is-a-menu-not-a-picker`).
 *  2. **The confirm NAMES THE NUMBER.** "Clear 12 completions in Halloween?", never "Are you
 *     sure?" — a count is the only thing that tells the owner he has the queue he thinks he
 *     has. The number comes from the entries this page already holds, because the route can
 *     only answer AFTER it has cleared them; the status line afterwards reconciles the two.
 *  3. **The menu is absent when there is nothing to act on**, rather than showing two
 *     disabled rows — the rule `#qremovedone` already had.
 *  4. **The confirm is a real modal step**, never `window.confirm`. Both actions are
 *     irreversible from this screen, and the dialog is the only protection there is.
 *
 * ⚠️ `doneCount` keys on `done`, **NOT** `isCompleted`. `done` is the flag in `queues.yaml`,
 * and it is what both endpoints can act on: `remove-completed` removes what the FILE has
 * flagged, and the reset strips those same flags. A live-finished entry gets its flag from
 * the next reconcile (`finished.js`), seconds after playback ends — offering to act on it
 * before then would do nothing. This comment is the one that used to sit on `#qremovedone`.
 */

/** Which confirm is open. `null` is "the menu may be open, but nothing is being confirmed". */
type PendingAction = "remove" | "reset"

type Props = {
  /**
   * The WHOLE queue, never the filtered view. A view filter narrows what is on screen and
   * changes nothing about what either endpoint acts on, so counting the visible entries
   * would name a number the server is not about to honour.
   */
  items: readonly QueueItem[]
  /** What this queue is CALLED, so the confirm can name it. */
  queueName: string
  setId: string
}

export function QueueActionsMenu({
  items,
  queueName,
  setId,
}: Props) {
  const [isOpen, setIsOpen] = useState(false)
  const [pending, setPending] =
    useState<PendingAction | null>(null)
  const [isRunning, setIsRunning] = useState(false)

  /**
   * An open confirm counts as an edit in progress, the way every other modal in the app
   * does. Without it a live SSE refresh can land while the dialog is up and change the
   * queue under the number the dialog is naming.
   */
  useEffect(() => {
    if (!pending) return

    busy.openModals += 1

    return () => {
      busy.openModals = Math.max(0, busy.openModals - 1)
    }
  }, [pending])

  const doneCount = items.filter((it) => it.done).length

  // Nothing flagged in the file ⇒ no menu at all. See rule 3 above.
  if (!doneCount) return null

  const close = () => {
    setPending(null)
    setIsRunning(false)
  }

  const markAllUnwatched = async () => {
    setStatus("Marking unwatched…")

    try {
      const out = await api<{
        entries?: number
        total?: number
      }>("POST", `/api/queues/${setId}/reset-watched`)

      const entries = out.entries ?? 0
      const total = out.total ?? 0
      // RECONCILE. The dialog named what this page could see — the `done` flags. The route
      // clears three stores and answers all three, so the status line says what actually
      // went, and names the disagreement when the two differ rather than hiding it.
      const drift =
        entries === doneCount
          ? ""
          : ` (${doneCount} were showing)`

      setStatus(
        `Marked ${entries} unwatched${drift} — ${total} records cleared`,
        "ok",
      )
      await load()
    } catch (e) {
      setStatus(
        `Mark unwatched failed: ${(e as Error).message}`,
        "err",
      )
    }
  }

  const removeAllCompleted = async () => {
    setStatus("Removing completed…")

    try {
      const out = await api<{ removed?: number }>(
        "POST",
        `/api/queues/${setId}/remove-completed`,
      )

      setStatus(
        `Removed ${out.removed ?? 0} completed`,
        "ok",
      )
      await load()
    } catch (e) {
      setStatus(
        `Remove failed: ${(e as Error).message}`,
        "err",
      )
    }
  }

  const menuItems: MenuItem[] = [
    {
      key: "reset",
      label: "Mark all unwatched",
      onSelect: () => setPending("reset"),
    },
    {
      key: "remove",
      label: "Remove all completed",
      onSelect: () => setPending("remove"),
    },
  ]

  const isReset = pending === "reset"

  const heading = isReset
    ? `Clear ${doneCount} ${doneCount === 1 ? "completion" : "completions"} in ${queueName}?`
    : `Remove ${doneCount} completed ${doneCount === 1 ? "entry" : "entries"} from ${queueName}?`

  const body = isReset
    ? "Every completion this queue owns is cleared: the watched flags, this queue’s own progress, and the lead cooldowns. Nothing is written to the media server. The queue plays from the start again. This cannot be undone from here."
    : "Those entries leave this queue for good. Their watch state does not change, and nothing is removed from the library. This cannot be undone from here."

  /** The one place either action runs. Both close the dialog first, then write. */
  const confirmAction = async () => {
    if (!pending) return

    setIsRunning(true)

    try {
      if (pending === "reset") {
        await markAllUnwatched()
      } else {
        await removeAllCompleted()
      }
    } finally {
      close()
    }
  }

  return (
    <>
      {/*
        `.qactionsmenu` is a DOM HANDLE and carries no rule — the panel's look is the
        component's. A `Menu` portals to `<body>`, so an e2e selector scoped under the
        toolbar cannot reach these rows; the suites read `.qactionsmenu [role="menuitem"]`
        document-wide, exactly as they read `.addtomenu` for the two Add-to menus.
      */}
      <Menu
        className="qactionsmenu"
        isVisible={isOpen}
        items={menuItems}
        onDismiss={() => setIsOpen(false)}
        placement="bottom-end"
        trigger={
          <Button
            appearance="outline"
            iconEnd={
              // Decoration only — `useRole` already writes `aria-haspopup="menu"`
              // and `aria-expanded` onto this button.
              <span aria-hidden="true">▾</span>
            }
            id="qactions"
            intent="neutral"
            onClick={() => setIsOpen((cur) => !cur)}
          >
            Actions
          </Button>
        }
      />
      <Dialog
        footer={
          <>
            <Button
              appearance="outline"
              id="qactionscancel"
              intent="neutral"
              onClick={close}
            >
              Cancel
            </Button>
            <Button
              id="qactionsgo"
              intent="danger"
              isLoading={isRunning}
              loadingLabel="Working…"
              onClick={() => void confirmAction()}
            >
              {isReset
                ? "Mark all unwatched"
                : "Remove all completed"}
            </Button>
          </>
        }
        heading={heading}
        // A destructive confirm is the one case the library names for this: it has to be
        // ANSWERED. Cancel is a button in the footer, so there is still a way out that is
        // not the action.
        isDismissable={false}
        isVisible={pending !== null}
        onClose={close}
        size="sm"
      >
        <p id="qactionsconfirm">{body}</p>
      </Dialog>
    </>
  )
}
