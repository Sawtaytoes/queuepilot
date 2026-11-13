import {
  createAppConfig,
  createStoryOverrides,
  MULTI_COMPONENT_FILE_GLOBS,
} from "@charcuterie/eslint-config"
import { defineConfig } from "eslint/config"

// The house rules, from the fleet's shared preset. Biome covers
// formatting and most linting; ESLint adds the type-aware rules
// Biome cannot express: `id-length`, the `is`/`has` boolean
// names, one component per file, and `test()` rather than `it()`.
//
// `.mjs`, because the workspace root deliberately declares no
// `type` (see the root `package.json`).
//
// `web` is the only package that renders markup, so it is the
// only one the component and logical-properties rules apply to.
// The typed rules cover every `.ts` and `.tsx` file in `web/`,
// `server/`, and `shared/`.
//
// `e2e/` is not linted yet. It is about 41,000 lines of test
// harness in its own style, and adopting it is a separate change.
export default defineConfig(
  ...createAppConfig({
    tsconfigRootDir: import.meta.dirname,
    appDirectories: ["web"],
    ignores: ["e2e/**", "docs/**", "cast_sidecar/**"],
  }),

  // `shared/queueTitle.ts` belongs to no tsconfig of its own:
  // `web/` and `server/` both import it by relative path, so the
  // project service would otherwise report a parse error for it.
  // The block covers every typed file, not only `shared/`, because
  // the parser builds one project service from the options it sees
  // first.
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["shared/*.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ── The staged backlog ─────────────────────────────────────
  //
  // This repo adopted ESLint after the code, on 2026-11-13. Three
  // house rules found more than a sweep in the same change could
  // review safely:
  //
  //   - `id-length`: 1,752 (1,202 in server, 549 in web, 1 in
  //     shared)
  //   - `@typescript-eslint/naming-convention`: 381 (315 in
  //     server, 66 in web). Many are wire and YAML fields, such
  //     as `ok`, `done`, `enabled`, and `keep_completed`, which a
  //     rename would break. Each needs a decision.
  //   - `react/no-multi-comp`: 65, all in web
  //
  // They are `warn`, not `off`, so each one stays visible. Only
  // the severity changes here; the preset's options still apply.
  // The root `lint` script passes `--max-warnings`, so a new
  // finding fails the run instead of joining the count. Lower that
  // number as the sweep removes findings, and return each rule to
  // the preset's `error` when its count reaches zero.
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "id-length": "warn",
      "@typescript-eslint/naming-convention": "warn",
    },
  },
  {
    files: ["web/**/*.{ts,tsx}"],
    rules: {
      "react/no-multi-comp": "warn",
    },
  },
  // Again after the block above, so files that may declare several
  // components (tests, stories, icon modules) stay exempt.
  createStoryOverrides({
    files: MULTI_COMPONENT_FILE_GLOBS,
  }),
)
