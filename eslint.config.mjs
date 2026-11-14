import { createAppConfig } from "@charcuterie/eslint-config"
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
// `server/`, `shared/`, and `e2e/` (which `e2e/tsconfig.json`
// types).
export default defineConfig(
  ...createAppConfig({
    tsconfigRootDir: import.meta.dirname,
    appDirectories: ["web"],
    ignores: ["docs/**", "cast_sidecar/**"],
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
  // This repo adopted ESLint after the code, on 2026-11-13. The
  // sweep has returned `id-length` and `react/no-multi-comp` to
  // the preset's `error`. One rule is left:
  //
  //   - `@typescript-eslint/naming-convention`: 244 boolean type
  //     properties (202 in server, 42 in web). Many are wire and
  //     YAML fields, such as `ok`, `done`, `enabled`, and
  //     `keep_completed`, which a rename would break. Each needs a
  //     decision.
  //
  // It is `warn`, not `off`, so each one stays visible. Only the
  // severity changes here; the preset's options still apply. The
  // root `lint` script passes `--max-warnings`, so a new finding
  // fails the run instead of joining the count. Lower that number
  // as the sweep removes findings, and return the rule to the
  // preset's `error` when its count reaches zero.
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/naming-convention": "warn",
    },
  },
)
