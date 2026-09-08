import { startNamesUnit } from "../lib/section"
import { startLabel } from "../lib/tileFace"
import type { StartPoint } from "../lib/types"
import {
  closeStartModal,
  type EntryActions,
} from "../state/overlays"
import { setStatus } from "../state/store"

/**
 * Persist (or clear) a manual start point and repaint the grid that owns the entry.
 * Split out of both the modal and the context menu because both write it — the menu
 * clears without ever opening the picker.
 */
export async function commitStart(
  entry: EntryActions | null,
  start: StartPoint | null,
) {
  if (!entry) return

  closeStartModal()

  // ⚠️ The question is whether the start names a UNIT, not whether the mapping is null. A
  // cleared start on an entry that also carries a SECTION comes back as `{position_ms}` —
  // the offset survives the clear on purpose — and reading that as "a start point was set"
  // toasts "Starts at " with nothing after it.
  const isUnitSet = startNamesUnit(start)

  setStatus(
    isUnitSet
      ? "Saving start point…"
      : "Clearing start point…",
  )

  try {
    await entry.save(start)

    setStatus(
      isUnitSet
        ? `Starts at ${startLabel(start, entry.item.unit).replace(/^Start /, "")}`
        : "Start cleared — plays automatically",
      "ok",
    )

    entry.refresh()
    entry.afterStart?.()
  } catch (e) {
    setStatus(`Save failed: ${(e as Error).message}`, "err")
  }
}
