// PROVE THE DRIVER SHIM against the data layer it was written for, WITHOUT copying that data
// layer into this repo.
//
// WHY THIS IS A SCRIPT AND NOT A COMMITTED TEST SUITE. The plan for WP-4a said to move Board
// Game Picker's four `db/*.test.ts` suites over unchanged and make them the CI gate. Two facts
// found in the code stop that, and both are worth knowing before WP-4b starts:
//
//   1. Those four suites are not driver tests. They import `repository.ts` (1,029 lines),
//      `merge.ts` (437), `import/collection.ts` (565), `import/grouping.ts` (718) and the
//      contracts package (453). Running them here means vendoring ~3,400 lines of the app
//      that WP-4b and WP-4c are chartered to port — the opposite of this package's scope.
//
//   2. THIS REPO IS PUBLIC, and some of that code is household data rather than code.
//      `import/grouping.ts` carries a hand-curated table of collection-specific grouping
//      rules — real titles, in DATA, beside dated quotes of the owner's rulings about them —
//      and `db/schema.sql` names several more in its comments. "Library contents are
//      placeholders" is a hard rule here (AGENTS.md). Vendoring those files as they stand
//      would break it. Sanitizing them is a design question about where owner rules should
//      live, which is WP-4b's call and not a side effect of a driver port.
//
// So the proof runs OUT OF TREE. Point this at a board-game-picker checkout and it copies the
// closure into a scratch directory, applies the two mechanical transforms the port needs, and
// runs the four suites with their bodies and assertions untouched. Nothing it reads is
// committed here; nothing it writes outlives the run.
//
//   node scripts/verify-board-game-picker-port.mjs <path-to-board-game-picker>
//   BOARD_GAME_PICKER_CHECKOUT=… node scripts/verify-board-game-picker-port.mjs
//
// THE TWO TRANSFORMS, which are the entire manual part of the port and are asserted by count
// so a drift in the source fails loudly rather than silently porting less:
//
//   * `database.ts` swaps `better-sqlite3` for `../../…/store/sqlite.ts`. Rewritten in full
//     below, so the ported file is reviewable as a file rather than as a diff.
//   * `db.transaction(() => {…})()` becomes `db.withTransaction(() => {…})` — 11 sites. The
//     shim has no callable-returning `.transaction()`; see its header for why.
//
// Everything else — every `prepare(…).get/.all/.run`, every `as {…}[]` cast on a result, every
// named-parameter object — is copied byte for byte. That is the claim this script exists to
// test.
import { execFileSync } from "node:child_process"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const checkout = resolve(
  process.argv[2] ?? process.env.BOARD_GAME_PICKER_CHECKOUT ?? "",
)

if (checkout === resolve("")) {
  console.error(
    "Give me a board-game-picker checkout:\n" +
      "  node scripts/verify-board-game-picker-port.mjs <path>\n" +
      "  BOARD_GAME_PICKER_CHECKOUT=<path> node scripts/verify-board-game-picker-port.mjs",
  )
  process.exit(2)
}

const source = join(checkout, "packages")
const scratch = mkdtempSync(join(tmpdir(), "queuepilot-bgp-port-"))

/** Copy one file across and hand back its text, so a transform can be asserted on it. */
const bring = (from, to) => {
  mkdirSync(dirname(join(scratch, to)), { recursive: true })
  cpSync(join(source, from), join(scratch, to))
  return readFileSync(join(scratch, to), "utf8")
}

/** Apply a replacement and REFUSE to continue unless it fired exactly `expected` times. A
 * transform that silently matched nothing is how a port claims to have moved code it did
 * not. */
const rewrite = (file, needle, replacement, expected) => {
  const path = join(scratch, file)
  const before = readFileSync(path, "utf8")
  const hits = before.split(needle).length - 1

  if (hits !== expected) {
    throw new Error(
      `${file}: expected ${expected} occurrence(s) of ${JSON.stringify(needle)}, found ${hits}. ` +
        "The source moved — re-measure before trusting this run.",
    )
  }

  writeFileSync(path, before.replaceAll(needle, replacement))
}

