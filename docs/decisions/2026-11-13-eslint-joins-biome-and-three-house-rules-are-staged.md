# ESLint joins Biome, and three house rules are staged at `warn`

- **Status:** Accepted
- **Date:** 2026-11-13
- **Type:** Tooling / CI
- **Supersedes:** The "no second linter" note in `AGENTS.md`, which said Biome over `web/` was
  the whole lint setup.
- **Superseded by:** —

## Decision

Lint runs from the workspace root over `web/`, `server/` and `shared/`, with both linters the
fleet uses, each adopted whole from Charcuterie:

- `biome.json` (moved from `web/`) extends both `@charcuterie/biome-config` and
  `@charcuterie/biome-config/app`.
- `eslint.config.mjs` is `createAppConfig({ tsconfigRootDir, appDirectories: ["web"] })` from
  `@charcuterie/eslint-config`.

`pnpm run lint` runs `biome check` and then `eslint .` in check mode, and CI runs the same
script. `pnpm run lint:fix` writes.

Three house rules are staged at `warn`, with their counts in `eslint.config.mjs`:
`id-length` (1,752), `@typescript-eslint/naming-convention` (381) and `react/no-multi-comp`
(65). The root script passes `--max-warnings 2198`, so a new finding fails the run. The number
goes down as the sweep removes findings; it never goes up. Each rule returns to the preset's
`error` when its count reaches zero.

`e2e/` is not linted yet.

## Context

Biome ran over `web/` only. `server/` had no lint script, and ESLint did not run anywhere, so
the house rules that only ESLint can express (identifier length, the `is`/`has` boolean names,
one component per file, `test()` rather than `it()`) were enforced nowhere. The fleet rule is
that an owned app adopts its lint config from Charcuterie rather than composing its own.

The first run over `server/` found the code had never been formatted in the house style, plus
34 Biome errors and about 3,000 ESLint findings.

## Why

The mechanical findings were fixed in the same change: the house format, sorted imports,
Biome's safe fixes, and 831 `it()` calls that became `test()`. The 34 Biome errors were fixed
by hand, one at a time.

The three staged rules are different. Each finding is a rename, and many of the
`naming-convention` findings are wire and YAML fields, such as `ok`, `done`, `enabled` and
`keep_completed`. Renaming one of those breaks `queues.yaml`, the API, or the TV client. More
than 2,000 renames in one change could not be reviewed safely, and an automated rename can
silently rebind a name that shadows another. Turning the rules `off` would hide the count.
`warn` keeps it visible, and `--max-warnings` stops it from growing. mail-sifter staged the
same three rules the same way when it adopted the preset.

`e2e/` is about 41,000 lines of harness in its own style, and the browser gates depend on it.
Adopting it is a separate change.

## Evidence

- `eslint .` on the adoption branch, before any fix: 1,751 `id-length`, 381
  `naming-convention`, 65 `react/no-multi-comp`, 831 `vitest/consistent-test-it`, and one
  parse error for `shared/queueTitle.ts`, which no tsconfig includes. Once the parse error was
  fixed, that file added one more `id-length` finding, for 1,752.
- `biome check` before any fix: 134 import-order errors, 19 `noImplicitAnyLet`, 7
  `useIterableCallbackReturn`, 6 `noAssignInExpressions`, and 2 `noUnsafeOptionalChaining`,
  plus formatting in every `server/` file.
- After the fixes: typecheck (web, server, e2e), 397 web and 659 server unit tests, and both
  builds pass; `pnpm run lint` exits 0 with 2,198 warnings.
