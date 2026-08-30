import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
} from "react"
import {
  Outlet,
  Route,
  Routes,
  useLocation,
  useMatch,
  useNavigate,
  useParams,
} from "react-router"

import { Page, usePageChrome } from "./components/Page"
import { PlayMenu } from "./components/PlayMenu"
import { SelectionBar } from "./components/SelectionBar"
import { Toolbar } from "./components/Toolbar"
import { isRandomOrder } from "./lib/kind"
import { activeSet } from "./lib/nowPlaying"
import {
  canonicalCollectionPath,
  canonicalWatchPlayPath,
  ROUTE_PATHS,
  WATCH_PLAY_PATH,
} from "./lib/routePaths"
import {
  resolveChannel,
  useChannelSelection,
} from "./state/channelSelection"
import { startLiveUpdates } from "./state/live"
import {
  closePlayMenus,
  useOverlays,
} from "./state/overlays"
import {
  load,
  rotationChannels,
  useStore,
} from "./state/store"
import { ChannelsView } from "./views/ChannelsView"
import { CollectionLandingView } from "./views/CollectionLandingView"
import { CollectionView } from "./views/CollectionView"
import { ModeLandingView } from "./views/ModeLandingView"
import { PendingView } from "./views/PendingView"
import { PeopleView } from "./views/PeopleView"
import { PlayView } from "./views/PlayView"
import { QueuesView } from "./views/QueuesView"
import { QueueView } from "./views/QueueView"
import { ResultView } from "./views/ResultView"
import { TonightView } from "./views/TonightView"

/**
 * The overlays are code-split and hung off overlay state — they are ~1,400 lines of TSX
 * (`DynModal` alone is 671) that the landing route never renders, and the landing route is
 * the LCP.
 *
 * **The VIEWS are not split, and each one now mounts only on its own route.** They used to be
 * mounted all at once and toggle the `hidden` attribute, which is what the vanilla app did;
 * the route table replaced that on 2026-08-27. A `Suspense` boundary INSIDE a view would
 * still be wrong: the e2e suites read a view's internals in the same tick they assert the
 * container is on screen — `channels-test` does `waitForSelector('#queue:not([hidden])')` and
 * then `$('#qplay:not([hidden])')` — so the shell must not paint one commit before the body.
 *
 * The overlays have no such contract: every suite CLICKS them open first, and Playwright's
 * selectors auto-wait, so the one-time chunk fetch is invisible.
 */
const DynModal = lazy(async () => ({
  default: (await import("./components/DynModal")).DynModal,
}))
const SetModal = lazy(async () => ({
  default: (await import("./components/SetModal")).SetModal,
}))
const PeopleModal = lazy(async () => ({
  default: (await import("./components/PeopleModal"))
    .PeopleModal,
}))
const GroupsModal = lazy(async () => ({
  default: (await import("./components/GroupsModal"))
    .GroupsModal,
}))
const StartModal = lazy(async () => ({
  default: (await import("./components/StartModal"))
    .StartModal,
}))
const MembersModal = lazy(async () => ({
  default: (await import("./components/MembersModal"))
    .MembersModal,
}))
const TileMenu = lazy(async () => ({
  default: (await import("./components/TileMenu")).TileMenu,
}))

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

/**
 * The layout route: everything that must outlive a page change.
 *
 * `<Outlet />` is where the page goes, and it is FIRST — the header is part of a page, so the
 * DOM order is header, now-playing bar, view, then the selection bar and the overlays, which
 * is the order the vanilla app had.
 */
