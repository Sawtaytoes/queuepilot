# 2026-08-15 — Anything that navigates is an `<a href>`, not a `<button onClick={navigate(…)}>`

Status: Accepted
Date: 2026-08-15
Type: frontend (navigation / a11y)
Supersedes: —
Superseded by: —

## Decision

Every control whose job is "go to another page in this app" renders as an anchor with a real
`href`. That is: the Play landing's channel/queue names, its three "Configure ›" controls,
the Queues shelf titles, and the header's back control (inline and in the mobile nav menu).

Routing is `location.hash`, so a plain click needs **no handler at all** — setting the hash
is exactly what `navigate()` did, and the existing `hashchange` listener does the rest.
Where a click had a side effect (the Queues shelf stamps `homeScroll.y` so returning
restores the scroll position), the handler stays but is deliberately **not**
`preventDefault`ed: it records, and the browser navigates.

## Context

The owner:

> "I also can't middle-click or CTRL click these items to open in new tabs. I'd like that
> functionality."
> "I thought we added a Link component, so that should work here."

He is right on both counts, and the second is the more interesting one. `@charcuterie/ui`
ships `ButtonLink`, `TextLink`, `AnchorLink` and `RouterLinkProvider` — and `ButtonLink`'s
own docstring names *this application and this exact control*:

> "This is Plex Channels' 'Configure ›': it reads as the primary action on the card, and it
> goes to another page — so it must be an `<a href>` (middle-click, ctrl-click, "open in new
> tab", "copy link address", and the status bar all come from the element, not from the
> paint) while looking exactly like `Button`. **Today that control is a
> `<button onClick={() => navigate(…)}>`, which has none of them.**"

So the component was built in the shared library *for this app's problem*, and this app never
adopted it. `grep -rn "Link" web/src/` returned nothing at all.

## Why plain `<a>` here, and not `ButtonLink`/`TextLink`

`ButtonLink` is `Button`'s skin plus link semantics, and `TextLink` is link-coloured
underlined text. None of the four controls here is either: `.rowname` is an app-styled bold
title, `.ghost` is an app-styled quiet button, `.shelf h2 .open` is a heading. Adopting a
Charcuterie control also means deleting its skin
([2026-08-02](2026-08-02-adopting-a-component-means-deleting-its-skin.md)), which would have
made a "let me middle-click this" request into a visual redesign of the landing page.

So: keep every class exactly as it was, change the *element*. The skin is untouched and the
semantics are correct. Adopting `ButtonLink` properly is real follow-up work — it belongs
with a pass that moves these controls onto Charcuterie's control styles, not with this fix.

## What it cost

Two things an `<a>` does that a `<button>` does not, both handled in `app.css`:

1. **Underline + link colour.** Reset via `text-decoration: none` (the existing rules already
   set `color` explicitly).
2. **`cursor`.** The base `button { cursor: pointer }` rule does not reach an anchor.

And one real trap: `.ghost` was written as **`button.ghost`**, a tag-qualified selector. An
`<a class="ghost">` matched nothing and fell back to bare link text. Widened to
`button.ghost, a.ghost`. Anywhere else in this stylesheet that qualifies a class with
`button` is the same landmine for the next control that becomes a link.

Anchors are also natively draggable, which matters on the Queues shelf where posters and
whole shelves reorder by pointer drag. `e2e/homedrag-test` passes unchanged — the drag
surfaces are `.thumb` and `.shelfdrag`, not the title — but it is the gate to re-run if a
future link lands inside a draggable region.

`#back` renders `hidden` on the Play landing rather than unmounting, so it keeps an
`href="#/"` fallback: an anchor with no `href` is not focusable and would silently drop out
of the tab order.

## Evidence

Verified in a real browser rather than by reading the markup — ⌘/Ctrl-click and middle-click
each open a genuine second tab, and a plain click still navigates in place:

```
#gochannels: <a> href=#/channels
.playrow .rowname: <a> href=#/channels/younger
ctrl+click  : 1 tab -> 2 tabs   http://localhost:18952/#/channels/younger   (opener stayed put)
middle-click: 1 tab -> 2 tabs   http://localhost:18952/#/channels/younger
plain click navigates in place: http://localhost:18952/#/channels/younger
#back: A href=#/  — ctrl+click 1 -> 2 tabs
```
