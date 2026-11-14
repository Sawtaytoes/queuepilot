import { Button } from "@charcuterie/ui"
import { useEffect, useState } from "react"
import { api } from "../lib/api"
import type { RegistrySet } from "../lib/types"
import { setStatus } from "../state/store"

/** A blocklist entry is a ratingKey (one show/item) OR "Collection: <name>" (the
 * whole collection — the pool scan expands it to every member's ratingKey). */
export function BlocklistRow({
  channel,
  entry,
  onChanged,
}: {
  channel: RegistrySet
  entry: string
  onChanged: () => Promise<void>
}) {
  const collection = /^\s*collection:\s*(.+)$/i.exec(
    String(entry),
  )
  const [title, setTitle] = useState(
    collection ? collection[1]! : `#${entry}`,
  )

  useEffect(() => {
    if (collection) return

    let isStale = false

    api<{ title: string }>("GET", `/api/item/${entry}`)
      .then((md) => {
        if (!isStale) setTitle(md.title)
      })
      .catch(() => {})

    return () => {
      isStale = true
    }
  }, [collection, entry])

  return (
    <li>
      <span>
        {title}
        {collection ? (
          <>
            {" "}
            <span className="collbadge">Collection</span>
          </>
        ) : null}
      </span>
      {/* `#ch-block button` / `#ch-movieexcludes button` painted the same small outline
          control in two places. Both are ELEMENT selectors, so they would have kept matching
          a Charcuterie `Button` and outranked it — they are deleted, and the look is
          `appearance="outline"` at `size="sm"`. */}
      <Button
        appearance="outline"
        intent="neutral"
        onClick={async () => {
          setStatus("Unblocking…")

          try {
            await api("PATCH", `/api/sets/${channel.id}`, {
              blocklist: channel.blocklist.filter(
                (blocked) => blocked !== entry,
              ),
            })
            await onChanged()
            setStatus("Unblocked", "ok")
          } catch (error) {
            setStatus(
              `Unblock failed: ${(error as Error).message}`,
              "err",
            )
          }
        }}
        size="sm"
      >
        Unblock
      </Button>
    </li>
  )
}
