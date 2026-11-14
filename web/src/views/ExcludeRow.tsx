import { Button } from "@charcuterie/ui"
import { useEffect, useState } from "react"
import { api } from "../lib/api"
import type { RegistrySet } from "../lib/types"
import { setStatus } from "../state/store"
import { patchActiveBinding } from "./ChannelPool"

/** The movies-channel rewatch excludes — the movie analogue of the shows blocklist,
 * per binding since PR 4. */
export function ExcludeRow({
  channel,
  currentProfile,
  excludes,
  onChanged,
  ratingKey,
}: {
  channel: RegistrySet
  currentProfile: string | null
  excludes: string[]
  ratingKey: string
  onChanged: () => Promise<void>
}) {
  const [title, setTitle] = useState(`#${ratingKey}`)

  useEffect(() => {
    let isStale = false

    api<{ title: string }>("GET", `/api/item/${ratingKey}`)
      .then((md) => {
        if (!isStale) setTitle(md.title)
      })
      .catch(() => {})

    return () => {
      isStale = true
    }
  }, [ratingKey])

  return (
    <li>
      <span>{title}</span>
      <Button
        appearance="outline"
        intent="neutral"
        onClick={async () => {
          setStatus("Un-excluding…")

          try {
            await patchActiveBinding(
              channel,
              currentProfile,
              {
                movie_excludes: excludes.filter(
                  (exclude) => exclude !== ratingKey,
                ),
              },
            )
            await onChanged()
            setStatus("Un-excluded", "ok")
          } catch (error) {
            setStatus(
              `Un-exclude failed: ${(error as Error).message}`,
              "err",
            )
          }
        }}
        size="sm"
      >
        Un-exclude
      </Button>
    </li>
  )
}
