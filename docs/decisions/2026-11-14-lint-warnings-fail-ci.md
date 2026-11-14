# Lint warnings fail CI, and a finding is fixed in the code

- **Status:** Accepted
- **Date:** 2026-11-14
- **Type:** Tooling / CI
- **Supersedes:** In part, [Every lint rule is at the preset's level](2026-11-14-every-lint-rule-is-at-the-preset-level.md):
  its statement that `lint` passes no `--max-warnings`. The rest of that record stands.
- **Superseded by:** —

## Decision

1. `pnpm run lint` is `biome check --error-on-warnings && eslint . --max-warnings 0`. CI runs
   that script, so a Biome or ESLint warning fails CI like an error. The flags live in the
   script because neither tool can make a warning fail from a config file, so the Charcuterie
   presets do not change for this.
2. A finding is fixed in the code. A `!` becomes a guard, or `defined()` from
   `server/src/defined.ts`, which returns the value or throws a named error. A hook that would
   run at new times with a full dependency list reads its values through an Effect Event
   (`useEffectEvent`, or `web/src/hooks/useEffectOnChange.ts` for an effect whose trigger is
   not a value it reads).
3. A per-line `biome-ignore` is allowed only for a shape that something outside TypeScript
   fixes, with that contract in its reason, the same rule that the earlier record set for
   `eslint-disable-next-line`.
4. `correctness/useExhaustiveDependencies` returns to the preset's level in `web/`. The other
   rules that `biome.json` lowers keep their lower level, because each still has findings (see
   Evidence). Each one returns to the preset's level in the change that fixes its last finding.

## Context

The owner, on 2026-11-14: *"We should fix all those lint warnings. I dunno why we have them in
the first place."*

The earlier record put every ESLint rule at the preset's level, which made every ESLint finding
an error. It did not cover Biome. Biome's recommended set reports some rules as warnings, and
`biome.json` lowered `useExhaustiveDependencies` to `warn` for `web/`. `biome check` exits 0 on
a warning, so 543 Biome warnings had built up, and a new one could merge.

## Why

A warning that does not fail CI is a defect that the gate accepts, and a new warning hides
among the old ones. The fleet made the same change the same day (for example, tally-marks,
`docs/decisions/2026-11-14-lint-warnings-fail-ci-and-rules-stay-at-the-preset-level.md`).

Fixing the code, not lowering a rule, keeps runtime behavior the same while each wrong
assumption now fails with a message. A `!` checks nothing: when it is wrong, the code fails
later with an unrelated error, or not at all.

## Evidence

- Before, on `main` at `a64726b`: 543 Biome warnings and 32 infos. By rule:
  `noNonNullAssertion` 347, `useOptionalChain` 91, `useExhaustiveDependencies` 84,
  `noExplicitAny` 19, `noConfusingVoidType` 1, `noCommaOperator` 1. ESLint: 0 warnings.
- After: 0 Biome warnings (the 32 infos are unchanged; an info does not fail
  `--error-on-warnings`) and 0 ESLint warnings.
- Nine `biome-ignore` comments, all `lint/suspicious/noExplicitAny`: `readBody()`'s request body
  (arbitrary client JSON that the writers coerce); the HTTP JSON response type `JsonBody` in
  six e2e harnesses; and two MQTT payloads in `e2e/fake-mqtt.ts` and
  `e2e/device-registry-test.ts`.
- Rules that `biome.json` still turns off, with their findings at the preset's level after this
  change: `style/noNonNullAssertion` (54), `a11y/noNoninteractiveTabindex` (1),
  `a11y/noStaticElementInteractions` (1) and `a11y/useKeyWithClickEvents` (2) in `web/`, and
  `style/noDescendingSpecificity` (43) in `web/src/styles/app.css`.
