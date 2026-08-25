// STAGING CLI — put a copy of Board Game Picker's live collection where the absorb can read it.
//
//     server/node_modules/.bin/tsx server/src/tools/stage-board-game-collection.ts [options]
//
//       --from <dir>   the sibling app's config directory
//                      (default: $BOARD_GAME_PICKER_CONFIG, else /config/board-game-picker)
//       --to <dir>     this app's config directory
//                      (default: dirname($QUEUES_PATH), else /config)
//       --apply        WRITE. Without it this is a dry run and nothing is copied.
//       --no-images    skip the artwork
//       --no-cache     skip the other-servers cache
//
// PRINT-FIRST, like `migrate-entry-objects.ts`. The dry run is the default and prints the row
// count of every table on both sides, so the numbers are read BEFORE anything is written.
//
// ── ⚠️ THE CHECKPOINT, AND WHY IT IS A SCRIPT AND NOT A SENTENCE IN A RUNBOOK ────────────
//
// The sibling app runs its database in WAL mode. A plain `cp` of the `.sqlite` file alone
// copies the database as of the last checkpoint and silently leaves behind every committed row
// still sitting in the `-wal` — which, on the live file this was written against, was a 4.1 MB
// sidecar. Nothing about the copy looks wrong afterwards: it opens, it queries, it is simply
// missing whatever happened most recently. Plays and known-how are exactly the tables that get
// the most recent writes.
//
// So this tool copies the `.sqlite`, the `-wal` and the `-shm` in ONE operation — the three
// have to come from the same instant or the copy is torn — and then runs
// `PRAGMA wal_checkpoint(TRUNCATE)` on the COPY.
//
// ── IT NEVER OPENS THE LIVE FILE FOR WRITING ────────────────────────────────────────────
//
// The sibling app is still serving today; WP-4e has not swapped the transport. Checkpointing
// the live file would work and would also be a write into a database another process owns, for
// the benefit of a migration that does not need it. The copy is checkpointed instead, and the
// live file is opened `readOnly` once, to read the counts the copy is compared against.
//
// That comparison is the whole proof. A checkpoint that folded nothing and a checkpoint that
// folded four thousand pages look identical from the outside; the numbers do not.
//
// ── THE DESTINATION IS NEVER OVERWRITTEN IN PLACE ───────────────────────────────────────
//
// The staged file is written under a temporary name in the destination directory and renamed
// over the old one. A `rename` inside one directory is atomic, so a reader — this app, at boot,
// while somebody is running this tool — sees the old collection or the new one and never a
// half-written file.
//
// ── WHAT ELSE COMES ACROSS ──────────────────────────────────────────────────────────────
//
//   `images/`  →  `board-game-images/`   the covers. 32 of them the owner picked by hand, and
//                                        they are NOT a cache: the upstream has turned access
//                                        off before, so a re-fetch is not a recovery plan.
//   `cache/`   →  `board-game-cache/`    other people's servers, cached. Derived and in that
//                                        sense disposable, except that re-deriving it means
//                                        thousands of calls to a rate-limited public API.
//
// Both are copied ADDITIVELY — a file already at the destination is left alone. Neither
// directory has a deleter, here or anywhere else in this app: WP-4d owns the writers, and
// until they land the sibling app is still the one editing this data.
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The sibling app's fifteen tables, so a count is reported for every one of them and not only
 * for the twelve the absorb copies. `players` / `groups` / `group_players` merge into this
 * app's people tables through the gated people import, and a reader needs to see they were
 * there. */
const SOURCE_TABLES = [
  'games',
  'boxes',
  'game_overrides',
  'game_links',
  'game_modules',
  'categories',
  'game_categories',
  'owner_groupings',
  'grouping_reviews',
  'plays',
  'play_players',
  'player_known_games',
  'players',
  'groups',
  'group_players',
] as const;

/** The file name the absorb looks for. `store/migrate/boardgames.ts sourcePath()` is the other
 * half of this constant; the two must not drift. */
const STAGED_NAME = 'board-game-picker-import.sqlite';

/** The two trees, and the option that turns each one off. `switch` is the Options key, so a
 * new directory cannot be added without saying how it is skipped. */
const DIRECTORIES: readonly { from: string; switch: 'cache' | 'images'; to: string }[] = [
  { from: 'images', switch: 'images', to: 'board-game-images' },
  { from: 'cache', switch: 'cache', to: 'board-game-cache' },
];

interface Options {
  apply: boolean;
  cache: boolean;
  from: string;
  images: boolean;
  to: string;
}

function argFor(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] != null ? String(argv[i + 1]) : null;
}

function parseArgs(argv: readonly string[]): Options {
  const queues = process.env.QUEUES_PATH || '/config/queues.yaml';
  return {
    apply: argv.includes('--apply'),
    cache: !argv.includes('--no-cache'),
    from:
      argFor(argv, '--from') ||
      process.env.BOARD_GAME_PICKER_CONFIG ||
      '/config/board-game-picker',
    images: !argv.includes('--no-images'),
    to: argFor(argv, '--to') || path.dirname(queues),
  };
}

type Counts = Record<string, number>;

/** Every table's row count, or `-1` for a table the file does not have. A missing table is a
 * finding rather than a crash: it is what a source that has moved on looks like. */
function countRows(db: DatabaseSync): Counts {
  const present = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String((row as { name: string }).name)),
  );
  const counts: Counts = {};
  for (const table of SOURCE_TABLES) {
    counts[table] = present.has(table)
      ? Number((db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c)
      : -1;
  }
  return counts;
}

/** The database, the WAL and the shared-memory file, into a scratch directory in one pass.
 * Returns the path of the copied database. */
