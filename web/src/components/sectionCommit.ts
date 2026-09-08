import {
  type Section,
  sectionOf,
  sectionSummary,
  withPositionMs,
} from "../lib/section"
import type { EndPoint, StartPoint } from "../lib/types"
import {
  closeSectionModal,
  type EntryActions,
} from "../state/overlays"
import { setStatus } from "../state/store"

/**
 * Persist (or clear) an entry's SECTION and repaint the grid that owns it.
 *
 * Split out of the modal for the reason `startCommit.ts` was: the panel's own "Play the whole
 * item" clears a section without ever opening the picker, so the write cannot live inside the
 * picker.
 */

/** `{ok: false, error}` — what a REFUSED write answers with, at HTTP 200. */
type WriteResult = {
  error?: string
  ok?: boolean
}

/**
 * The server answers a refused window with **`{ok: false, error}` and a 200**, not with an
 * HTTP error, so `api()` resolves and nothing throws. A caller that only try/catches
 * therefore reports "Saved" over a file it did not change. Read the body.
 *
 * A plain `{ok: false}` with no `error` means the entry was not found, which is what
 * `rewriteEntry` answers for a key that has gone.
 */
function refusalOf(result: unknown): string | null {
  const body = result as WriteResult | null

  if (body?.ok !== false) return null

  return (
    body.error || "that entry is no longer in this queue"
  )
}

/**
 * WHICH WRITE GOES FIRST, and why this is not a style question.
 *
 * `start` and `end` are two keys with two routes, and the pair rule lives on the WRITERS: a
 * `setStart` or a `setEnd` is refused when the value it lands on would not be strictly before
 * the other side as the file currently holds it. So two individually-valid writes can still
 * be refused halfway through — move a window from 1:00–2:00 to 3:00–4:00 and writing the
 * start first lands 3:00 against the stored 2:00, which is an inverted window and a refusal.
 *
 * Writing `end` first is safe whenever the new end still sits after the STORED start; when it
 * does not, the window moved earlier and `start` first is safe by the same test. One of the
 * two always works, because both the old and the new window are themselves valid.
 */
function isEndFirst(
  previous: Section | null,
  next: Section,
): boolean {
  const storedStart = previous?.startMs ?? null

  return (
    storedStart == null ||
    next.endMs == null ||
    next.endMs > storedStart
  )
}

export async function commitSection(
  entry: EntryActions | null,
  next: Section | null,
) {
  if (!entry?.saveEnd) return

  const { item, saveEnd } = entry
  const previous = sectionOf(item)
  const wanted: Section = next ?? {
    endMs: null,
    startMs: null,
  }

  closeSectionModal()

  // Nothing moved: say so and write nothing. Each write takes the cross-process YAML lock and
  // rewrites the whole file, so a no-op PATCH is not free — and a "Saved" toast over a write
  // that never happened is the thing this app has already been bitten by elsewhere.
  if (
    (previous?.startMs ?? null) === wanted.startMs &&
    (previous?.endMs ?? null) === wanted.endMs
  ) {
    setStatus("Nothing changed", "ok")

    return
  }

  setStatus(next ? "Saving section…" : "Clearing section…")

  // The START is written as a WHOLE start mapping, so the season and episode the start picker
  // chose ride through untouched. `PATCH …/start` replaces the mapping; sending only the
  // offset would drop the unit, and dropping it is invisible because this modal never draws
  // it (`lib/section.withPositionMs`).
  const startPayload: StartPoint | null = withPositionMs(
    item.start,
    wanted.startMs,
  )
  const endPayload: EndPoint | null =
    wanted.endMs == null
      ? null
      : { position_ms: wanted.endMs }

  const writeStart = async () =>
    refusalOf(await entry.save(startPayload))
  const writeEnd = async () =>
    refusalOf(await saveEnd(endPayload))

  // Only the end that actually MOVED is written. One lock instead of two for the common edit,
  // and it also removes the ordering question entirely whenever a single side changed.
  const isStartMoved =
    (previous?.startMs ?? null) !== wanted.startMs
  const isEndMoved =
    (previous?.endMs ?? null) !== wanted.endMs
  const order = (
    isEndFirst(previous, wanted)
      ? [
          isEndMoved ? writeEnd : null,
          isStartMoved ? writeStart : null,
        ]
      : [
          isStartMoved ? writeStart : null,
          isEndMoved ? writeEnd : null,
        ]
  ).filter((write) => write !== null)

  try {
    for (const write of order) {
      const refusal = await write()

      if (refusal) {
        setStatus(`Section refused — ${refusal}`, "err")
        entry.refresh()

        return
      }
    }

    setStatus(
      next
        ? `Section — ${sectionSummary(wanted)}`
        : "Section cleared — plays the whole item",
      "ok",
    )
  } catch (e) {
    setStatus(`Save failed: ${(e as Error).message}`, "err")
  }

  entry.refresh()
}