function AppFrame() {
  const { pathname: path } = useLocation()

  // React Router keeps the document scroll position when it swaps routes. Each route is a
  // new page here, so start it at the top before the new page paints. QueuesView restores its
  // saved position after this when somebody returns to Picks.
  useLayoutEffect(() => {
    window.scrollTo(0, 0)
  }, [path])

  useEffect(() => {
    void load()

    return startLiveUpdates()
  }, [])

  // A route change closes any floating device menu, as the vanilla `route()` did.
  useEffect(closePlayMenus, [path])

  // The bulk-edit bar acts on the OPEN queue, which only `/q/<id>` has. `useMatch` is
  // react-router asking the same question the route table does, one level above it.
  const queueMatch = useMatch(ROUTE_PATHS.queue)

  // Gate each lazy overlay's chunk fetch on its own overlay state, so importing it is
  // deferred until the user actually opens it. The overlays self-gate to `null` when their
  // state is falsy, but a lazy component still triggers its import the moment it is mounted —
  // so the mount itself has to be conditional, not just the render inside it. `PlayMenu`
  // stays eager: it is small and the play button is on the landing route.
  const overlays = useOverlays()

  return (
    <>
      <Outlet />

      <SelectionBar
        currentSet={queueMatch?.params.setId ?? null}
      />

      {/* A single Suspense with a null fallback: an overlay opens on a user gesture, and a
          spinner for the ~15 ms chunk fetch would flash worse than nothing. */}
      <Suspense fallback={null}>
        {overlays.setModal ? <SetModal /> : null}
        {overlays.dynModal ? <DynModal /> : null}
        {overlays.peopleModal ? <PeopleModal /> : null}
        {overlays.groupsModal ? <GroupsModal /> : null}
        {overlays.startModal ? <StartModal /> : null}
        {overlays.membersModal ? <MembersModal /> : null}
        {overlays.tileMenu ? <TileMenu /> : null}
      </Suspense>
      <PlayMenu />
    </>
  )
}

/** The task-based front door: two starts, five management links, and no work-page shell. */
function ModeLandingPage() {
  usePageChrome({
    bodyClass: "mode-view",
    documentTitle: "QueuePilot",
  })

  return <ModeLandingView />
}

function PeoplePage() {
  return (
    <Page
      back={{ label: "‹ QueuePilot", target: "/" }}
      bodyClass="queue-view"
      documentTitle="People — QueuePilot"
      editableSetId={null}
      heading="People"
      isSubHidden={false}
      sub="Manage the roster and the saved audience rules that queues can reuse."
    >
      <PeopleView />
    </Page>
  )
}

/**
 * The former Admin card wall stays unlinked while its card interactions move to their
 * focused pages. It is not a navigation destination and `/admin` does not resolve here.
 */
function OverviewPage() {
  return (
    <Page
      back={{
        label: "‹ QueuePilot",
        target: ROUTE_PATHS.home,
      }}
      bodyClass="queue-view play-view"
      documentTitle="Overview — QueuePilot"
      editableSetId={null}
      heading="Overview"
      isSubHidden={false}
      sub="Compatibility view for queue and rules card actions."
    >
      <PlayView />
    </Page>
  )
}

function PendingPage() {
  return (
    <Page
      back={{
        label: "‹ QueuePilot",
        target: ROUTE_PATHS.home,
      }}
      // `queue-view` is what HIDES the Queues toolbar. Without it the landing's
      // add-to-any-queue search, queue filter and "New queue" all leak into this page's
      // header.
      bodyClass="queue-view"
      documentTitle="Pending — QueuePilot"
      editableSetId={null}
      heading="Pending"
      isSubHidden={false}
      sub="New in your libraries, and not picked up by any Picks or Rules queue yet."
    >
      <PendingView />
    </Page>
  )
}

function CollectionLandingPage() {
  return (
    <Page
      back={{
        label: "‹ QueuePilot",
        target: ROUTE_PATHS.home,
      }}
      // `queue-view` is what HIDES the Queues toolbar — the same reuse Pending and What to
      // Watch/Play make of it.
      bodyClass="queue-view"
      documentTitle="Collection — QueuePilot"
      editableSetId={null}
      heading="Collection"
      isSubHidden={false}
      sub="Choose which QueuePilot-maintained collection to view."
    >
      <CollectionLandingView />
    </Page>
  )
}

function BoardGameCollectionPage() {
  return (
    <Page
      back={{
        label: "‹ Collection",
        target: ROUTE_PATHS.collection,
      }}
      bodyClass="queue-view"
      documentTitle="Board Games — QueuePilot"
      editableSetId={null}
      heading="Board Games"
      isSubHidden={false}
      sub="Every board game on the shelf. Mark one played, and say who was at the table."
    >
      <CollectionView />
    </Page>
  )
}

