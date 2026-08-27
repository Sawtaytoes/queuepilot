import { useEffect } from "react"

import { useMediaQuery } from "../hooks/useMediaQuery"
import { Header } from "./Header"
import { NowPlayingBar } from "./NowPlayingBar"
import { Toolbar } from "./Toolbar"

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

    for (const c of all) document.body.classList.remove(c)

    for (const c of bodyClass.split(" ").filter(Boolean))
      document.body.classList.add(c)

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
  sub,
}: Props) {
  usePageChrome({
    bodyClass,
    documentTitle,
    isNameEditable: Boolean(editableSetId),
  })

  // Wide View: the toolbar lives in the sticky header. Narrow View: at the top of the Home
  // content, because the header is far too tight to carry it — Bob's explicit ask. The one
  // page that wants it in the content (`QueuesPage`) asks the same question and puts a
  // `Toolbar` there, so exactly one is ever mounted.
  //
  // `isNarrow`, not `isMobile`: the trigger is the WIDTH and nothing else. A docked Surface
  // is touch-capable and never narrow; a half-width desktop window is the Narrow View on a
  // machine nobody would call mobile.
  // (root decision `2026-08-17-the-cramped-layout-is-the-narrow-view-not-mobile`)
  const isNarrow = useMediaQuery("(max-width: 760px)")

  return (
    <>
      <Header
        back={back}
        editableSetId={editableSetId}
        heading={heading}
        isSubHidden={isSubHidden}
        sub={sub}
      >
        {isNarrow ? null : <Toolbar />}
      </Header>

      {/* Directly under the header, and only while something is on screen: the owner asked
          for the controls "at the top". It renders null when nothing is playing, so it costs
          no space the rest of the time. */}
      <NowPlayingBar />

      {children}
    </>
  )
}
