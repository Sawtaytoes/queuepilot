import { Badge } from "@charcuterie/ui"
import type { TileFace } from "../lib/tileFace"
import { Tip } from "./Tip"

/**
 * Plex's EDITION label on a tile — "3D", "Director's Cut", "Original TV Version".
 *
 * Two editions of one film are two library items with the same title and the same year. The
 * pickers learned to name them (`components/EditionBadge.tsx`, decision
 * `2026-08-21-every-picker-names-the-edition-and-the-entry-it-writes-carries-it`) and the tile
 * did not, so the moment a pick landed in a queue the pair went back to being two identical
 * captions.
 *
 * **ONE chip carrying the label, not the Collection chip's two-part `kind` + `name`.** The
 * two-part shape exists because a bare collection NAME is indistinguishable from a title —
 * "Chaika: The Coffin Princess" needs the word "Collection" in front of it to say what it is.
 * An edition label is already self-describing: nobody reads "Director's Cut" as a title. And
 * the tile is ~150px wide, so a fused "Edition" half would spend most of that width on the
 * word and ellipsise the half that carries the information.
 *
 * **A `Badge`, unlike the collection chip.** The reason that one stayed hand-rolled was its
 * two halves; one label has no such problem, so this is the component — which brings the cap
 * (`max-inline-size: 100%`) and the ellipsis with it, and is what keeps a long edition from
 * pushing the caption open at any width.
 *
 * **`neutral`, and that is not a free choice.** `accent` means In Progress, `success` means
 * Completed, `info` means Now playing and `danger` means Not in library. An edition is a NAME,
 * and every name and count on this tile is neutral
 * (decision `2026-08-15-badge-intent-means-one-thing`).
 *
 * It cannot re-open the noise that record closed. `TypeBadge` was noise because it fired on
 * every tile and repeated the poster; this fires only when Plex actually tagged the item, so a
 * grid of ordinary films renders none at all and the one that appears is the one telling two
 * otherwise-identical tiles apart.
 */
export function EditionChip({ face }: { face: TileFace }) {
  if (!face.edition) return null

  return (
    <Tip label={`Plex edition: “${face.edition}”`}>
      <Badge
        appearance="outline"
        className="badge edition"
        intent="neutral"
        size="sm"
        /**
         * `Badge` sets a native `title` of its own once the label clips, which is exactly
         * when this one clips — and a native tip beside the styled one is the same text
         * twice, ~800ms apart. Empty (not undefined) is what suppresses it; the `Tip` above
         * already carries the full name for the clipped case.
         */
        title=""
      >
        {face.edition}
      </Badge>
    </Tip>
  )
}
