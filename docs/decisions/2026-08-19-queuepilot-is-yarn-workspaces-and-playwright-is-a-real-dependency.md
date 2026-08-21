# queuepilot is yarn workspaces, and Playwright is a real dependency

**Status:** Accepted
**Date:** 2026-08-19
**Type:** Toolchain / build
**Implements:** the root repo's
[2026-06-18 — use yarn, never npm/npx](../../../agentic/docs/decisions/2026-06-18-use-yarn-base-on-mux-magic.md),
which queuepilot had never complied with
**Superseded by:** —

## Decision

queuepilot is **one yarn Berry (4.14.1) workspace root** over `web`, `server`, `e2e` and
`e2e/broker`. The four `package-lock.json` files are gone; there is one `yarn.lock`.

**Playwright is a pinned devDependency of the `e2e` workspace**, not a package CI fetches at
runtime. The CLI and the module are therefore the same copy at the same version — which is
the property `e2e/playwright.ts` has always depended on and never had.

Three rules that fell out of building it, each caught by something failing:

- **`nmHoistingLimits: workspaces`.** Full hoisting put web's `@types/react@19` where the
  SERVER's tsc could see it, and satori's `ReactNode` parameter stopped typechecking against a
  React the server neither uses nor declares. These are three different runtimes that share a
  repo; under npm they had three isolated installs, and this restores that.
- **The committed yarn release, run through node — never `corepack enable`.** Node dropped
  corepack from the distribution in 25, and both CI (`setup-node` → 26) and the Dockerfile
  (`node:26-trixie-slim`) are past that. `corepack: not found` is what the Docker build said.
  Running `.yarn/releases/yarn-4.14.1.cjs` directly also means neither CI nor the image fetches
  a package manager over the network in order to install packages.
- **`.dockerignore` re-includes the workspace manifests it otherwise excludes.** yarn resolves
  the lockfile against every workspace named in `workspaces`, so an absent `e2e/package.json`
  fails `--immutable` before anything installs. Docker honours a re-include for a file inside
  an excluded directory (git does not), and last match wins.

## Context

CI ran `npm install playwright` **twice per job**, unpinned, followed by
`npx playwright install chromium --with-deps`. On 2026-08-19 GitHub's Ubuntu mirror stopped
answering and the apt half of that command hung; with no bound anywhere, one run sat for
**six hours** before the workflow cap killed it, and three more queued behind it. One was CI
on `main`, which had to be cancelled by hand — and `docker-deploy.yml` gates on
`workflow_run.conclusion == 'success'`, so a cancelled CI does not fail the deploy, it
**skips** it.

The immediate stall was already mitigated on `main` by
[#144](https://github.com/Sawtaytoes/queuepilot/pull/144) — splitting the apt half off,
making it best-effort, and bounding both halves with `timeout`. What that could not fix is the
shape underneath it: a package manager the fleet does not use, fetching an unpinned browser
driver from the network on every run of every PR.

## Why

- **The rule already existed and this repo was the exception.** Every other Node repo in the
  fleet — mux-magic, castkit, board-game-picker, docket — is yarn 4.14.1 with a committed
  release. queuepilot carried four npm lockfiles.
- **"No root manifest" was load-bearing in half a dozen comments**, every one of them a
  workaround for its absence: e2e had nowhere to declare a dependency, `tsc` was addressed
  through `server/node_modules/.bin`, and `e2e/playwright.ts` borrowed a sibling repo's
  Playwright off the NAS by absolute path — a lookup that could not work in CI and says so in
  its own header.
- **A pinned Playwright is what makes the browser cache legitimate.** An unpinned install
  cannot be cached by version, and a browser set installed by a different Playwright is
  pinned to a different build number, so the resolver would find the package and reject its
  browsers.
- **One `yarn install --immutable` replaces three `npm ci`s** and turns "a manifest changed
  and the lockfile did not" into a CI failure instead of a silent re-resolve.

## Consequences

- Root `package.json` is new and declares **no `type`**, deliberately: `web`, `server` and
  `e2e` each declare their own, and a root `type` would change the module format of any file
  they do not cover.
- The Dockerfile's three `npm ci` calls become `yarn workspaces focus <workspace>`, which
  installs one workspace's tree — the server-build stage has no use for React, Vite or
  Playwright. Build stages now work from `/repo` rather than `/web` and `/app/server`.
- `e2e/broker` stops being a hand-hydrated island (`cd e2e/broker && npm install`) and becomes
  a workspace the root install covers.
- CI installs the browser **once**, cached on `~/.cache/ms-playwright` keyed by the resolved
  Playwright version, instead of twice per job uncached.
- `e2e/playwright.ts` gains `e2e/node_modules/` as its first lookup root. The sibling-borrowing
  fallback stays for a checkout whose install has not been run.

## Evidence

- Owner, 2026-08-19, on finding `package-lock.json` in the tree: *"???????? It should all be
  yarn. Please fix."* and *"yarn dlx, migrate to yarn, make sure it's a real dependency."*
- Verified on this branch: `yarn install --immutable` clean; all three workspaces typecheck;
  117 unit tests pass; web and server both build; `play-reorder-test` 14/14,
  `narrow-scroll-test` + `routing-test` 76 assertions, 0 failures.
- **The image was built and inspected**, not assumed: `docker build` on the host succeeds, and
  the result matches the shipping image — `server/dist/index.js` present, 11 web assets,
  `web/dist/index.html` present, zero dev dependencies (`vite`/`typescript`/`tsx`/`esbuild`)
  in the runtime tree, and zero stray lockfiles where the shipping image still has one.
