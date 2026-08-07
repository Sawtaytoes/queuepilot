import { SelectListbox } from "./SelectListbox"
import { useState } from "react"

import { api } from "../lib/api"
import { clearSelection, useSelected } from "../state/selection"
import { channelSetIds, load, queueIds, setStatus, useStore } from "../state/store"

/**
 * The selection action bar — "Move to `<queue>`" and Remove, shown once at least
 * one tile is selected in the queue grid.
 *
 * Moving between queues is multi-select, not drag: drag is for reordering WITHIN a
 * queue (decision `2026-07-20-queue-web-ui-ux-and-write-format`).
 *
 * The target list is the same FAMILY only — a queue's titles move to queues, a
 * channel's shows to channels. Mixing families would silently change an entry's
 * playback semantics from "top plays next" to "random rotation".
 */
export function SelectionBar({ currentSet }: { currentSet: string | null }) {
  const { data } = useStore()
  const selected = useSelected()
  const [target, setTarget] = useState("")

  const family =
    currentSet && data?.sets[currentSet]?.kind === "anime"
      ? channelSetIds(data)
      : queueIds(data)
  const options = family.filter((id) => id !== currentSet)
  const value = options.includes(target) ? target : (options[0] ?? "")

  return (
    <div hidden={selected.size === 0} id="selbar">
      <span id="selcount">{`${selected.size} selected`}</span>
      <label>
        Move to
        {/* Keyed on the set being edited, not on `value`. The second writer here is
            the derivation above: `options` is "every sibling queue except this one",
            so navigating to a different queue silently rewrites both the option list
            and the fallback value with nobody having touched the control. Keying on
            `value` instead would remount on the user's own pick. */}
        <SelectListbox
          id="movetarget"
          key={currentSet}
          label="Move to"
          onChange={setTarget}
          options={options.map((id) => ({
            label: data!.sets[id]!.label,
            value: id,
          }))}
          value={value}
        />
      </label>
      <button
        id="movebtn"
        onClick={async () => {
          const items = [...selected.values()]

          setStatus("Moving…")

          try {
            await api("POST", "/api/queues/move-bulk", { items, toSet: value })
            setStatus(
              `Moved ${items.length} to ${data?.sets[value]?.label ?? value}`,
              "ok",
            )
            clearSelection()
            await load()
          }
          catch (e) {
            setStatus("Move failed: " + (e as Error).message, "err")
          }
        }}
        type="button"
      >
        Move
      </button>
      <button
        className="danger"
        id="rmbtn"
        onClick={async () => {
          const items = [...selected.values()]

          setStatus("Removing…")

          try {
            await api("POST", "/api/queues/remove-bulk", { items })
            clearSelection()
            await load()
          }
          catch (e) {
            setStatus("Remove failed: " + (e as Error).message, "err")
          }
        }}
        type="button"
      >
        Remove
      </button>
      <button
        className="ghost"
        id="clearsel"
        onClick={clearSelection}
        type="button"
      >
        Clear
      </button>
    </div>
  )
}
