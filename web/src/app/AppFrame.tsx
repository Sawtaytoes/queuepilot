import { lazy, Suspense, useEffect } from "react"
import { Outlet, useLocation, useMatch } from "react-router"
import { PlayMenu } from "../components/PlayMenu"
import { SelectionBar } from "../components/SelectionBar"
import { ROUTE_PATHS } from "../lib/routePaths"
import { startLiveUpdates } from "../state/live"
import {
  closePlayMenus,
  useOverlays,
} from "../state/overlays"
import { load } from "../state/store"

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
  default: (await import("../components/DynModal"))
    .DynModal,
}))

const SetModal = lazy(async () => ({
  default: (await import("../components/SetModal"))
    .SetModal,
}))

const PeopleModal = lazy(async () => ({
  default: (await import("../components/PeopleModal"))
    .PeopleModal,
}))

const GroupsModal = lazy(async () => ({
  default: (await import("../components/GroupsModal"))
    .GroupsModal,
}))

const StartModal = lazy(async () => ({
  default: (await import("../components/StartModal"))
    .StartModal,
}))

const MembersModal = lazy(async () => ({
  default: (await import("../components/MembersModal"))
    .MembersModal,
}))

const SectionModal = lazy(async () => ({
  default: (await import("../components/SectionModal"))
    .SectionModal,
}))

const TileMenu = lazy(async () => ({
  default: (await import("../components/TileMenu"))
    .TileMenu,
}))

/**
 * The layout route: everything that must outlive a page change.
 *
 * `<Outlet />` is where the page goes, and it is FIRST — the header is part of a page, so the
 * DOM order is header, now-playing bar, view, then the selection bar and the overlays, which
 * is the order the vanilla app had.
 */
export function AppFrame() {
  const { pathname: path } = useLocation()

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
        {overlays.isPeopleModalOpen ? (
          <PeopleModal />
        ) : null}
        {overlays.groupsModal ? <GroupsModal /> : null}
        {overlays.startModal ? <StartModal /> : null}
        {overlays.membersModal ? <MembersModal /> : null}
        {overlays.sectionModal ? <SectionModal /> : null}
        {overlays.tileMenu ? <TileMenu /> : null}
      </Suspense>
      <PlayMenu />
    </>
  )
}
