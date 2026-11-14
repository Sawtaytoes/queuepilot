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
  // `(.+)` always captures on a match, so a name is present exactly when the entry is a
  // `collection:` line.
  const collectionName = /^\s*collection:\s*(.+)$/i.exec(
    String(entry),
  )?.[1]
  const isCollection = collectionName !== undefined
  const [title, setTitle] = useState(
    collectionName ?? `#${entry}`,
  )

  useEffect(() => {
    if (isCollection) return

    let isStale = false

    api<{ title: string }>("GET", `/api/item/${entry}`)
      .then((md) => {
        if (!isStale) setTitle(md.title)
      })
      .catch(() => {})

    return () => {
      isStale = true
    }
  }, [isCollection, entry])

  return (
    <li>
      <span>
        {title}
        {isCollection ? (
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
