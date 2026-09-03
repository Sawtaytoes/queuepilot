import type { ActionTileItem } from "@charcuterie/ui"
import {
  ActionTiles,
  ColorSchemeSwitcher,
} from "@charcuterie/ui"

import {
  NAVIGATION_CATEGORICAL,
  PRIMARY_NAVIGATION_ITEMS,
} from "../components/PrimaryNavigation"
import { schemeIcons } from "../components/SchemeIcons"

const [watchPlayItem, queuesItem, ...managementItems] =
  PRIMARY_NAVIGATION_ITEMS

/**
 * The two starts, as tiles.
 *
 * These were hand-written `<Link>`s carrying `.mode-primary-action` — a bordered box, an
 * accent-coloured glyph, a title, a line of help and a `→`. That is `ActionTiles`, and it
 * is the fourth app to have grown the shape on its own: mux-magic's "Pick a tool",
 * gallery-downloader's home page and points-market's kid picker are the others.
 */
const PRIMARY_TILES: ActionTileItem[] = [
  {
    categorical: NAVIGATION_CATEGORICAL[watchPlayItem.href],
    hint: "Choose who is here and get one answer.",
    href: watchPlayItem.href,
    icon: watchPlayItem.icon,
    label: "What to Watch/Play",
    value: "watch-play",
  },
  {
    categorical: NAVIGATION_CATEGORICAL[queuesItem.href],
    hint: "Browse your saved picks and open one queue.",
    href: queuesItem.href,
    icon: queuesItem.icon,
    label: "Open a queue",
    value: "queues",
  },
]

/** The management row. Same shape, one step down the size ramp, and no line of help. */
const MANAGEMENT_TILES: ActionTileItem[] = [
  queuesItem,
  ...managementItems,
].map((item) => ({
  categorical: NAVIGATION_CATEGORICAL[item.href],
  href: item.href,
  icon: item.icon,
  label: item.label,
  value: item.href,
}))

/** The front door answers what to do next. It does not render the work itself. */
export function ModeLandingView() {
  return (
    <main className="mode-landing" id="mode-landing">
      <div className="mode-landing-scheme">
        <ColorSchemeSwitcher icons={schemeIcons} />
      </div>

      <div className="mode-landing-intro">
        <p className="mode-landing-eyebrow">QueuePilot</p>
        <h1>What do you want to do?</h1>
        <p>
          Start something, or go directly to one management
          area.
        </p>
      </div>

      {/* 420 rather than the default 200. The grid lays `auto-fill` tracks, so the floor
          decides how many tracks the CONTAINER gets — not how many tiles there are. The
          landing is 1040px wide less 48px of padding, so 420 admits exactly these two and
          drops to one column below ~890px, which is what the deleted
          `grid-template-columns: repeat(2, …)` plus its 760px media query used to say. */}
      <ActionTiles
        className="mode-primary-actions"
        items={PRIMARY_TILES}
        label="Start something"
        minTileInlineSize={420}
        size="lg"
      />

      <section
        className="mode-management"
        aria-labelledby="manage-heading"
      >
        <div className="mode-management-heading">
          <h2 id="manage-heading">Manage</h2>
          <p>Change one part of QueuePilot.</p>
        </div>

        <ActionTiles
          items={MANAGEMENT_TILES}
          label="Manage"
          minTileInlineSize={200}
          size="sm"
        />
      </section>
    </main>
  )
}
