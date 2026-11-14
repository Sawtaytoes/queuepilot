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
//
// Every rule is at the preset's level, and an unused disable
// comment is an error (below). A name that something outside TypeScript fixes (an
// HTTP, YAML, SQLite, MQTT, Plex, or Kavita field, or a field an
// untyped e2e stub reads) keeps its name, with an
// `eslint-disable-next-line` and a reason on that line. See
// `docs/decisions/2026-11-14-every-lint-rule-is-at-the-preset-level.md`.
export default defineConfig(
  ...createAppConfig({
    tsconfigRootDir: import.meta.dirname,
    appDirectories: ["web"],
    ignores: ["docs/**", "cast_sidecar/**"],
  }),

  // The preset reports an unused `eslint-disable` comment as a
  // warning, and `lint` passes no `--max-warnings`. As an error,
  // a suppression that no longer covers a finding fails the run
  // instead of staying behind.
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },

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
)
