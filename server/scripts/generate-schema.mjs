import { readFileSync, writeFileSync } from "node:fs"

// schema.sql -> schema.generated.ts.
//
// WHY THIS EXISTS AND IS NOT A `readFileSync` AT RUNTIME. The production image ships ONLY
// `server/dist/index.js` — no `server/src`, no assets — and `build-server.mjs` says so out
// loud: "Nothing. Deliberately… If a dep ever DOES need to stay out (a native addon, or
// something that resolves a file from `import.meta.url`), add it here". A schema read off
// disk at boot would work under tsx and every e2e harness, and would then fail in the
// container, which is the worst place to find out. Node 26 has no `with { type: 'text' }`
// for a `.sql` file either — checked, it throws ERR_UNKNOWN_FILE_EXTENSION.
//
// So the SQL is inlined into a TypeScript module. `schema.sql` stays the reviewable artifact
// the decision record points at, this is its compiled twin, and `store/schema.test.ts` fails
// the build if the two ever disagree. Regenerate with:
//
//   node server/scripts/generate-schema.mjs
//
// Run from the repo root or from server/ — both are resolved below.

const source = "src/store/schema.sql"
const target = "src/store/schema.generated.ts"
const prefix = process.cwd().endsWith("/server") ? "" : "server/"

const sql = readFileSync(prefix + source, "utf8")

writeFileSync(
  prefix + target,
  `// GENERATED FROM store/schema.sql — DO NOT EDIT.
//
// Run \`node server/scripts/generate-schema.mjs\` after every change to \`schema.sql\`.
// \`store/schema.test.ts\` fails when this file is stale, so a forgotten regeneration is a red
// CI run rather than a database that is missing a column in production.
//
// JSON.stringify, not a template literal: schema.sql's comments are full of backticks.
export const SCHEMA_SQL = ${JSON.stringify(sql)};
`,
)

console.log(`[schema] ${target} — ${(sql.length / 1024).toFixed(1)} KB of SQL`)