function copyDatabaseSet(source: string, into: string): string {
  const copied = path.join(into, path.basename(source));
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(source + suffix)) copyFileSync(source + suffix, copied + suffix);
  }
  return copied;
}

/**
 * Fold the WAL into the copy and report what it folded, then take the copy OUT of WAL mode.
 *
 * The second half matters as much as the first. A staged file left in WAL mode is three files
 * pretending to be one: the absorb opens it `readOnly` and SQLite still writes a `-shm` beside
 * it to do that, so the artifact grows sidecars in the destination directory and a later `cp`
 * of "the staged file" is the same silent half-copy this whole tool exists to prevent.
 * `journal_mode = DELETE` after the checkpoint makes the snapshot exactly one file.
 */
function checkpoint(file: string): { checkpointed: number; log: number } {
  const db = new DatabaseSync(file);
  const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
    busy: number;
    checkpointed: number;
    log: number;
  };
  db.prepare('PRAGMA journal_mode = DELETE').get();
  db.close();
  return { checkpointed: Number(result.checkpointed), log: Number(result.log) };
}

/**
 * Give a freshly written file the destination directory's group, and group read/write.
 *
 * ⚠️ NOT COSMETIC. The app runs as a different user from whoever runs this tool, and reaches
 * its config through group membership. The destination directory carries no setgid bit, so a
 * file created here lands under the TOOL RUNNER's primary group and the app cannot open it —
 * which surfaces at the next boot as "no board-game collection to import", the same message a
 * container with no collection at all prints. A silent skip, not an error.
 *
 * Best effort. On a filesystem where the group cannot be changed this prints and carries on;
 * the copy is still correct, and the reader has been told to check.
 */
function adoptGroup(file: string, directory: string): void {
  try {
    const target = statSync(directory);
    chownSync(file, statSync(file).uid, target.gid);
    chmodSync(file, 0o660);
  } catch (e) {
    console.log(`could not give ${path.basename(file)} the group of ${directory}: ${String(e)}`);
  }
}

/** Copy a tree, additively. Returns how many files were written and how many were already
 * there. Never deletes: nothing in this app owns these directories yet. */
function copyTree(from: string, to: string, apply: boolean): { kept: number; written: number } {
  let kept = 0;
  let written = 0;

  const walk = (source: string, destination: string): void => {
    if (apply) mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const child = path.join(source, entry.name);
      const target = path.join(destination, entry.name);
      if (entry.isDirectory()) {
        walk(child, target);
      } else if (entry.isFile()) {
        if (existsSync(target) && statSync(target).size === statSync(child).size) {
          kept += 1;
        } else {
          written += 1;
          if (apply) copyFileSync(child, target);
        }
      }
    }
  };

  walk(from, to);
  return { kept, written };
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const live = path.join(options.from, 'board-game-picker.sqlite');

  if (!existsSync(live)) {
    console.log(`no collection at ${live} — nothing to stage`);
    return 1;
  }
  if (!existsSync(options.to)) {
    console.log(`no destination directory at ${options.to}`);
    return 1;
  }

  const scratch = mkdtempSync(path.join(tmpdir(), 'stage-collection-'));
  let failures = 0;

  try {
    // The copy first, so the three files come from as close to one instant as a filesystem
    // gives us — then the live read, which is the number the copy is judged against.
    const copy = copyDatabaseSet(live, scratch);
    const folded = checkpoint(copy);
    console.log(
      `wal_checkpoint(TRUNCATE) on the copy — folded ${folded.checkpointed} page(s), ` +
        `${folded.log} left in the log`,
    );

    const liveDb = new DatabaseSync(live, { readOnly: true });
    const liveCounts = countRows(liveDb);
    liveDb.close();

    const copyDb = new DatabaseSync(copy, { readOnly: true });
    const copyCounts = countRows(copyDb);
    copyDb.close();

    console.log('');
    console.log('table                  live   staged');
    for (const table of SOURCE_TABLES) {
      const agree = liveCounts[table] === copyCounts[table];
      if (!agree) failures += 1;
      console.log(
        `${table.padEnd(20)} ${String(liveCounts[table]).padStart(6)} ` +
          `${String(copyCounts[table]).padStart(8)}  ${agree ? '' : '  ← DISAGREE'}`,
      );
    }

    if (failures > 0) {
      // The one failure mode this tool exists to catch. A disagreement means the copy was taken
      // while the sibling app was mid-write, and the answer is to run it again — never to stage
      // the file anyway and let the absorb assert against a source that has already moved.
      console.log('');
      console.log(
        `${failures} table(s) disagree — the copy was torn. Nothing was staged; run it again.`,
      );
      return 1;
    }

    const staged = path.join(options.to, STAGED_NAME);
    if (options.apply) {
      const pending = `${staged}.staging`;
      copyFileSync(copy, pending);
      adoptGroup(pending, options.to);
      renameSync(pending, staged);
      console.log('');
      console.log(`staged ${staged}`);
    } else {
      console.log('');
      console.log(`DRY RUN — ${staged} would be replaced. Re-run with --apply to write.`);
    }

    for (const directory of DIRECTORIES) {
      if (!options[directory.switch]) continue;
      const source = path.join(options.from, directory.from);
      if (!existsSync(source)) {
        console.log(`${directory.from}/ — not present, skipped`);
        continue;
      }
      const target = path.join(options.to, directory.to);
      const result = copyTree(source, target, options.apply);
      console.log(
        `${directory.from}/ → ${directory.to}/ — ` +
          `${result.written} file(s) ${options.apply ? 'copied' : 'would be copied'}, ` +
          `${result.kept} already there`,
      );
    }
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }

  return 0;
}

process.exit(main());
