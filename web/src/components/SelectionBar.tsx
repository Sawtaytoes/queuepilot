import { useState } from "react"
import { api } from "../lib/api"
import { openPlayMenu } from "../state/overlays"
import {
  clearSelection,
  useSelected,
} from "../state/selection"
import {
  channelSetIds,
  load,
  queueIds,
  setStatus,
  useStore,
} from "../state/store"
import { CountPicker } from "./CountPicker"
import { EPISODES_MAX, WEIGHT_MAX } from "./EntrySettings"
import { SelectListbox } from "./SelectListbox"

/**
 * The selection action bar — the settings you can apply to MANY entries at once, plus
 * "Move to `<queue>`" and Remove. Shown once at least one tile is selected.
 *
 * Editing in bulk is the point: a channel is dozens of entries, and "make these six 2x" or
 * "put every one of these back to the defaults" was previously six trips through a per-tile
 * dropdown. Each field is opt-in — a field left on "keep" is not sent, so applying a weight
 * never quietly rewrites the episode counts of the same selection.
 *
 * Moving between queues is multi-select, not drag: drag is for reordering WITHIN a
 * queue (decision `2026-07-20-queue-web-ui-ux-and-write-format`).
 *
 * The target list is the same FAMILY only — a queue's titles move to queues, a
 * channel's shows to channels. Mixing families would silently change an entry's
 * playback semantics from "top plays next" to "random rotation".
 */

const KEEP = "keep"

export function SelectionBar({
  currentSet,
}: {
  currentSet: string | null
}) {
  const { data } = useStore()
  const selected = useSelected()
  const [target, setTarget] = useState("")
  // `null` = "— keep —": the field is not part of this apply.
  const [episodes, setEpisodes] = useState<number | null>(
    null,
  )
  const [weight, setWeight] = useState<number | null>(null)
  const [batchStop, setBatchStop] = useState(KEEP)

  const family =
    currentSet && data?.sets[currentSet]?.kind === "anime"
      ? channelSetIds(data)
      : queueIds(data)
  const options = family.filter((id) => id !== currentSet)
  const value = options.includes(target)
    ? target
    : (options[0] ?? "")

  const count = selected.size
  // The single selected entry, when there is exactly one AND it is playable. Resolved-only
  // for the same reason the tile's ▶ is: an unresolved entry names nothing in the library,
  // so the start would fail after the device menu had already asked which TV.
  const only = (() => {
    if (count !== 1) return null

    const sel = [...selected.values()][0]!
    const item = data?.sets[sel.fromSet]?.items.find(
      (it) => it.key === sel.key,
    )

    return item?.resolved
      ? { ...sel, title: item.title }
      : null
  })()
  const hasEdit =
    episodes !== null ||
    weight !== null ||
    batchStop !== KEEP

  /** One PATCH for the whole selection — see the route's comment for why not N. */
  const applyBulk = async (
    body: Record<string, unknown>,
    verb: string,
  ) => {
    const items = [...selected.values()].map((s) => ({
      key: s.key,
      set: s.fromSet,
    }))

    setStatus(`${verb}…`)

    try {
      const out = await api<{
        applied?: number
        failed?: unknown[]
      }>("PATCH", "/api/queues/bulk", { items, ...body })

      setStatus(
        `${verb} ${out.applied ?? 0} ${
          (out.applied ?? 0) === 1 ? "entry" : "entries"
        }`,
        "ok",
      )
      setEpisodes(null)
      setWeight(null)
      setBatchStop(KEEP)
      await load()
    } catch (e) {
      setStatus(
        `${verb} failed: ${(e as Error).message}`,
        "err",
      )
    }
  }

  return (
    <div hidden={count === 0} id="selbar">
      <span id="selcount">{`${count} selected`}</span>

      {/* Play, at the head of the bar — Plex puts ▶ first in its own selection bar, and this
          is the one action here that is about watching rather than editing. ONE entry only:
          a start is a single lineup on a single device, so "play these six" has no meaning
          the queue does not already have (that IS the queue). With more than one selected the
          button says so rather than vanishing, which would read as a missing feature. */}
      {only ? (
        <button
          id="selplay"
          onClick={(e) =>
            openPlayMenu({
              anchor:
                e.currentTarget.getBoundingClientRect(),
              only: only.key,
              onlyLabel: only.title,
              setId: only.fromSet,
            })
          }
          type="button"
        >
          ▶ Play on ▾
        </button>
      ) : (
        <button disabled id="selplay" type="button">
          ▶ Play — pick one
        </button>
      )}

      {/* --- the settings, applied together --- */}
      <div className="bulkfield">
        <span>Episodes</span>
        {episodes === null ? (
          <button
            className="ghost"
            onClick={() => setEpisodes(1)}
            type="button"
          >
            — keep —
          </button>
        ) : (
          <CountPicker
            label="Episodes for the selection"
            max={EPISODES_MAX}
            onChange={setEpisodes}
            value={episodes}
          />
        )}
      </div>
      <div className="bulkfield">
        <span>Weight</span>
        {weight === null ? (
          <button
            className="ghost"
            onClick={() => setWeight(1)}
            type="button"
          >
            — keep —
          </button>
        ) : (
          <CountPicker
            label="Weight for the selection"
            max={WEIGHT_MAX}
            onChange={setWeight}
            unit="x"
            value={weight}
          />
        )}
      </div>
      <div className="bulkfield">
        <span>Batch stops at</span>
        <SelectListbox
          id="bulkstop"
          label="Batch stops at"
          onChange={setBatchStop}
          options={[
            { label: "— keep —", value: KEEP },
            { label: "Follow the set", value: "" },
            { label: "End at season", value: "season" },
            { label: "End at show", value: "member" },
          ]}
          value={batchStop}
        />
      </div>
      <button
        className="primary"
        disabled={!hasEdit}
        id="bulkapply"
        onClick={() =>
          void applyBulk(
            {
              ...(episodes !== null ? { episodes } : {}),
              ...(weight !== null ? { weight } : {}),
              ...(batchStop !== KEEP
                ? { batch_stops_at: batchStop }
                : {}),
            },
            "Updated",
          )
        }
        type="button"
      >
        {`Apply to ${count}`}
      </button>
      <button
        id="bulkreset"
        onClick={() =>
          void applyBulk({ reset: true }, "Reset")
        }
        title="Back to 1 ep, 1x, follow the set, automatic start"
        type="button"
      >
        Reset to defaults
      </button>

      {/* --- the existing move/remove actions --- */}
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
            await api("POST", "/api/queues/move-bulk", {
              items,
              toSet: value,
            })
            setStatus(
              `Moved ${items.length} to ${data?.sets[value]?.label ?? value}`,
              "ok",
            )
            clearSelection()
            await load()
          } catch (e) {
            setStatus(
              `Move failed: ${(e as Error).message}`,
              "err",
            )
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
            await api("POST", "/api/queues/remove-bulk", {
              items,
            })
            clearSelection()
            await load()
          } catch (e) {
            setStatus(
              `Remove failed: ${(e as Error).message}`,
              "err",
            )
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
