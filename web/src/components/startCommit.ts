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
  setStatus(
    start ? "Saving start point…" : "Clearing start point…",
  )

  try {
    await entry.save(start)

    setStatus(
      start
        ? `Starts at ${startLabel(start).replace(/^Start /, "")}`
        : "Start cleared — plays automatically",
      "ok",
    )

    entry.refresh()
  } catch (e) {
    setStatus(`Save failed: ${(e as Error).message}`, "err")
  }
}
