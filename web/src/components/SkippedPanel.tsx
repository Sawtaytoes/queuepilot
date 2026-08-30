import { Accordion, Badge } from "@charcuterie/ui"
import { useEffect, useState } from "react"

import { api } from "../lib/api"
import { titleWithYear } from "../lib/mediaTitle"
import type { SkippedItem } from "../lib/types"
import { unskipItem } from "../state/queueEntry"
import type { Density } from "../state/queueView"
import { useStore } from "../state/store"
import { Poster } from "./Poster"

const RestoreGlyph = () => (
  <svg
    aria-hidden="true"
    fill="none"
    height="16"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 18 18"
    width="16"
  >
    <path d="M5 6H1.5V2.5" />
    <path d="M2 6a7 7 0 1 1-.1 5" />
  </svg>
)

/** Skipped leaves, shown after the queue in the same density as its active tiles. */
export function SkippedPanel({
  density,
  setId,
}: {
  density: Density
  setId: string
}) {
  const { reg } = useStore()
  const set = reg?.sets.find((s) => s.id === setId)
  const keys = set?.skipped || []
  const [items, setItems] = useState<SkippedItem[] | null>(
    null,
  )
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
        if (!isStale) setItems(null)
      })
    return () => {
      isStale = true
    }
  }, [listKey, setId])

  if (!keys.length) return null
  const rows = items ?? keys.map(fallbackItem)

  return (
    <Accordion
      className="skippanel"
      headingLevel={2}
      items={[
        {
          content: (
            <ul className={`grid skipgrid ${density}`}>
              {rows.map((row) => {
                const label = skippedLabel(row)
                return (
                  <li
                    className="tile skippedtile"
                    data-key={row.ratingKey}
                    key={row.ratingKey}
                  >
                    <div className="thumb">
                      <Poster
                        className="poster"
                        ratingKey={
                          row.posterRatingKey ??
                          row.ratingKey
                        }
                      />
                    </div>
                    <button
                      aria-label={`Restore “${label}”`}
                      className="skiprestore"
                      onClick={() =>
                        void unskipItem(
                          setId,
                          row.ratingKey,
                          label,
                        )
                      }
                      title="Restore"
                      type="button"
                    >
                      <RestoreGlyph />
                      <span>Restore</span>
                    </button>
                    <div className="cap">
                      <span className="title">
                        {row.webUrl ? (
                          <a
                            draggable={false}
                            href={row.webUrl}
                            rel="noreferrer"
                            target="_blank"
                          >
                            {label}
                          </a>
                        ) : (
                          label
                        )}
                      </span>
                      {row.sourceTitle ? (
                        <span className="badges">
                          <Badge
                            appearance="outline"
                            size="sm"
                          >
                            From {row.sourceTitle}
                          </Badge>
                        </span>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          ),
          key: "skipped",
          label: `Skipped — ${keys.length} ${keys.length === 1 ? "item" : "items"}`,
        },
      ]}
    />
  )
}

const fallbackItem = (ratingKey: string): SkippedItem => ({
  episode: null,
  posterRatingKey: null,
  ratingKey,
  season: null,
  show: null,
  sourceTitle: null,
  title: `#${ratingKey}`,
  type: null,
  webUrl: null,
  year: null,
})

export function skippedLabel(item: SkippedItem): string {
  if (item.show) {
    const se =
      item.season == null
        ? `E${item.episode ?? "?"}`
        : `S${item.season} · E${item.episode ?? "?"}`
    return `${item.show} — ${se}${item.title ? ` — ${item.title}` : ""}`
  }
  const named = titleWithYear(item.title, item.year)
  return item.editionTitle
    ? `${named} — ${item.editionTitle}`
    : named
}