function ResultPage() {
  const { gameId } = useParams()

  return (
    <Page
      // BACK GOES TO WHAT TO WATCH/PLAY, not to the landing: this card is the end of that
      // form, and "change the answers" is the thing somebody wants next when the pick is
      // wrong.
      back={{
        label: "‹ What to Watch/Play",
        target: WATCH_PLAY_PATH,
      }}
      bodyClass="queue-view"
      documentTitle="Your pick — QueuePilot"
      editableSetId={null}
      heading="Your pick"
      isSubHidden={false}
      // WP-7: this card is now one of TWO answers — a game off the shelf, or a queue for the
      // evening — so the sentence says the half they share. It used to promise "say you
      // played it", which a queue card does not offer at all: a queue records its own
      // progress when it plays.
      sub="One answer. Reroll it, or start it."
    >
      <ResultView gameId={gameId ?? null} />
    </Page>
  )
}

/** `/what-to-watch-play/<step>` — one view, two steps, and neither is a view of its own. */
function WatchPlayPage() {
  const { step } = useParams()

  return (
    <Page
      back={{ label: "‹ QueuePilot", target: "/" }}
      // `queue-view` is what HIDES the Queues toolbar — the same reuse Pending makes of it.
      bodyClass="queue-view"
      documentTitle="What to Watch/Play — QueuePilot"
      editableSetId={null}
      heading="What to Watch/Play"
      isSubHidden={false}
      sub="Choose who is here, what you want to do, and what to start."
    >
      <TonightView step={watchPlayStep(step)} />
    </Page>
  )
}

/** Anything else in that segment is the bare form, which is what an unknown step deserves. */
function watchPlayStep(
  step: string | undefined,
): "go" | "surprise" | null {
  return step === "go" || step === "surprise" ? step : null
}

function QueuesPage() {
  return (
    <Page
      // Picks is a top-level configurator.
      back={{
        label: "‹ QueuePilot",
        target: ROUTE_PATHS.home,
      }}
      bodyClass=""
      documentTitle="Queues — QueuePilot"
      editableSetId={null}
      heading="Queues"
      isSubHidden={false}
      sub="Choose a Picks or Rules queue to view it, or create a new queue."
    >
      <QueuesView toolbar={<Toolbar />} />
    </Page>
  )
}

function ChannelsPage() {
  const navigate = useNavigate()
  const { channelId: routeId } = useParams()
  const { reg } = useStore()

  // WHICH channel is selected is module state, not route state — the bare `/channels` route
  // names none — and the heading's sub-line and the `movies-channel` body class both depend
  // on it. Same split the vanilla app had.
  const { channelId } = useChannelSelection()
  const channel = resolveChannel(
    reg,
    routeId ?? null,
    channelId,
  )
  const isMovies = channel?.behavior === "rewatch"

  // A redirect the vanilla render functions did with `location.assign`.
  useEffect(() => {
    if (reg && !rotationChannels(reg).length)
      navigate(ROUTE_PATHS.home)
  }, [navigate, reg])

  return (
    <Page
      back={{
        label: "‹ Queues",
        target: ROUTE_PATHS.queues.replace("/*", ""),
      }}
      // `queue-view` reuse: it hides the queues toolbar.
      bodyClass={
        isMovies
          ? "queue-view movies-channel"
          : "queue-view"
      }
      documentTitle={`${channel?.label ?? "Rules queue"} — QueuePilot`}
      editableSetId={null}
      heading={channel?.label ?? "Rules queue"}
      isSubHidden={false}
      sub={
        isMovies
          ? "The Movies rules queue: a weighted rewatch of films this account has seen — least-watched most likely."
          : "A rules queue: these filters shape what it can draw from the library."
      }
    >
      <ChannelsView routeId={routeId ?? null} />
    </Page>
  )
}

