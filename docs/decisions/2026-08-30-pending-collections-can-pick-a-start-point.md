# Pending collections can pick a start point before the add

- **Status:** Accepted
- **Date:** 2026-08-30
- **Type:** UI / behaviour
- **Supersedes:** The show-only scope in [Pending picks the start episode before the add, and the add writes it](2026-08-22-pending-picks-the-start-episode-before-the-add.md)
- **Superseded by:** —

## Decision

A pending **collection** carries the same start-point control as a pending show. In the poster
view it is the clock control. In the list view it is the named **Start at…** button.

The existing start picker handles the collection shape: it first chooses the member, then chooses
the season and episode when that member is a show. A movie member has no second picker. The choice
stays local to Pending until the collection is added, then the add writes the entry and its start
point in the existing two calls.

Films keep no separate start control because a film is already its own playback item.

## Context

The pending screen added collections after it added the show start control. The collection card
therefore exposed only Add and Dismiss even though the shared start picker and the collection
playback engine already supported a collection start floor.

The owner reported: *"I have no way to choose what does or does not play when adding collections
like I can with shows. I'd like to add that functionality."* The missing control was visible on
the collection cards in the attached Pending screenshot.

## Why

The collection start floor is the same decision as the show start floor: members before the
chosen member do not play, and a show member can begin at a chosen episode. Reusing the existing
picker keeps the watched marks, member order, and write path consistent with collection entries
that are already in a queue.

## Evidence

- Owner request and screenshot, 2026-08-30.
- `StartModal` already lists collection members and handles movie and show members.
- `server/src/plex.ts` already applies `{series, season, episode}` as a collection start floor.
- Screenshots: [`2026-08-30-pending-collection-start-before.png`](../images/2026-08-30-pending-collection-start-before.png)
  against [`2026-08-30-pending-collection-start-after.png`](../images/2026-08-30-pending-collection-start-after.png),
  both from the stub-Plex fixture in `e2e/shot-pending-views.ts`.
