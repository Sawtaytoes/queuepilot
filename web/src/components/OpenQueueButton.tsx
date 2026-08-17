import type { RegistrySet } from "../lib/types"
import { PLEX_WORDS } from "../lib/vocab"

/**
 * The start affordance for a queue, chosen by how that queue actually starts.
 *
 * Plex is **push**: a lineup is sent at a device, so the button opens the device menu and
 * "Play on ▾" is the honest label. Kavita is **pull** — it has no cast and no webhooks at
 * all, so there is no device to offer and a device menu listing the Shield, Plex Dash and
 * Pollycracker is offering three things that cannot possibly work
 * (docs/kavita-feasibility.md §4).
 *
 * For a pull queue the app hands back a URL instead: `/go/<id>` rebuilds the reading list
 * and 302s into the reader at the current chapter. It is a plain link so it can be
 * middle-clicked, bookmarked, or dropped on a home screen — which is the whole point of the
 * launcher being one stable URL per queue.
 *
 * Branches on `delivery`, never on the provider's name.
 *
 * **What it SAYS comes from the provider's vocabulary, not from this file.** The label was a
 * hardcoded `▶ Open ↗`, which was wrong twice over on a manga queue: "Open" is what a *file*
 * does, and the play triangle promised a screen. Kavita's vocabulary already answers both —
 * `verb: "Read"`, `startIcon: "📖"` — so the button reads `📖 Read ↗` there and `🎲 Play ↗` on
 * the board-game picker, with no branch on the provider's name.
 * (decisions `2026-08-15-a-provider-carries-its-own-vocabulary`,
 * `2026-08-16-copy-is-authored-in-plex-words-and-rewritten-per-provider`)
 */
export function OpenQueueButton({
  set,
}: {
  set: Pick<RegistrySet, "id" | "delivery" | "vocabulary">
}) {
  const words = set.vocabulary ?? PLEX_WORDS
  const verb = words.verb || PLEX_WORDS.verb
  const icon = words.startIcon || PLEX_WORDS.startIcon

  return (
    <a
      className="playbtn openbtn"
      href={`/go/${encodeURIComponent(set.id)}`}
      id="qopen"
      rel="noreferrer"
      // A new tab, so the queue list you launched from is still there when you come back
      // from the reader.
      target="_blank"
      // `↗` (this leaves the app) stays in the LABEL rather than moving into the vocabulary:
      // it is a fact about the launcher, true for every pull provider, not a word any of them
      // gets to choose.
      title={`Rebuild the list and open it where you left off in ${words.name || PLEX_WORDS.name}`}
    >
      {icon} {verb} ↗
    </a>
  )
}

/** True when this set starts by handing back a URL rather than by pushing at a device. */
export const isPullSet = (
  set: Pick<RegistrySet, "delivery"> | null | undefined,
) => set?.delivery === "pull"
