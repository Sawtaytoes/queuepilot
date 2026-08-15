import { type ReactNode, useState } from "react"

import { thumbUrl } from "../lib/api"

type Props = {
  /** The item's id in ITS provider. Only meaningful with no `cover` — see below. */
  ratingKey?: string | number | null
  /**
   * The server-sent artwork URL, for an item that is not Plex's. Wins over `ratingKey`,
   * because the fallback (`/api/thumb/<ratingKey>`) is the PLEX poster proxy: handed a
   * Kavita seriesId it answers 502, which is the broken-image row the search dropdown
   * showed for every reading result until 2026-08-15.
   */
  cover?: string | null
  className?: string
  /** Shown when there is no artwork to ask for, or when what we asked for failed to load. */
  fallback?: ReactNode
}

/**
 * One entry's artwork, wherever an entry appears — queue tile, member tile, pool tile,
 * search dropdown.
 *
 * It exists because the URL is not always derivable from the id: Plex's is, every other
 * provider's is not (its bytes are re-served so the API key stays server-side), so the choice
 * has to be made in one place rather than at each of the six `<img src={thumbUrl(...)}>` call
 * sites that used to make it. The load failure is handled here too — a missing cover is
 * normal (a series with no art), and the browser's broken-image glyph is not a design.
 */
export function Poster({
  className,
  cover,
  fallback = null,
  ratingKey,
}: Props) {
  // The src that FAILED, not a boolean: a new src then gets its own attempt with no effect
  // to reset anything.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(
    null,
  )
  const src =
    cover ||
    (ratingKey == null ? null : thumbUrl(ratingKey))

  if (!src || src === brokenSrc) return <>{fallback}</>

  return (
    <img
      alt=""
      className={className}
      draggable={false}
      loading="lazy"
      onError={() => setBrokenSrc(src)}
      src={src}
    />
  )
}
