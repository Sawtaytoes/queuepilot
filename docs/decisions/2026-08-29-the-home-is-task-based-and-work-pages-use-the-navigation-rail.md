# The home is task-based, and work pages use the navigation rail

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** Product / routing / UI
- **Supersedes:** [QueuePilot starts with a mode landing, and the picker is What to Watch/Play](2026-08-26-queuepilot-starts-with-a-mode-landing.md) (the two-mode landing and `/admin` as the management hub)
- **Superseded by:** —

## Decision

`/` is the small task-based home. It shows two primary actions:

1. **What to Watch/Play** opens `/what-to-watch-play`.
2. **Open a queue** opens `/picks`.

The home then shows five management destinations: **Picks**, **Rules**, **Collection**,
**Unqueued**, and **People**. It does not render queue cards, filters, playback controls, or
configuration details.

Every work page uses the same primary navigation. The Wide View renders it as the Charcuterie
`Rail` + `Nav`; the intermediate width uses the icon-only rail; and the Narrow View puts that
same destination list behind one menu control through `useNavLayout`. A destination is mounted
once at any width.

`/people` is the management destination for the roster and the saved audience groups. `/admin`
is a legacy address: it paints the new home and replaces its address with `/` so old bookmarks
keep working without preserving the cluttered management hub.

The former card wall remains temporarily at the unlinked `/overview` compatibility address.
Existing interaction gates still drive it while its card-only actions move to the focused
pages. It is not on the home or the primary navigation, and `/admin` does not resolve to it.

## Context

The management landing exposed every queue, person filter, provider filter, play control, and
configuration entry at once. The owner described it as cluttered and difficult to navigate, and
asked for local test data plus HTML alternatives. The served alternatives separated the two
questions:

- Option A showed a persistent work-page navigation rail with a focused one-column content list.
- Option C showed a task-based home with two primary actions and a small management section.

The owner selected both:

> "A and C"

## Why

The home answers where to start. It does not also try to perform every management job.

The rail answers where the work surfaces live after the reader starts one. The same order and
labels remain available at every width, while Charcuterie owns the width rules and accessibility
behavior.

The combination removes the old Admin layer. A person can go directly from the home or the rail
to the required surface. A dedicated People address also makes roster and audience-group
management discoverable without putting their editors on every queue card.

## Evidence

- Direct owner selection, 2026-08-29. Chat id: unavailable in this repository session.
- Served HTML comparison: `__screenshots__/queuepilot-navigation-options.html` (local review
  artifact; ignored by git).
