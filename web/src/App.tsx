import { Route, Routes } from "react-router"
import { AppFrame } from "./app/AppFrame"
import { BoardGameCollectionPage } from "./app/BoardGameCollectionPage"
import { CalendarPage } from "./app/CalendarPage"
import { ChannelsPage } from "./app/ChannelsPage"
import { CollectionLandingPage } from "./app/CollectionLandingPage"
import { LegacyAdminPage } from "./app/LegacyAdminPage"
import { LegacyBoardGameCollectionPage } from "./app/LegacyBoardGameCollectionPage"
import { LegacyChannelsPage } from "./app/LegacyChannelsPage"
import { LegacyGroupPage } from "./app/LegacyGroupPage"
import { LegacyPicksPage } from "./app/LegacyPicksPage"
import { LegacyWatchPlayPage } from "./app/LegacyWatchPlayPage"
import { ModeLandingPage } from "./app/ModeLandingPage"
import { OverviewPage } from "./app/OverviewPage"
import { PendingPage } from "./app/PendingPage"
import { PeoplePage } from "./app/PeoplePage"
import { QueuePage } from "./app/QueuePage"
import { QueuesPage } from "./app/QueuesPage"
import { ResultPage } from "./app/ResultPage"
import { SettingsPage } from "./app/SettingsPage"
import { WatchPlayPage } from "./app/WatchPlayPage"
import { ROUTE_PATHS } from "./lib/routePaths"

/**
 * THE ROUTE TABLE. One `<Route>` per address, under one pathless layout route that carries
 * everything which outlives a page: the store subscription, the selection bar and the
 * overlays.
 *
 * Every path is a constant from `lib/routePaths.ts`, which is also what the pure test matches
 * against — so there is one table, not a table and a parser that have to agree
 * (decision `2026-08-27-the-route-table-is-react-router-not-a-parsed-pathname`).
 *
 * The LEGACY routes each paint the page their address moved to and rewrite the URL
 * underneath, rather than redirecting first and painting second. A `<Navigate>` would blank
 * the screen for a frame, and these are addresses people bookmarked — `/g/<id>` for nine
 * days, `/collection` for a few hours, `/tonight` until it was renamed.
 */
export const appRouteElements = (
  <Route element={<AppFrame />}>
    <Route
      element={<ModeLandingPage />}
      path={ROUTE_PATHS.home}
    />
    <Route
      element={<LegacyAdminPage />}
      path={ROUTE_PATHS.admin}
    />
    <Route
      element={<PeoplePage />}
      path={ROUTE_PATHS.people}
    />
    <Route
      element={<OverviewPage />}
      path={ROUTE_PATHS.overview}
    />
    <Route
      element={<PendingPage />}
      path={ROUTE_PATHS.pending}
    />
    <Route
      element={<CollectionLandingPage />}
      path={ROUTE_PATHS.collection}
    />
    <Route
      element={<BoardGameCollectionPage />}
      path={ROUTE_PATHS.boardGameCollection}
    />
    <Route
      element={<ResultPage />}
      path={ROUTE_PATHS.result}
    />
    <Route
      element={<WatchPlayPage />}
      path={ROUTE_PATHS.watchPlay}
    />
    <Route
      element={<QueuesPage />}
      path={ROUTE_PATHS.queues}
    />
    <Route
      element={<CalendarPage />}
      path={ROUTE_PATHS.calendar}
    />
    <Route
      element={<SettingsPage />}
      path={ROUTE_PATHS.settings}
    />
    <Route
      element={<ChannelsPage />}
      path={ROUTE_PATHS.channels}
    />
    <Route
      element={<QueuePage />}
      path={ROUTE_PATHS.queue}
    />

    <Route
      element={<LegacyGroupPage />}
      path={ROUTE_PATHS.legacyGroup}
    />
    <Route
      element={<LegacyPicksPage />}
      path={ROUTE_PATHS.legacyPicks}
    />
    <Route
      element={<LegacyChannelsPage />}
      path={ROUTE_PATHS.legacyChannels}
    />
    <Route
      element={<LegacyBoardGameCollectionPage />}
      path={ROUTE_PATHS.legacyBoardGameCollection}
    />
    <Route
      element={<LegacyWatchPlayPage />}
      path={ROUTE_PATHS.legacyTonight}
    />

    {/* An unknown path paints the mode landing rather than a blank page, and keeps the
        address — the server hands index.html to ANY extensionless path, so this is the only
        thing standing between a typo'd URL and an empty shell. */}
    <Route
      element={<ModeLandingPage />}
      path={ROUTE_PATHS.fallback}
    />
  </Route>
)

export function App() {
  return <Routes>{appRouteElements}</Routes>
}
