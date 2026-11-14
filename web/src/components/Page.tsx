import {
  IconButton,
  Main,
  Nav,
  Rail,
  Shell,
  useNavLayout,
} from "@charcuterie/ui"
import { useEffect, useState } from "react"
import { useLocation } from "react-router"
import { useEffectOnChange } from "../hooks/useEffectOnChange"
import { CollapseIcon } from "./CollapseIcon"
import { Header } from "./Header"
import { MenuIcon } from "./MenuIcon"
import { NowPlayingBar } from "./NowPlayingBar"
import { PRIMARY_NAVIGATION_ITEMS } from "./PrimaryNavigation"

/**
 * ONE PAGE OF THE APP: its chrome, and the view under it.
 *
 * The header — heading, sub-line, back target, whether the heading is renameable — used to be
 * computed by a `computeChrome()` switch in `App`, one arm per route, because the views were
 * all mounted at once and only `App` knew which of them was on screen. There is a route table
 * now, so each page states its own chrome as props here and the switch is gone
 * (decision `2026-08-27-the-route-table-is-react-router-not-a-parsed-pathname`). It is the
 * same shape mail-sifter's `AppShell` has, for the same reason.
 *
 * `bodyClass` is a space-separated list rather than an array so it can be an effect
 * dependency without being rebuilt on every render.
 */

type Props = {
  /** Where the ‹ control goes, and what it says. Null on a top-level page. */
  back: { target: string; label: string } | null
  /** Body classes this page wants, e.g. `"queue-view play-view"`. */
  bodyClass: string
  children: React.ReactNode
  documentTitle: string
  /** The set whose label the heading edits, or null. */
  editableSetId: string | null
  heading: string
  isSubHidden: boolean
  sub: string
  /** The section to mark current when this route is a detail address such as `/q/<id>`. */
  navigationHref?: string
}

/**
 * The two chrome effects a page has even when it draws no header — the browser tab's title,
 * and the body classes several stylesheets key off. The mode landing is the one such page.
 */
export function usePageChrome({
  bodyClass,
  documentTitle,
  isNameEditable = false,
}: {
  bodyClass: string
  documentTitle: string
  isNameEditable?: boolean
}) {
  useEffect(() => {
    document.title = documentTitle
  }, [documentTitle])

  useEffect(() => {
    const all = [
      "mode-view",
      "queue-view",
      "play-view",
      "channel-mode",
      "movies-channel",
      "name-editable",
    ]

    for (const className of all)
      document.body.classList.remove(className)

    for (const className of bodyClass
      .split(" ")
      .filter(Boolean))
      document.body.classList.add(className)

    if (isNameEditable)
      document.body.classList.add("name-editable")
  }, [bodyClass, isNameEditable])
}

export function Page({
  back,
  bodyClass,
  children,
  documentTitle,
  editableSetId,
  heading,
  isSubHidden,
  navigationHref,
  sub,
}: Props) {
  usePageChrome({
    bodyClass,
    documentTitle,
    isNameEditable: Boolean(editableSetId),
  })

  const { pathname } = useLocation()
  const navLayout = useNavLayout({
    storageKey: "queuepilot-primary-navigation",
  })
  const [isNavVisible, setIsNavVisible] = useState(false)
  const activeHref = navigationHref ?? pathname

  // A route change closes the navigation menu.
  useEffectOnChange(pathname, () => setIsNavVisible(false))

  const menuNavigation =
    navLayout.layout === "menu" ? (
      <Nav
        activeHref={activeHref}
        isVisible={isNavVisible}
        items={PRIMARY_NAVIGATION_ITEMS}
        label="QueuePilot sections"
        layout="menu"
        onDismiss={() => setIsNavVisible(false)}
        trigger={
          <IconButton
            appearance="outline"
            label="Open navigation"
            onClick={() =>
              setIsNavVisible((isVisible) => !isVisible)
            }
          >
            <MenuIcon />
          </IconButton>
        }
      />
    ) : null

  return (
    <Shell contentWidth="full">
      <Header
        back={back}
        editableSetId={editableSetId}
        heading={heading}
        isSubHidden={isSubHidden}
        navigation={menuNavigation}
        sub={sub}
      ></Header>

      {navLayout.layout === "menu" ? null : (
        <Rail
          label="QueuePilot sections"
          landmark="navigation"
          style={{
            width: navLayout.isCollapsed
              ? "5rem"
              : undefined,
          }}
        >
          <Nav
            activeHref={activeHref}
            items={PRIMARY_NAVIGATION_ITEMS}
            label="QueuePilot sections"
            layout={navLayout.layout}
          />
          <div className="mt-auto hidden justify-end md:flex">
            <IconButton
              appearance="ghost"
              label={
                navLayout.isCollapsed
                  ? "Expand navigation"
                  : "Collapse navigation"
              }
              onClick={navLayout.toggle}
            >
              <CollapseIcon
                isCollapsed={navLayout.isCollapsed}
              />
            </IconButton>
          </div>
        </Rail>
      )}

      <Main contentWidth="full">
        {/* Directly under the header, and only while something is on screen. */}
        <NowPlayingBar />
        {children}
      </Main>
    </Shell>
  )
}