/** One curated queue or rules pool as a grid — the only page whose chrome is data. */
function QueuePage() {
  const navigate = useNavigate()
  const { setId = "" } = useParams()
  const { data, now, reg } = useStore()

  // A redirect the vanilla render functions did with `location.assign`. Waits for `data`:
  // before it lands, "no such queue" and "not fetched yet" look the same.
  useEffect(() => {
    if (!data) return

    if (data.sets[setId]?.source !== "queue")
      navigate(ROUTE_PATHS.queues.replace("/*", ""))
  }, [data, navigate, setId])

  const q = data?.sets[setId]
  const registrySet = reg?.sets.find((s) => s.id === setId)
  const label = q?.label ?? "QueuePilot"
  const isChannel = isRandomOrder(registrySet ?? q)
  // Plex's words unless the registry says otherwise, so a response that predates
  // `vocabulary` renders exactly as it always did.
  const vocab = registrySet?.vocabulary ?? {
    done: "watched",
    member: "show",
    name: "Plex",
    unit: "episode",
    units: "episodes",
    verb: "Play",
  }
  const playing = activeSet(now, data)
  const queuesPath = ROUTE_PATHS.queues.replace("/*", "")
  const isPlayingThis = Boolean(
    playing && playing === setId,
  )
  const n = now.now

  return (
    <Page
      back={{ label: "‹ Queues", target: queuesPath }}
      bodyClass={
        isChannel ? "queue-view channel-mode" : "queue-view"
      }
      documentTitle={`${label} — QueuePilot`}
      editableSetId={setId}
      heading={label}
      // This queue is the running session — say what's on screen (the matching tile is
      // highlighted too, but a long queue can scroll it out of view).
      isSubHidden={isPlayingThis ? false : !isChannel}
      navigationHref={queuesPath}
      sub={
        isPlayingThis && n
          ? `${n.state === "paused" ? "⏸ Paused" : "▶ Now playing"}${n.title || n.showTitle ? ` — ${n.title || n.showTitle}` : ""}`
          : isChannel
            ? // A curated pool's members play in a shuffled order — say so, and drop the
              // ordering UI. In the PROVIDER's nouns: on a reading pool this used to promise
              // "how many episodes each show plays per visit", which is two wrong words in
              // one sentence. "contributes" is the neutral verb the type declarations already
              // use for this number, so the sentence needs no per-provider branch.
              `A Picks queue — members come up in random order; pick how many ${vocab.units} each ${vocab.member} contributes per visit.`
            : ""
      }
    >
      <QueueView setId={setId} />
    </Page>
  )
}

/**
 * A path that MOVED, rewritten to its new address while the page it moved to is already on
 * screen.
 *
 * REPLACES the entry rather than pushing one: a pushed redirect makes Back land on the old
 * path, which redirects forward again and the button reads as dead. Search and hash are
 * carried across — no legacy route uses one today, and dropping them silently is the kind of
 * thing a later route would inherit.
 */
function useCanonicalPath(canonical: string): void {
  const navigate = useNavigate()
  const { hash, pathname, search } = useLocation()

  useEffect(() => {
    if (pathname === canonical) return

    navigate(canonical + search + hash, { replace: true })
  }, [canonical, hash, navigate, pathname, search])
}

/**
 * `/g/<group>`, which no longer exists. The tail is deliberately DROPPED: there is no
 * per-group address to move a group id to. The people filter is not a translation of a group
 * — a group is a saved set of people, and picking the same people by hand is a different
 * assertion — so guessing one would be worse than landing on everything.
 */
function LegacyGroupPage() {
  useCanonicalPath(ROUTE_PATHS.people)

  return <PeoplePage />
}

function LegacyAdminPage() {
  useCanonicalPath(ROUTE_PATHS.home)

  return <ModeLandingPage />
}

function LegacyPicksPage() {
  useCanonicalPath(ROUTE_PATHS.queues.replace("/*", ""))

  return <QueuesPage />
}

function LegacyChannelsPage() {
  useCanonicalPath(ROUTE_PATHS.queues.replace("/*", ""))

  return <QueuesPage />
}

function LegacyBoardGameCollectionPage() {
  const params = useParams()

  useCanonicalPath(canonicalCollectionPath(params["*"]))

  return <BoardGameCollectionPage />
}

function LegacyWatchPlayPage() {
  const { step } = useParams()

  useCanonicalPath(canonicalWatchPlayPath(step))

  return <WatchPlayPage />
}
