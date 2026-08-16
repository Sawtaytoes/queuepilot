# Routing is real paths, not `#/…`

**Status:** Accepted
**Date:** 2026-08-16
**Type:** Architecture / frontend
**Supersedes:** the hash-routing half of
[2026-07-31 — the web frontend is React + TypeScript + Vite + Tailwind](2026-07-31-frontend-is-react-typescript-vite-tailwind-on-charcuterie-tokens.md)
(that record's "keeps the hash routing" is no longer true; everything else in it stands)
**Superseded by:** —

## Decision

The four routes are **paths**, served by react-router:

| Was | Is |
| --- | --- |
| `#/` | `/` |
| `#/queues` | `/queues` |
| `#/q/<id>` | `/q/<id>` |
| `#/channels[/<id>]` | `/channels[/<id>]` |

The IA itself is unchanged — Play is still the landing and the two configurators still
hang off it
([2026-07-21](2026-07-21-queues-vs-channels-taxonomy-play-first-ia.md)). Only the URL
shape moved.

**`hasSpaFallback: true` in `server/src/buildServer.ts` is part of this decision, not an
adjacent tidy-up.** The browser now genuinely requests `/queues`; without the fallback
the first reload, bookmark or pasted deep link 404s. The two halves live in different
packages and neither package's own gates can see the other, so
**`e2e/routing-test.ts` pins them together** and runs on every PR (no Plex token needed).
Flipping either half back fails that suite and nothing else.

Navigation stays an anchor
([2026-08-15](2026-08-15-navigation-is-an-anchor-not-a-button.md) is **reaffirmed, not
superseded**) — the landing rows, the three "Configure ›" controls, the shelf titles and
the header back control are react-router `<Link>`s, which render a real `<a href>`. What
changed is that a plain left-click now needs interception: under the hash router setting
the hash *was* the navigation, so a bare `<a href="#/q/1">` needed no handler at all. A
bare `<a href="/q/1">` is not the same thing — it would leave the page and refetch the
whole app. `<Link>` keeps middle-click, ⌘/Ctrl-click, "open in new tab" and "copy link
address" working, and intercepts only the plain click.

## Context

The owner asked whether React Router with path routing had been wired up everywhere,
"because all our sites are hosted now, not just client-side." QueuePilot was the app
still on `#/` — a hand-rolled `location.hash` store in `web/src/state/route.ts` (a
`hashchange` listener, a module-level `currentHash`, a listener `Set` and a
`useSyncExternalStore` shim), inherited unchanged from the vanilla app that predates the
React frontend.

This implements the fleet-wide decision
`2026-08-16-owned-web-apps-use-react-router-with-path-urls` in the `agentic` root repo.

## Why

- **The premise it was built on expired.** Hash routing was the right call for a static
  client-side bundle, and the `hasSpaFallback: false` comment said as much in so many
  words. QueuePilot is a hosted app behind NPM now.
- **`#/q/42` is a worse link than `/q/42`** — it never reaches the server, so there are
  no per-route access logs and no per-route caching, and some chat clients mangle the
  fragment when the link is pasted.
- **Consistency has a payoff here specifically:** mail-sifter and mux-magic were already
  on react-router v8, so this is the third app on the same idiom rather than a third
  bespoke router.

## Consequences

- `web/src/state/parseHash.ts` → `parsePath.ts`; `parseHash`/`labelForHash` →
  `parsePath`/`labelForPath`. `route.ts` shrinks to what react-router does *not* provide:
  the back **origin**.
- **The origin's safety changed shape.** It used to be structurally unclobberable (only
  the `hashchange` listener wrote it). It is now written during render by
  `trackRouteOrigin`, guarded by a `pathname !== currentPath` check that makes it
  idempotent under a StrictMode double-render and under any re-render at the same path.
  Call it exactly once, at the top of `App`, before the chrome is computed.
- `parsePath` **strips a trailing slash**, which `parseHash` never had to: `/queues/` is
  reachable now (a proxy rewrite, a typed URL) and would otherwise fall through to the
  PLAY fallback and silently not open the configurator.
- Every e2e suite that navigated by `page.goto('…/#/queues')` now goes to `…/queues`, and
  `ui-test`'s three in-page `location.hash = …` assignments became real `page.goto`s —
  assigning a hash is no longer a navigation.

## Evidence

> "I thought we wired up React Router everywhere with path routing, not just
> `#/something` because all our sites are hosted now, not just client-side yes?"
> (owner, 2026-08-16)

Verified against a local server on the fixture data, 2026-08-16 — `e2e/routing-test.ts`,
18/18 PASS on this branch, and the same suite run against `main` fails on 8 of them
(`GET /queues` → 404, `GET /q/bob` → 404, every deep link, the reload, and
`#goqueues` still `href="#/queues"`).