try {
  // ---- the closure, verbatim ------------------------------------------------------------
  for (const file of [
    "db/repository.ts",
    "db/merge.ts",
    "db/schema.sql",
    "db/groupingReviews.test.ts",
    "db/knownGames.test.ts",
    "db/merge.test.ts",
    "db/modules.test.ts",
    "import/collection.ts",
    "import/grouping.ts",
    "import/csv.ts",
  ]) {
    bring(join("server/src", file), file)
  }

  bring("contracts/src/index.ts", "contracts.ts")

  // The contracts package is a workspace dependency there and a sibling file here. Nothing
  // else about the imports changes. `repository.ts` names it twice — once for types, once for
  // the `GAME_LINK_KINDS` value.
  for (const [file, count] of Object.entries({
    "db/repository.ts": 2,
    "db/merge.ts": 1,
    "import/collection.ts": 1,
  })) {
    rewrite(file, '"@board-game-picker/contracts"', '"../contracts.ts"', count)
  }

  // ---- transform 1: the 11 transaction sites --------------------------------------------
  const transactionSites = { "db/repository.ts": 5, "db/merge.ts": 5, "import/collection.ts": 1 }

  for (const [file, count] of Object.entries(transactionSites)) {
    rewrite(file, "db.transaction(", "db.withTransaction(", count)
    // Each body ends `  })()` at the top level of its function. `withTransaction` RUNS the
    // body; it does not hand back a function that runs it.
    rewrite(file, "\n  })()", "\n  })", count)
  }

  // ---- transform 2: database.ts, ported onto the shim ------------------------------------
  //
  // Rewritten rather than patched, because three things move at once: the driver import, the
  // `Db` type alias, and `pragma("table_info(…)")`'s result type. Everything else — the
  // env-driven path, the WAL/foreign-keys pragmas, the additive `addMissingColumns` list — is
  // the original's, comment for comment, so a reviewer can diff it against the source.
  writeFileSync(
    join(scratch, "db/database.ts"),
    `import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { openSqlite, type SqliteDatabase } from ${JSON.stringify(join(serverRoot, "src/store/sqlite.ts"))}

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Where the database lives. In production this is the
 * container's /config mount; in a test it is \`:memory:\`.
 */
export const databasePath = (): string => {
  const configured = process.env.BOARD_GAME_PICKER_DB
  if (configured) return configured

  return join(here, "../../../..", "data/board-game-picker.sqlite")
}

/** Was \`Database.Database\` from better-sqlite3. Now the shim's handle. Every consumer of
 * this type keeps compiling: the members it uses are \`prepare\`, \`exec\` and \`pragma\`. */
export type Db = SqliteDatabase

export const openDatabase = (path = databasePath()): Db => {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true })
  }

  const db = openSqlite(path)

  // WAL so a long import cannot block the pick endpoint, and
  // foreign keys because every cascade in the schema assumes
  // them — SQLite has them OFF by default, which is how a
  // deleted game leaves orphaned boxes behind forever.
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")

  db.exec(readFileSync(join(here, "schema.sql"), "utf8"))
  addMissingColumns(db)

  return db
}

/**
 * The one thing \`CREATE TABLE IF NOT EXISTS\` cannot do: add a
 * column to a table that already exists on the deployed
 * \`/config\` database. Additive only.
 */
const addMissingColumns = (db: Db): void => {
  const columns: [string, string, string][] = [
    ["game_overrides", "is_excluded_source", "TEXT"],
    ["boxes", "version_nickname", "TEXT"],
    ["boxes", "version_year", "INTEGER"],
    ["boxes", "version_languages", "TEXT NOT NULL DEFAULT '[]'"],
    ["game_overrides", "image_path", "TEXT"],
    ["games", "image_path", "TEXT"],
    ["owner_groupings", "listing_bgg_id", "INTEGER"],
    ["grouping_reviews", "parent_game_id", "TEXT"],
  ]

  for (const [table, column, definition] of columns) {
    const existing = (
      db.pragma(\`table_info(\${table})\`) as {
        name: string
      }[]
    ).map((row) => row.name)

    if (!existing.includes(column)) {
      db.exec(
        \`ALTER TABLE \${table} ADD COLUMN \${column} \${definition}\`,
      )
    }
  }
}
`,
  )

  // ---- run it ----------------------------------------------------------------------------
  writeFileSync(
    join(scratch, "package.json"),
    `${JSON.stringify({ name: "queuepilot-bgp-port-proof", private: true, type: "module" }, null, 2)}\n`,
  )
  writeFileSync(
    join(scratch, "vitest.config.ts"),
    'import { defineConfig } from "vitest/config"\n\n' +
      "export default defineConfig({ test: { globals: true, include: [\"db/**/*.test.ts\"] } })\n",
  )
  // vitest, and everything it resolves, comes from THIS workspace's install. The scratch tree
  // declares no dependencies of its own and installs nothing — one symlink, not a copy.
  symlinkSync(join(serverRoot, "node_modules"), join(scratch, "node_modules"), "dir")

  console.log(`proof tree: ${scratch}\n`)

  execFileSync(join(serverRoot, "node_modules/.bin/vitest"), ["run", "--root", scratch], {
    stdio: "inherit",
    cwd: scratch,
  })
} finally {
  if (!process.env.KEEP_PROOF_TREE) rmSync(scratch, { force: true, recursive: true })
}
