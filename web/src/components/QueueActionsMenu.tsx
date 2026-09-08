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
 *  3. **A ROW IS OFFERED ON WHAT THAT ROW CAN DO**, and the menu is present when any row is
 *     (decision `2026-09-08-the-actions-menu-hides-on-what-each-row-can-do-not-on-the-done-flag`,
 *     which supersedes the hide clause of the record above and nothing else in it). An
 *     unavailable row is DISABLED and says why; when no row is available the menu itself is
 *     absent, so two disabled rows never appear together.
 *  4. **The confirm is a real modal step**, never `window.confirm`. Both actions are
 *     irreversible from this screen, and the dialog is the only protection there is.
 *
 * ⚠️ `doneCount` keys on `done`, **NOT** `isCompleted`. `done` is the flag in `queues.yaml`,
 * and it is what `remove-completed` can act on: that endpoint removes what the FILE has
 * flagged. A live-finished entry gets its flag from the next reconcile (`finished.js`),
 * seconds after playback ends — offering to act on it before then would do nothing. This
 * comment is the one that used to sit on `#qremovedone`.
 *
 * ⚠️ **AND THE `done` FLAG IS NOT THE WHOLE QUESTION FOR THE RESET.** On a queue carrying
 * `watch_history: queue` the completions live in `queue_entry_history` rather than on the
 * entry, and a PART-WATCHED SERIES is exactly the shape with history rows and no flag: nine
 * episodes finished, the tenth still to play, so the entry is not done and will not be until
 * the run ends. Hiding the menu on `done` alone therefore withheld the manual reset from the
 * case it helps most — and from the household Halloween queue, which is `watch_history: queue`.
 *
 * ⚠️ **LEAD COOLDOWNS ARE A GAP HERE, NOT A THIRD SIGNAL.** A reset also clears `lead_cooldown`
 * rows and a spent one can outlive every flag and every history row, so a queue can have
 * something to reset that this component cannot detect. Nothing in `/api/queues` carries them
 * and nothing in `web/src` reads them; adding that signal is a new field or endpoint, which is
 * a separate change. Do not invent one here.
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

  // ENTRIES the file has flagged. The only thing `remove-completed` can act on.
  const doneCount = items.filter((it) => it.done).length
  // LEAVES this queue has completed in its own ledger — `queue_history_completed_count`, which
  // `/api/queues` already puts on every item. It is what makes the reset reachable on a
  // `watch_history: queue` queue whose series are half-finished and therefore not `done`.
  const historyCount = items.reduce(
    (sum, it) =>
      sum + (it.queue_history_completed_count ?? 0),
    0,
  )

  // Each row asks its OWN question. `canRemove` implies `canReset`, so the only disabled row
  // that is ever reachable is "Remove all completed" — but both are written out, because the
  // day the two endpoints stop agreeing this code should still read correctly.
  const canRemove = doneCount > 0
  const canReset = doneCount > 0 || historyCount > 0

  // NO row available ⇒ no menu at all. A trigger that opens a panel of dead rows is worse than
  // no trigger, which is what the superseded rule was protecting.
  if (!canRemove && !canReset) return null

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

  /*
    A row that cannot act is DISABLED AND SAYS WHY, never removed. Same call the two Add-to
    menus made on 2026-08-21 for their no-compatible-queue state: it announces as unavailable
    rather than as absent — "you cannot do this right now", not "this does not exist" — and a
    row that silently is not there sends the reader looking for it somewhere else.
    `MenuAction` never registers a disabled item with `RovingFocus`, so the arrow keys step
    over it and the keyboard is no worse for it.
  */
  const menuItems: MenuItem[] = [
    {
      isDisabled: !canReset,
      key: "reset",
      label: canReset
        ? "Mark all unwatched"
        : "Mark all unwatched — nothing is watched yet",
      onSelect: () => setPending("reset"),
    },
    {
      isDisabled: !canRemove,
      key: "remove",
      label: canRemove
        ? "Remove all completed"
        : "Remove all completed — no entry is completed yet",
      onSelect: () => setPending("remove"),
    },
  ]

  const isReset = pending === "reset"

  /*
    THE FINER OF TWO GRANULARITIES, NEVER THEIR SUM. `done` counts ENTRIES and
    `queue_history_completed_count` counts LEAVES, and on a `watch_history: queue` queue a
    finished movie has BOTH — one flag and one history row for the same film — so adding them
    doubles every number the owner can check against the screen. The maximum reads correctly in
    all three shapes: 12 on a movie queue where both say 12, 9 on the part-watched series where
    only the history knows, and 5 on a provider-history queue where only the flags do.
  */
  const clearCount = Math.max(doneCount, historyCount)

  const heading = isReset
    ? `Clear ${clearCount} ${clearCount === 1 ? "completion" : "completions"} in ${queueName}?`
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
