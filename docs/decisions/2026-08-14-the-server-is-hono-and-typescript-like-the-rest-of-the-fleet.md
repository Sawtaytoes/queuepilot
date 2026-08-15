# The server is Hono + TypeScript, like the rest of the fleet

- **Status:** Accepted
- **Date:** 2026-08-14
- **Type:** Architecture
- **Supersedes:** —
- **Superseded by:** —

## Decision

`server/` is **Hono + strict TypeScript**, serving its static assets through
**`@charcuterie/server`**, developed under `tsx` and shipped as an **esbuild bundle run by
plain `node`**. Express, the `compression` middleware, the hand-rolled `staticCompressed`
sibling-negotiator and `web/scripts/precompress.mjs` are all deleted.

This extends
[2026-07-31 — the frontend is React/TypeScript/Vite/Tailwind on Charcuterie tokens](2026-07-31-frontend-is-react-typescript-vite-tailwind-on-charcuterie-tokens.md)
to the other half of the app. That decision was scoped to `web/` and said nothing about
the server, which is why the server was still plain JS a year later.

Explicitly **out of scope**: converting this repo to a Yarn 4 workspace monorepo. The
other fleet apps are workspaces; queuepilot is npm with independent `server/` and `web/`
packages and no root manifest. The `@charcuterie/*` packages are public on npm and `web/`
already consumes them that way, so the architecture lands without a package-manager
migration. Doing both at once would double a diff that is already large.

## Context

GitHub reported the repo as 63.1% JavaScript. That was accurate, and it was not the
frontend: `web/` had already adopted `@charcuterie/tsconfig`, `vite-config`,
`vitest-config` and `biome-config`. The JavaScript was **the entire Node server** — 35
files, ~10,190 lines under `server/src` — plus 68 `.mjs` e2e harnesses.

Seven sibling apps had already converged on Hono + `@charcuterie/server`: mux-magic,
gallery-downloader, points-market, mail-sifter, board-games, castkit and ai-usage.
queuepilot was the only SPA-serving app in the fleet still on Express, and the only one
still hand-rolling its own static handler.

The server's CI gate was:

```yaml
for f in $(find server/src -name '*.js'); do node --check "$f"; done
```

A parser run. No type checking, no lint. Meanwhile `web/` was gated on `typecheck` +
`vitest` + `build`. The untyped half was the half holding the rotation engine — the code
that decides what actually plays on the TVs — and
[2026-08-03 — retiring Python except the cast sidecar](2026-08-03-retiring-python-except-the-cast-sidecar.md)
had recently moved *more* logic into it.

## Why

**The caching bug is the concrete cost.** `@charcuterie/server` exists because an August
2026 audit found six fleet apps serving Vite SPAs with no compression at all, the worst
case shipping a 1.02 MB bundle under `Cache-Control: no-cache, no-store, must-revalidate`
on a *content-hashed* filename. queuepilot had its own partial answer — `staticCompressed`
handled `/assets/` for `.css`/`.js`/`.svg` only — which is a private reimplementation of
the package written to delete exactly that. Adopting it widens compression to all of
`dist/` (so `index.html` gets `.br`/`.gz` siblings it never had) and puts the ETag/304
revalidation behind one tested implementation instead of two divergent ones.

**One architecture is cheaper than seven.** The point of the fleet convention is that
anyone — human or agent — opening any app's `server/` finds the same `index.ts` bootstrap,
the same `buildServer.ts` factory returning a testable Hono root, the same
`root.route("/api", …)` then `createStaticHandler` ordering. queuepilot's Express layout
was a per-repo dialect that had to be re-learned.

**`node --check` is not a gate.** It cannot see a typo in a property name, a `null` that
should be `undefined`, or a renamed export. The conversion surfaced several latent bugs
that had been sitting in production code invisibly — see below.

## Evidence

The owner, on seeing the GitHub language badge:

> "GitHub notes QueuePilot as being majority JS, not TS. Why? Even if it's running
> server-side code or mjs, shouldn't those be ts files to keep type safety with a `tsx`
> command to run it locally and a compile step when putting it in the Docker container
> like other apps? This should all be defined in Charcuterie in our server tooling."

And on scope:

> "we need QueuePilot to match the server architecture of the other apps, and all the apps
> to have the same style architecture."

## Latent bugs made visible, deliberately not fixed

The conversion is a translation, not a refactor — `e2e/fixtures/golden/` holds recorded
oracles proving this engine matches the retired Python implementation bit for bit, so a
behaviour change fails the parity gates whether it is a bug or an improvement. These were
therefore **encoded in the types with comments**, not repaired:

- **`playback.ts` mirrors an HTTP status onto `err.code` as a number**, colliding with
  Node's string errno `code` that `driver.ts isConnRefused` walks. `errors.ts` keeps
  `plexStatus` and `code` as distinct fields.
- **`session.ts:170` calls `provider.profileToken(...)` unguarded** on every push start,
  though `profileToken` is optional on the `Provider` seam — a latent requirement of the
  push path.
- **Kavita play items carry no `ratingKey`/`season`/`episode`**, yet `session.ts` reads all
  three unconditionally. Unreachable today because the pull path never reaches
  `startSession`.
- **`payload.target` is a string id or a resolved device object** depending on caller;
  `mqttd.ts` swaps it.
- **Env drift:** `SETS_PATH` and `REMOVE_COMPLETED_AFTER` are read straight from
  `process.env` outside `env.ts`, against its "every knob is read here, once" charter, and
  `sets.ts` re-reads `PLEX_SEC_MOVIES` with its own copy of the default that `env.ts`
  already owns as `SEC_MOVIES`.

Each is a follow-up, individually gated.

## Consequences

- CI's server gate becomes `tsc --noEmit`, replacing `node --check`.
- Prod runs `server/dist/index.js` under `node --enable-source-maps`; the runtime image
  carries no `.ts`, no tsx, no typescript, no esbuild.
- `server/migrate-tiers` runs from a checkout rather than inside the container, which no
  longer ships `server/src` for it to import.
- The SSE keepalive helper is now duplicated a third time (mux-magic,
  gallery-downloader, here). It belongs in `@charcuterie/server` — noted as a follow-up.
