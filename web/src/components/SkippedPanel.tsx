import { Accordion, Button } from "@charcuterie/ui"
import { useEffect, useState } from "react"

import { api } from "../lib/api"
import type { SkippedItem } from "../lib/types"
import { unskipItem } from "../state/queueEntry"
import { useStore } from "../state/store"

/**
 * SKIPPED — the items this queue will never play, and the only way to put one back.
 *
 * A skip is written from a tile ("Skip this one" on the tile menu) and is permanent until it
 * is cleared, so it needs somewhere to be VISIBLE. Without this panel the list is invisible
 * state: the tile just quietly names a different episode, and there is nothing on the screen
 * that says why or how to undo it — which is exactly the complaint a filtered pool's
 * blocklist panel answers on the Pools screen.
 *
 * Collapsed by default and absent when the list is empty. It is a review surface, not part of
 * the everyday queue, and a permanently-open panel above the grid would push the tiles down
 * on every queue that has ever skipped one episode.
 *
 * ROWS, not cards. The lists-are-a-grid rule is about repeating CARD-shaped items; these are
 * one line each with one control, the same shape `#ch-block` already uses for the blocklist.
 */
export function SkippedPanel({ setId }: { setId: string }) {
  const { reg } = useStore()
  const set = reg?.sets.find((s) => s.id === setId)
  const keys = set?.skipped || []
  const [items, setItems] = useState<SkippedItem[] | null>(
    null,
  )

  // Keyed on the LIST, not on the set: the panel has to re-read after a skip or a restore,
  // and both of those change `skipped` in the store before this effect runs. `join` rather
  // than the array itself, because a fresh array identity arrives on every unrelated refresh.
  const listKey = keys.join(",")

  useEffect(() => {
    if (!listKey) {
      setItems([])

      return
    }

    let isStale = false

    api<{ items: SkippedItem[] }>(
      "GET",
      `/api/sets/${setId}/skipped`,
    )
      .then((res) => {
        if (!isStale) setItems(res.items)
      })
      .catch(() => {
        // The names are a nicety; the keys are the truth. A failed lookup still lists every
        // skip by its ratingKey, so the ✕ works when Plex does not.
        if (!isStale) setItems(null)
      })

    return () => {
      isStale = true
    }
  }, [listKey, setId])

  if (!keys.length) return null

  const rows: SkippedItem[] =
    items ??
    keys.map((ratingKey) => ({
      episode: null,
      ratingKey,
      season: null,
      show: null,
      title: `#${ratingKey}`,
      type: null,
      year: null,
    }))

  return (
    <Accordion
      className="skippanel"
      // TWO, not three. The panel is a direct section of the queue page, whose only other
      // heading is the `<h1>` in `Header.tsx` — nothing on this route sits at 2, so a 3 here
      // would skip a level in the document outline. Charcuterie's own note on this prop says
      // no gate can catch it, because the right answer depends entirely on the page.
      headingLevel={2}
      items={[
        {
          content: (
            <ul className="skiplist">
              {rows.map((row) => (
                <li key={row.ratingKey}>
                  <span>{skippedLabel(row)}</span>
                  <Button
                    appearance="outline"
                    intent="neutral"
                    onClick={() => {
                      void unskipItem(
                        setId,
                        row.ratingKey,
                        skippedLabel(row),
                      )
                    }}
                    size="sm"
                  >
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          ),
          key: "skipped",
          label: `Skipped — ${keys.length} ${keys.length === 1 ? "item" : "items"}`,
        },
      ]}
    />
  )
}

/**
 * One skipped item, named well enough to recognise out of context.
 *
 * An episode cannot name itself — "Episode 5" is every show's episode 5 — so the series
 * leads and the S/E and the episode title follow. The "S1" is KEPT here, unlike on a tile
 * (`seLabel` drops it for a single-season show): this list mixes shows, and the row has no
 * poster and no `multiSeason` to decide with, so the number that is always right wins over
 * the one that is shorter.
 */
export function skippedLabel(item: SkippedItem): string {
  if (item.show) {
    const se =
      item.season == null
        ? `E${item.episode ?? "?"}`
        : `S${item.season} · E${item.episode ?? "?"}`

    return `${item.show} — ${se}${item.title ? ` — ${item.title}` : ""}`
  }

  return item.year
    ? `${item.title} (${item.year})`
    : item.title
}
