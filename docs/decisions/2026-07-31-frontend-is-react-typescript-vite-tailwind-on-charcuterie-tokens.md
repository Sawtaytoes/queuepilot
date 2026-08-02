# The web frontend is React 19 + TypeScript + Vite + Tailwind v4 on `@charcuterie/tokens`

- **Status:** Accepted (implemented — charcuterie M6d phase 1)
- **Date:** 2026-07-31
- **Type:** Architecture / build
- **Supersedes:** the "Vanilla JS, no framework/bundler" implementation choice of
  [`2026-07-20-queue-web-ui-is-nodejs-not-flask`](2026-07-20-queue-web-ui-is-nodejs-not-flask.md)
  (that decision's actual subject — the API server is Node, not Flask — is unchanged)
- **Superseded by:** —

## Decision

`web/` is a **React 19 + TypeScript + Vite 8 + Tailwind v4** project built to
`web/dist`, which `server/src/server.js` serves as its static root. It adopts
**`@charcuterie/tokens@0.2.0`** as the colour / type / motion source, matching
rip-deck, castkit, mux-magic and gallery-downloader.

Four consequences worth stating outright:

1. **There is a build step now.** `npm --prefix web run build` must run before the
   server serves anything. The Dockerfile does it in a builder stage, `e2e/run.sh`
   and CI do it inline. Editing `web/` and restarting the server is no longer enough.
2. **Routing is still `location.hash`**, so the Express server still needs no SPA
   fallback: every URL the browser requests is `/`.
3. **The DOM contract is preserved.** Every id and class the seventeen e2e suites
   select on still exists, the four view containers still toggle the `hidden`
   attribute, and the body classes still drive `display` on their children. This was
   a hard constraint, not a nicety — those suites are the only real coverage this UI
   has.
4. **Plex amber is applied as the ACCENT INTENT**, not as a parallel `--accent`
   variable beside the token system. See below.

## Why

The forcing function is charcuterie's M6a survey, which put this app in the
"cannot consume `@charcuterie/ui`" column:

> | plex-channels | `web/index.html` + `app.js` + `style.css`, no build | no |

A React component library reaches React consumers and nothing else. There was no
seam for one to enter through, so the choice was to build the seam or to leave this
app permanently outside the fleet's shared UI. Bob's call was to modernize it.

Beyond that:

- **The palette was six hexes nothing could revisit.** `--bg`, `--panel`,
  `--panel-2`, `--line`, `--ink`, `--muted` were a hand-rolled dark theme with no
  light mode and no way to get one. The app now has a light mode behind one
  attribute, verified in a browser.
- **2,921 lines in one file.** `app.js` had grown to hold routing, four views, three
  modals, three drag gestures, FLIP, SSE and the search plumbing, with the
  correctness rules living in comments beside module-level globals.

This is **not** a line-count win — the port is ~4,600 lines of TSX where there were
3,616 of JS + CSS, and saying otherwise would be dishonest (M5 made the same note).
What it buys is a consumer that can take components at all, a typed wire contract,
and the light mode.

## Plex amber is the accent intent

`daylight`'s accent is indigo (`#5A54E8`). This app's entire affordance language —
the play button, the drag ring, the focus outline, the next-up episode line, the
"New queue" pill — is Plex's amber `#E5A00D`, and it reads as Plex on purpose.
Repainting it indigo would be a redesign, which this migration explicitly is not.

So rather than keeping a second, parallel `--accent` variable beside the token
system (which is exactly what the old stylesheet was), the **whole seven-role accent
intent family is overridden**, in both schemes, in `web/src/styles/app.css`. A
partial override silently mixes brands the moment a component reaches for a role
nobody rewrote.

The payoff is in phase 2: `@charcuterie/ui`'s accent Buttons and Badges come out
amber without a single prop.

Contrast, measured against the surface each role sits on:

| | | |
| --- | --- | --- |
| dark | `content #E5A00D` on `base #131822` | 7.6:1 |
| dark | `on-solid #111111` on `solid #E5A00D` | 10.4:1 |
| light | `content #7A5300` on `base #F5F7FA` | 6.5:1 |
| light | `on-solid #111111` on `solid #E5A00D` | 10.4:1 |

Light mode needs the darker `#7A5300` for text: bright amber on a near-white canvas
is about 2:1 and fails outright.

## The one intentional visual change

The type ramp. `@charcuterie/tokens/fonts.css` ships Outfit as `--font-sans`, and the
app now uses it instead of `system-ui`. That is the house pattern (rip-deck,
gallery-downloader) and adopting the token system's typography is the point of
adopting the token system. Everything else — layout, copy, spacing, behaviour — is
unchanged.

## Package manager

**npm**, not the Yarn 4 workspaces the sibling repos use. This repo is not a
monorepo: `server/` and `web/` are two independent npm projects beside a Python
package, and CI already did `npm ci --prefix server`. Converting to Yarn workspaces
would be a second, unrelated change.

## Evidence

- charcuterie `docs/2026-07-31-m6a-the-p1-components.md` — the survey and Bob's
  call to modernize.
- The sibling migration this one follows: `gallery-downloader`
  `docs/2026-07-31-m6e-react-tailwind-frontend.md`.
- Gates after the port: **125 e2e assertions across 8 suites, `suites failed: 0`**;
  28 web unit tests; typecheck clean; `vite build` green.
- Light mode verified in a live browser: `<html>` and `<body>` both compute
  `rgb(245, 247, 250)` under `data-scheme="light"`. Screenshot:
  [`docs/images/2026-07-31-m6d-light-scheme.png`](../images/2026-07-31-m6d-light-scheme.png).

## See also

- [`../2026-07-31-m6d-react-tailwind-frontend.md`](../2026-07-31-m6d-react-tailwind-frontend.md)
  — the handoff, including phase 2's work order.
