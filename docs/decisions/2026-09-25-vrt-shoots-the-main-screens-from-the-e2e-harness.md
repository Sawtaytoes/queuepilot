# VRT shoots the main screens from the e2e harness, not from a Storybook

- **Status:** Accepted
- **Date:** 2026-09-25
- **Type:** CI / testing
- **Supersedes:** —
- **Superseded by:** —

## Decision

QueuePilot runs visual regression on every pull request through the shared
`shared-vrt.yml@workflows-v1` workflow in Charcuterie, as the `vrt` job in `ci.yml`. **The shots
come from `e2e/vrt-capture.ts`, a `captureCommand`, not from a Storybook.** It starts the real
server over the committed fixtures and photographs the main screens:

| Shot | Route | Fixture |
| --- | --- | --- |
| `home` | `/` | landing |
| `overview` | `/overview` | landing |
| `queues` | `/queues` | landing |
| `people` | `/people` | landing |
| `pending` | `/pending` | landing |
| `collection` | `/collection` | landing |
| `queue-family` | `/q/family` | landing |
| `rules-younger` | `/channels/younger` | landing |
| `calendar` | `/calendar` | `calendar.sets.yaml` |
| `what-to-watch-play` | `/what-to-watch-play` | `tonight-harness.ts` |
| `board-games` | `/collection/board-games` | `board-game-play-harness.ts` |
| `result-tidewright` | `/result/tidewright` | `board-game-play-harness.ts` |

Each route is shot in the **Wide View** (1400x1000) and the **Narrow View** (390x844, with
`isMobile`), in **light** and **dark**: 48 PNGs named `<shot>--<wide|narrow>--<light|dark>.png`.
A name is the baseline's key. Renaming one is a deleted shot plus a new one.

## Context

The workspace decided on 2026-09-25 that every owned app on Charcuterie runs VRT, from
Storybook stories or from test screenshots. This repo has no Storybook and never had one. It has
something closer to the real thing: about seventy `e2e/shot-*.ts` scripts and seventeen no-Plex
browser gates that already boot the server over invented fixtures. The landing, Tonight and
board-game fixtures are each the right data for their screens, and the calendar needs its own
fixture because only that one holds every combination of the two date settings.

## Why

- **A Storybook built only for VRT would photograph components, not this app.** The defects
  this repo has actually shipped are page-level — a borrowed class that paints nothing, a bare
  element selector that reached every card, a Narrow View that scrolled sideways. A story of a
  component in isolation shows none of those. A route over the real server shows all of them.
- **One harness, one cast.** The capture reuses `tonight-harness.ts` and
  `board-game-play-harness.ts`, the same boot code the gates assert against, so a shot and an
  assertion cannot drift onto different data.
- **Determinism is built in, because a flaky shot is worse than none.**
  - The server's `Date` starts at a fixed instant and its `Math.random` is seeded
    (`e2e/stubs/fixed-clock.mjs`, loaded through `NODE_OPTIONS`). The season window, the
    seasonal reset and "finished" are all evaluated on a read.
  - The browser's `Date` is pinned, its `Math.random` is seeded, and the time zone and locale
    are fixed.
  - Motion is reduced and CSS animations are finished before the shot.
  - Each shot waits for its view's own marker, then for the store's load, its revalidation and
    its "Ready" toast to finish. It reads the network and not only `#status`, because the task
    home draws no header.
  - A marker that never appears fails the run, so a spinner can never become the baseline.
- **Fixture data only.** The repo is public and a PNG is opaque to every grep. Plex is a closed
  port and every other provider is an `.invalid` host.

Two costs are accepted. A run takes about five minutes, because the no-Plex `/api/queues`
retries for about eleven seconds on every page load; the four view/scheme pairs run in parallel
to keep it there. And a shot is the viewport, not the whole page: the shell scrolls inside
`Main`, so the document never grows and a full-page shot would be the same picture.

## Evidence

The workspace decision `agentic:docs/decisions/2026-09-25-every-owned-charcuterie-app-runs-vrt.md`
(a sibling workspace repo, not on GitHub, so it is named rather than linked). The owner, on
2026-09-25: *"We have Storybook, so that's on avenue for VRT shots, and some tests can also do
them if it makes sense."* Two local runs of `e2e/vrt-capture.ts` over the same commit wrote 48
PNGs each with identical `sha256sum` output.
