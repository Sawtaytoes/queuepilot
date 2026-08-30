import type { NavRailItem } from "@charcuterie/ui"

import {
  ROUTE_PATHS,
  WATCH_PLAY_PATH,
} from "../lib/routePaths"

function NavigationIcon({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width="20"
    >
      {children}
    </svg>
  )
}

/** The app owns the destinations and glyphs. Charcuterie owns every layout they take. */
export const PRIMARY_NAVIGATION_ITEMS: readonly NavRailItem[] =
  [
    {
      href: WATCH_PLAY_PATH,
      icon: (
        <NavigationIcon>
          <circle cx="12" cy="12" r="9" />
          <path d="m10 8 6 4-6 4V8Z" />
        </NavigationIcon>
      ),
      label: "Watch/Play",
    },
    {
      href: ROUTE_PATHS.queues.replace("/*", ""),
      icon: (
        <NavigationIcon>
          <path d="M5 5h14v14H5z" />
          <path d="M8 9h8M8 12h8M8 15h5" />
        </NavigationIcon>
      ),
      label: "Queues",
    },
    {
      href: "/board-game-collection",
      icon: (
        <NavigationIcon>
          <path d="M5 4h14v16H5z" />
          <path d="M8 4v16M12 8h4M12 12h4" />
        </NavigationIcon>
      ),
      label: "Collection",
    },
    {
      href: ROUTE_PATHS.pending.replace("/*", ""),
      icon: (
        <NavigationIcon>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v6M12 17h.01" />
        </NavigationIcon>
      ),
      label: "Unqueued",
    },
    {
      href: ROUTE_PATHS.people,
      icon: (
        <NavigationIcon>
          <circle cx="9" cy="9" r="3" />
          <circle cx="17" cy="10" r="2" />
          <path d="M3.5 19c.7-3.2 2.6-5 5.5-5s4.8 1.8 5.5 5M15 15c2.8 0 4.5 1.3 5 4" />
        </NavigationIcon>
      ),
      label: "People",
    },
  ]
