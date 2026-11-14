# Every lint rule is at the preset's level, and a boundary name keeps its name with a reason

- **Status:** Accepted
- **Date:** 2026-11-14
- **Type:** Tooling / CI
- **Supersedes:** The staging of three house rules at `warn` in
  [ESLint joins Biome, and three house rules are staged at `warn`](2026-11-13-eslint-joins-biome-and-three-house-rules-are-staged.md),
  and that record's note that `e2e/` is not linted.
- **Superseded by:** In part, [Lint warnings fail CI](2026-11-14-lint-warnings-fail-ci.md),
  for `--max-warnings`: `lint` now passes `--max-warnings 0` and Biome `--error-on-warnings`.

## Decision

`pnpm run lint` runs `biome check` and then `eslint .` over `web/`, `server/`, `shared/` and
`e2e/`. Every ESLint rule is at the level that `createAppConfig` from
`@charcuterie/eslint-config` sets, and the script passes no `--max-warnings`. Every preset rule
the repo uses is an error, so a finding fails the run. `eslint.config.mjs` also makes an
unused `eslint-disable` comment an error (the preset reports one as a warning), so a
suppression that no longer covers a finding fails the run instead of staying behind.

A name that is fixed by something outside TypeScript keeps that name. That covers a field of
the app's HTTP JSON, a YAML config key that users already have, a SQLite field, an MQTT
payload field, a Plex or Kavita API field, and a field that an untyped e2e stub (`.mjs`) or a
`page.evaluate` string reads. Such a name gets an `eslint-disable-next-line` for the one rule
it breaks, with a reason after `--`. A rule is never turned off for a file or a folder to make
room for one.

Biome does not sort imports in `e2e/` (an override in `biome.json`). In a harness, the import
order is the order the modules run, and some stubs change globals when they load. For
example, `stubs/fixed-clock.mjs` replaces `Date`.

## Context

The owner, on 2026-11-14: *"We should fix all those lint warnings. I dunno why we have them in
the first place."* The 2026-11-13 adoption had left 2,198 findings at `warn` under a cap, and
`e2e/` was not linted.

## Why

The sweep ran in four pull requests, each reviewed on its own:

1. #380: 1,308 renames in `server/` and `shared/`. Six environment-flag names keep the name of
   the variable they read.
2. #381: `e2e/` joins both linters. It has 1,498 renames, five test-local property renames,
   and 43 suppressions.
3. #383: 572 renames in `web/`, and each component moves to its own file. `id-length` and
   `react/no-multi-comp` return to `error`.
4. This change: the last 244 boolean type properties. 53 are internal and are renamed. 191
   keep their names, each with a reason.

Every local rename went through the TypeScript language service. A check then confirmed that
each identifier still binds to the same declaration as before. A property rename is made only
when TypeScript links every reader and writer. If any reader is outside its reach, the name
keeps its suppression, because a wrong rename breaks a user's file or the TV client, while a
wrong suppression only leaves a lint exception. For the same reason, nine internal fields keep
their names: test mocks build their results without types, so the compiler could not show
that a rename had reached every mock.

A cap would let the count grow back slowly, and `warn` hides new findings in old ones. Error
with no cap makes each new exception a visible line with a reason.

## Evidence

- `eslint .` after this change: 0 errors and 0 warnings. 191 findings keep their names under
  182 comments for `@typescript-eslint/naming-convention` (180 next-line comments and two
  narrow disable blocks), all listed in this change's pull request. The six from #380 and the
  43 from #381 are listed in those pull requests.
- The reasons, by count: 110 HTTP JSON fields; 15 YAML keys or copies of them; 16 MQTT
  payload fields or mqtt.js options, or values copied into one; 10 Plex and 4 Kavita API
  fields; 5 SQLite fields; 6 `queueOwnHistory` copies of a stored field; 4 that e2e stubs
  write; 9 that test mocks build without types; and the rest, one to three each, are named in
  their comments.
