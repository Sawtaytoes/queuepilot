// THE COLLECTION ABSORB — twelve tables out of a sibling app's SQLite file into the book of
// record, plus the grouping rules the owner had written in that app's SOURCE.
//
// ── The two inputs, and why the second one exists at all ─────────────────────────────────
//
//   `<config>/board-game-picker-import.sqlite`   the collection. Placed here by the absorb,
//                                                read-only, never the sibling app's live file.
//   `<config>/board-game-grouping-seed.yaml`     the merge rules that used to be a table in
//                                                that app's source code.
//
// The second one is a decision, not a convenience
// (decision 2026-08-23-the-collections-grouping-rules-are-rows-not-source): the rules that
// collapse a shelf of physical boxes into a list of playable titles are DATA about one
// household's shelf, so this repo keeps the algorithm and the table shape and never the
// contents. A committed example with invented titles is `board-game-grouping-seed.example.yaml`;
// the real file lives in `/config` and never enters the tree.
//
// BOTH ARE OPTIONAL. Neither exists on a CI runner or in any offline harness, and the absorb
// then does nothing, opens no database and logs nothing. A fresh container with an empty
// collection is not broken — it is a container nobody has given a collection to.
//
// ── Idempotency, and the honest shape of it ──────────────────────────────────────────────
//
// Fingerprinted on the sha256 of both inputs. Same fingerprint → nothing happens. Different →
// the twelve tables are REPLACED from the source, in one transaction, and the seed is inserted
// on top with `ON CONFLICT DO NOTHING` so it can never overwrite a rule the owner made.
//
// ── ⚠️ THE ABSORB IS RETIRED, AND THIS IS THE CHANGE THAT RETIRED IT (WP-4d) ─────────────
//
// A REPLACE was the right answer only while the sibling app was the one being edited. WP-4d
// lands the first writers — the BGG sync, the art, the rulebook and video linkers — so the
// overlap is over and the REPLACE is now the thing that would destroy the owner's work.
//
// So the absorb is a ONE-WAY DOOR. `retire()` writes `store_meta('boardgames','retired_at')`
// and renames the source file to `board-game-picker-import.sqlite.retired-<timestamp>`, and
// from that moment `importBoardGames()` refuses — INCLUDING under `force: true`, because a
// flag that re-runs a whole-table REPLACE over a live collection is not a debugging
// convenience, it is a delete button with a innocent name.
//
// WHEN IT FIRES. At the end of the boot hook, whenever the store holds a collection — whether
// this boot absorbed it or a previous one did. On the live system the fingerprint already
// matches, so nothing is absorbed and the latch is set on the first start after this deploys.
// On a fresh container somebody stages a collection into: absorb once, retire immediately.
//
// THE SEED IS NOT RETIRED WITH IT, and that distinction is the point. The source file is a
// second BOOK OF RECORD — it carries rows that replace ours. `board-game-grouping-seed.yaml`
// is not: every insert it makes is `ON CONFLICT DO NOTHING`, so it can only ever ADD a rule
// and can never take one back. Retiring it too would leave the owner with no way at all to
// add a grouping rule, because the screen that WP-4b's decision promises does not exist yet.
// So after retirement the boot hook runs `seedGroupingRules()` — the seed half alone, gated on
// its own fingerprint, touching none of the twelve tables' contents.
//
// GETTING BACK. Deliberately awkward, because it means discarding everything this app has
// recorded about the collection since the cutover. Rename the `.retired-*` file back AND
// `DELETE FROM store_meta WHERE store = 'boardgames' AND key = 'retired_at'`. Two steps, by
// hand, with the app stopped. There is no flag and there must not be one.
//
// ── Every write goes through `prepareChecked` ────────────────────────────────────────────
//
// WP-4a difference #6: node:sqlite binds NULL for a named parameter the caller FORGOT, where
// the old driver threw. This file is twelve hand-written column lists — the exact shape of
// write that omits one — and the omission would be silent. An UNKNOWN key still throws, so a
// typo is caught either way; it is the omission `prepareChecked` closes.
//
// ── The two tables keyed on a person ─────────────────────────────────────────────────────
//
// `board_game_known_how` and `board_game_play_people` name a human, and the people import is
// GATED on an owner-confirmed mapping file that has not been confirmed. So they arrive holding
// the SOURCE APP'S own player ids, verbatim, and `store/migrate/people.ts` re-keys them inside
// the same transaction that creates the people. This file resolves through `people.source_id`
// where a person already exists, so the two can run in either order and converge.
//
// Losing or mis-attributing a known-how row is worse than losing a play: "can this person
// start this game without the rulebook" is a claim a person STATES, which a play may renew and
// must never invent, and it appears on no screen attached to a name — so nobody would notice.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

import { QUEUES_PATH, STORE_BACKEND } from '../../config.js';
import { errMessage } from '../../errors.js';
import { bumpVersion, readMeta, writeMeta } from '../db/common.js';
import {
  BOARD_GAME_TABLES,
  boardGameCounts,
  normalizeTitle,
  type BoardGameTable,
} from '../db/boardgames.js';
import { bookOfRecord, prepareChecked } from '../db/open.js';
import { wrapSqlite, type SqliteDatabase } from '../sqlite.js';

/** One prefix rule as the seed file spells it. Snake_case because a human edits this file. */
export interface SeedGrouping {
  /** A LITERAL title prefix in comparison form — lower case, punctuation folded to spaces. */
  prefix: string;
  game_id: string;
  game_name: string;
  listing_bgg_id?: number | string | null;
  /** A single literal that takes a matching box back out of the family. */
  except_contains?: string | null;
  is_game_from_expansions?: boolean;
}

/** One "yes, that really is its own title" answer. */
export interface SeedReview {
  /** The COMPARISON FORM of the title, which is what the grouping pass matched on. */
  box_label: string;
  reason?: string | null;
  reviewed_at?: string | null;
}

export interface GroupingSeed {
  version?: number;
  groupings?: SeedGrouping[];
  reviews?: SeedReview[];
}

export interface BoardGameImportReport {
  imported: boolean;
  reason: string;
  /** Where the collection was read from, or null when there was none. */
  source: string | null;
  /** Where the rules were read from, or null. */
  seed: string | null;
  /** Row counts after the import, by table. */
  counts: Record<BoardGameTable, number>;
  /** How many rule rows the seed contributed — after `ON CONFLICT DO NOTHING`. */
  seededGroupings: number;
  seededReviews: number;
  /** `person_id`s on the two people-keyed tables that no `people` row answers. Expected to be
   * every one of them until the people mapping is confirmed. */
  unresolvedPeople: string[];
  /** Every assertion that failed. Non-empty means the transaction was rolled back. */
  problems: string[];
}

const EMPTY_COUNTS = Object.fromEntries(
  BOARD_GAME_TABLES.map((table) => [table, 0]),
) as Record<BoardGameTable, number>;

const report = (
  imported: boolean,
  reason: string,
  extra: Partial<BoardGameImportReport> = {},
): BoardGameImportReport => ({
  counts: EMPTY_COUNTS,
  imported,
  problems: [],
  reason,
  seed: null,
  seededGroupings: 0,
  seededReviews: 0,
  source: null,
  unresolvedPeople: [],
  ...extra,
});

/** Where the collection may be. Derived from `QUEUES_PATH` rather than hard-coded to `/config`,
 * so an offline harness that points the YAML paths at a scratch directory gets its own. */
export const sourcePath = (): string =>
  process.env.BOARD_GAME_IMPORT_PATH ||
  join(dirname(QUEUES_PATH), 'board-game-picker-import.sqlite');

/** Where the owner's grouping rules may be. */
export const seedPath = (): string =>
  process.env.BOARD_GAME_GROUPING_SEED_PATH ||
  join(dirname(QUEUES_PATH), 'board-game-grouping-seed.yaml');

/** `(mtimeMs, size)` for both inputs — the cheap gate, so a start does not hash 640 KB. */
function inputStamp(): string {
  return [sourcePath(), seedPath()]
    .map((candidate) => {
      try {
        const stat = statSync(candidate);
        return `${candidate}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${candidate}:absent`;
      }
    })
    .join('|');
}

const sha256 = (file: string): string => {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return 'absent';
  }
};

const fingerprint = (): string => `source:${sha256(sourcePath())}|seed:${sha256(seedPath())}`;

// ── The retirement latch ──────────────────────────────────────────────────────────────── //

/** `store_meta` key. Present ⇒ this app owns the collection and the absorb is closed. */
const RETIRED_KEY = 'retired_at';

/** Has the source file been retired? Once true, never false again — see the file header. */
export const isBoardGameSourceRetired = (db: SqliteDatabase = bookOfRecord()): boolean =>
  readMeta(db, 'boardgames', RETIRED_KEY) !== null;

/**
 * Close the door: latch the meta row, then move the source file aside.
 *
 * The LATCH is what makes the retirement true — a renamed file could be renamed back, and a
 * `BOARD_GAME_IMPORT_PATH` pointing somewhere else would walk straight past a rename. The
 * rename is what makes it VISIBLE: a human looking in `/config` can see that the import file
 * is spent, and can see the timestamp it stopped being read.
 *
 * The rename is best-effort on purpose. `/config` can be read-only, the file can already be
 * gone, another process can hold it — and none of those is a reason to leave the latch unset
 * and let the next start REPLACE a collection this app is now writing to. The latch first,
 * then the file, and a failure on the second half is logged rather than thrown.
 */
export function retireBoardGameSource(
  db: SqliteDatabase = bookOfRecord(),
): { retired: boolean; movedTo: string | null } {
  if (isBoardGameSourceRetired(db)) return { movedTo: null, retired: false };

  const at = new Date().toISOString();
  writeMeta(db, 'boardgames', RETIRED_KEY, at);
  bumpVersion(db, 'boardgames');

  const source = sourcePath();
  if (!existsSync(source)) return { movedTo: null, retired: true };

  // Colons are legal in a POSIX filename but make the name miserable to type in a shell.
  const movedTo = `${source}.retired-${at.replace(/[:.]/g, '')}`;
  try {
    renameSync(source, movedTo);
    return { movedTo, retired: true };
  } catch (error) {
    console.log(
      `[boardgames] the collection is retired, but ${source} could not be moved aside: ` +
        `${errMessage(error)} — the latch is set, so it will not be read again`,
    );
    return { movedTo: null, retired: true };
  }
}

/**
 * The seed half, on its own, for a store whose source file is already retired.
 *
 * Adds grouping rules and answers reviews; it can never remove or replace either, and it never
 * touches the ten tables that hold the collection itself. Gated on the seed's own sha256 so a
 * start that changed nothing does no work.
 */
export function seedGroupingRules(): { seededGroupings: number; seededReviews: number } {
  const none = { seededGroupings: 0, seededReviews: 0 };
  const file = seedPath();
  if (!existsSync(file)) return none;

  const db = bookOfRecord();
  const current = sha256(file);
  if (readMeta(db, 'boardgames', 'seed_fingerprint') === current) return none;

  const { seed, problems } = readSeed(file);
  if (problems.length) {
    // Same rule as the absorb's: a half-read rule file silently stops grouping some boxes,
    // which shows up as a title going missing from the pool and nowhere else.
    console.log(`[boardgames] the grouping seed does not validate — nothing was written:`);
    for (const problem of problems) console.log(`[boardgames]   - ${problem}`);
    return none;
  }

  let seededGroupings = 0;
  let seededReviews = 0;
  db.withTransaction(() => {
    seededGroupings = seedGroupings(seed, db);
    seededReviews = seedReviews(seed, db);
    writeMeta(db, 'boardgames', 'seed_fingerprint', current);
    writeMeta(db, 'boardgames', 'seed_file', file);
    if (seededGroupings || seededReviews) bumpVersion(db, 'boardgames');
  });
  return { seededGroupings, seededReviews };
}

/** A boolean out of a hand-edited file. `undefined` is false; anything else has to say `true`. */
const asFlag = (value: unknown): number => (value === true ? 1 : 0);

/** A listing id, as the TEXT the column holds. Empty and non-finite both become NULL — a
 * `NaN` written as text would compare false against everything and be invisible. */
const asListingId = (value: unknown): string | null => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(Math.trunc(parsed)) : null;
};

/** A nullable string, trimmed. */
const asText = (value: unknown): string | null => {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
};

/** Read the seed file, or an empty seed when there is none. Returns problems rather than
 * throwing, so a file with four typos takes one round trip and not four. */
export function readSeed(file: string): { seed: GroupingSeed; problems: string[] } {
  if (!existsSync(file)) return { problems: [], seed: {} };

  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { problems: [`${file} is not valid YAML: ${errMessage(e)}`], seed: {} };
  }

  const seed = (raw && typeof raw === 'object' ? raw : {}) as GroupingSeed;
  const problems: string[] = [];

  if (seed.version !== 1) {
    problems.push(`${file}: version must be 1, found ${JSON.stringify(seed.version ?? null)}`);
  }

  const groupings = Array.isArray(seed.groupings) ? seed.groupings : [];
  const seenPrefixes = new Set<string>();
  for (const [index, rule] of groupings.entries()) {
    const where = `groupings[${index}]`;
    const prefix = asText(rule?.prefix);
    if (!prefix) {
      problems.push(`${where}: no prefix`);
      continue;
    }
    // The store never compiles a pattern out of a text column, so a rule that looks like one is
    // a rule somebody expected to be executed. Refuse it rather than matching it literally.
    if (/[\\^$*+?()[\]{}|]/.test(prefix)) {
      problems.push(`${where} '${prefix}': a prefix is a LITERAL, not a pattern`);
    }
    if (prefix !== prefix.toLowerCase()) {
      problems.push(`${where} '${prefix}': a prefix is in comparison form, which is lower case`);
    }
    if (seenPrefixes.has(prefix)) problems.push(`${where} '${prefix}': duplicate prefix`);
    seenPrefixes.add(prefix);
    if (!asText(rule.game_id)) problems.push(`${where} '${prefix}': no game_id`);
    if (!asText(rule.game_name)) problems.push(`${where} '${prefix}': no game_name`);
  }

  const reviews = Array.isArray(seed.reviews) ? seed.reviews : [];
  const seenLabels = new Set<string>();
  for (const [index, review] of reviews.entries()) {
    const label = asText(review?.box_label);
    if (!label) {
      problems.push(`reviews[${index}]: no box_label`);
      continue;
    }
    if (seenLabels.has(label)) problems.push(`reviews[${index}] '${label}': duplicate box_label`);
    seenLabels.add(label);
  }

  return { problems, seed };
}

/** Open the collection read-only. `readOnly` rather than politeness: this file is a copy of
 * another app's database and a write would create a `-wal` beside it. */
const openSource = (file: string): SqliteDatabase =>
  wrapSqlite(new DatabaseSync(file, { readOnly: true }));

const countOf = (db: SqliteDatabase, table: string): number =>
  (db.prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0);

/**
 * Run the absorb if it is the absorb's turn. Returns what it did, either way.
 *
 * `force` skips the fingerprint check — a deliberate re-run — but never the assertions.
 */
export function importBoardGames({ force = false }: { force?: boolean } = {}): BoardGameImportReport {
  const source = sourcePath();
  if (!existsSync(source)) return report(false, 'no board-game collection to import', { source: null });

  const seedFile = seedPath();
  const hasSeed = existsSync(seedFile);
  const current = fingerprint();
  const db = bookOfRecord();

  // THE ONE-WAY DOOR, and `force` does not open it. See the file header: this app writes these
  // tables now, so a REPLACE from a file the sibling app used to own is data loss, and a
  // deliberate re-run is exactly the request that would cause it.
  if (isBoardGameSourceRetired(db)) {
    return report(false, 'the collection is this app’s own — the source file is retired', {
      counts: boardGameCounts(db),
      seed: hasSeed ? seedFile : null,
      source,
    });
  }

  if (!force && readMeta(db, 'boardgames', 'source_fingerprint') === current) {
    return report(false, 'the collection has not changed since the last import', {
      counts: boardGameCounts(db),
      seed: hasSeed ? seedFile : null,
      source,
    });
  }

  const { seed, problems: seedProblems } = readSeed(seedFile);
  if (seedProblems.length) {
    // A half-read rule file is worse than none: the rules that parsed would apply and the ones
    // that did not would silently stop grouping boxes, which shows up as a title going missing
    // from the pool and nowhere else. So nothing is written at all.
    return report(false, 'the grouping seed does not validate — nothing was written', {
      problems: seedProblems,
      seed: seedFile,
      source,
    });
  }

  const from = openSource(source);
  const problems: string[] = [];
  let seededGroupings = 0;
  let seededReviews = 0;

  try {
    // Read every source count BEFORE the copy, so the assertion afterwards compares against the
    // file rather than against a number this function talked itself into.
    const expected = {
      boxes: countOf(from, 'boxes'),
      categories: countOf(from, 'categories'),
      game_categories: countOf(from, 'game_categories'),
      game_links: countOf(from, 'game_links'),
      game_modules: countOf(from, 'game_modules'),
      game_overrides: countOf(from, 'game_overrides'),
      games: countOf(from, 'games'),
      grouping_reviews: countOf(from, 'grouping_reviews'),
      owner_groupings: countOf(from, 'owner_groupings'),
      play_players: countOf(from, 'play_players'),
      player_known_games: countOf(from, 'player_known_games'),
      plays: countOf(from, 'plays'),
    };
    const ownerExcluded = countOf(
      from,
      "game_overrides WHERE is_excluded_source = 'owner'",
    );
    const ownerLinks = countOf(from, "game_links WHERE source = 'owner'");

    db.withTransaction(() => {
      // Children first — the FKs cascade, but an explicit reverse-order delete says what is
      // happening rather than relying on a pragma being on.
      for (const table of [...BOARD_GAME_TABLES].reverse()) {
        prepareChecked(db, `DELETE FROM ${table}`).run();
      }

      copyGames(from, db);
      copyBoxes(from, db);
      copyOverrides(from, db);
      copyLinks(from, db);
      copyModules(from, db);
      copyCategories(from, db);
      copyCategoryMembers(from, db);
      copyGroupings(from, db);
      seededGroupings = seedGroupings(seed, db);
      copyReviews(from, db);
      seededReviews = seedReviews(seed, db);
      copyPlays(from, db);
      copyPlayPeople(from, db);
      copyKnownHow(from, db);

      // ── The assertions. Several narrow ones, not one strong one ────────────────────────
      //
      // There is no byte-identical projection to check against the way the YAML import had:
      // relational rows have no canonical text form. So the gate is deliberately a set of
      // specific claims about specific facts, and it is WEAKER than that one. Saying so here
      // matters more than the assertions themselves — a weak gate presented as a strong one is
      // how the next reader over-trusts it.
      const got = boardGameCounts(db);
      const assert = (claim: boolean, message: string): void => {
        if (!claim) problems.push(message);
      };

      assert(got.board_games === expected.games, `board_games ${got.board_games} != ${expected.games}`);
      assert(
        got.board_game_boxes === expected.boxes,
        `board_game_boxes ${got.board_game_boxes} != ${expected.boxes}`,
      );
      assert(
        got.board_game_overrides === expected.game_overrides,
        `board_game_overrides ${got.board_game_overrides} != ${expected.game_overrides}`,
      );
      assert(
        got.board_game_links === expected.game_links,
        `board_game_links ${got.board_game_links} != ${expected.game_links}`,
      );
      assert(
        got.board_game_modules === expected.game_modules,
        `board_game_modules ${got.board_game_modules} != ${expected.game_modules}`,
      );
      assert(
        got.board_game_categories === expected.categories,
        `board_game_categories ${got.board_game_categories} != ${expected.categories}`,
      );
      assert(
        got.board_game_category_members === expected.game_categories,
        `board_game_category_members ${got.board_game_category_members} != ${expected.game_categories}`,
      );
      assert(
        got.board_game_plays === expected.plays,
        `board_game_plays ${got.board_game_plays} != ${expected.plays}`,
      );
      assert(
        got.board_game_play_people === expected.play_players,
        `board_game_play_people ${got.board_game_play_people} != ${expected.play_players}`,
      );
      assert(
        got.board_game_known_how === expected.player_known_games,
        `board_game_known_how ${got.board_game_known_how} != ${expected.player_known_games}`,
      );

      // The rule tables carry two kinds of row and only one of them came out of the source.
      const ownerGroupings = countOf(db, "board_game_groupings WHERE source = 'owner'");
      assert(
        ownerGroupings === expected.owner_groupings,
        `owner grouping rules ${ownerGroupings} != ${expected.owner_groupings}`,
      );
      assert(
        got.board_game_groupings === expected.owner_groupings + seededGroupings,
        `board_game_groupings ${got.board_game_groupings} != ${expected.owner_groupings} + ${seededGroupings}`,
      );
      const ownerReviews = countOf(db, "board_game_grouping_reviews WHERE source = 'owner'");
      assert(
        ownerReviews === expected.grouping_reviews,
        `owner grouping reviews ${ownerReviews} != ${expected.grouping_reviews}`,
      );

      // ⚠️ THE ONE THIS MIGRATION WAS SHAPED AROUND. A copy built from the source app's schema
      // FILE would have dropped `is_excluded_source`, merging the titles the owner took off the
      // shelf by hand with the ones a scheduled sync removed — and the next sync would then
      // re-offer every hand-excluded one. The count either side is the proof it survived.
      const excludedByOwner = countOf(
        db,
        "board_game_overrides WHERE is_excluded_source = 'owner'",
      );
      assert(
        excludedByOwner === ownerExcluded,
        `owner exclusions ${excludedByOwner} != ${ownerExcluded} — is_excluded_source did not survive`,
      );
      const ownerLinkRows = countOf(db, "board_game_links WHERE source = 'owner'");
      assert(
        ownerLinkRows === ownerLinks,
        `owner links ${ownerLinkRows} != ${ownerLinks}`,
      );

      // Not a count: the box→title collapse is the whole point of the app this came from, so
      // check the shape of it rather than the size.
      const multiBox = countOf(
        db,
        '(SELECT game_id FROM board_game_boxes GROUP BY game_id HAVING COUNT(*) > 1)',
      );
      const sourceMultiBox = countOf(
        from,
        '(SELECT game_id FROM boxes GROUP BY game_id HAVING COUNT(*) > 1)',
      );
      assert(
        multiBox === sourceMultiBox,
        `titles holding more than one box ${multiBox} != ${sourceMultiBox}`,
      );

      if (problems.length) {
        // Rolls the whole thing back. A half-migrated collection is worse than none: the rows
        // that landed would look authoritative.
        throw new Error(`the board-game absorb did not verify:\n  ${problems.join('\n  ')}`);
      }

      writeMeta(db, 'boardgames', 'source_fingerprint', current);
      writeMeta(db, 'boardgames', 'source_file', source);
      writeMeta(db, 'boardgames', 'seed_file', hasSeed ? seedFile : null);
      writeMeta(db, 'boardgames', 'imported_at', new Date().toISOString());
      bumpVersion(db, 'boardgames');
    });
  } catch (e) {
    if (problems.length === 0) problems.push(errMessage(e));
    return report(false, 'the board-game absorb failed and was rolled back', {
      counts: boardGameCounts(db),
      problems,
      seed: hasSeed ? seedFile : null,
      source,
    });
  } finally {
    from.close();
  }

  return report(true, force ? 'forced' : 'the collection changed', {
    counts: boardGameCounts(db),
    seed: hasSeed ? seedFile : null,
    seededGroupings,
    seededReviews,
    source,
    unresolvedPeople: unresolved(db),
  });
}

const unresolved = (db: SqliteDatabase): string[] =>
  prepareChecked<{ person_id: string }>(
    db,
    `SELECT DISTINCT person_id FROM (
       SELECT person_id FROM board_game_known_how
       UNION SELECT person_id FROM board_game_play_people
     )
     WHERE person_id NOT IN (SELECT id FROM people)
     ORDER BY person_id`,
  )
    .all()
    .map((row) => row.person_id);

// ── The twelve copies ─────────────────────────────────────────────────────────────────── //
//
// Twelve hand-written column lists, because the tables were renamed on the way across and
// `INSERT INTO x SELECT * FROM x` stopped being available. That is the cost the rename bought,
// and it is the exact shape of write that transposes two columns silently — which is why every
// one of them goes through `prepareChecked` and why the assertions above are per-table rather
// than one total.
//
// Each source table gets a declared row interface rather than an index into a `Record`. That is
// not decoration: the shape below is what `PRAGMA table_xinfo` said the LIVE database holds,
// and writing it down is what makes a column that quietly appears upstream a compile error here
// instead of a value nobody copied.
//
// `bgg_id` and `listing_bgg_id` become TEXT here. That is the only type change on the way in.

interface SourceGame {
  id: string;
  name: string;
  min_players: number;
  max_players: number;
  best_with: string;
  recommended_with: string;
  weight: number | null;
  min_playtime: number | null;
  max_playtime: number | null;
  min_age: number | null;
  interaction_types: string;
  interaction_types_source: string;
  categories: string;
  publishers: string;
  year_published: number | null;
  bgg_id: number | null;
  rating: number | null;
  source: string;
  image_path: string | null;
  created_at: string;
  updated_at: string;
}

function copyGames(from: SqliteDatabase, db: SqliteDatabase): void {
  const insert = prepareChecked(
    db,
    `INSERT INTO board_games (
       id, name, min_players, max_players, best_with, recommended_with, weight, min_playtime,
       max_playtime, min_age, interaction_types, interaction_types_source, categories,
       publishers, year_published, bgg_id, rating, source, image_path, created_at, updated_at
     ) VALUES (
       :id, :name, :min_players, :max_players, :best_with, :recommended_with, :weight,
       :min_playtime, :max_playtime, :min_age, :interaction_types, :interaction_types_source,
       :categories, :publishers, :year_published, :bgg_id, :rating, :source, :image_path,
       :created_at, :updated_at
     )`,
  );
  for (const row of from.prepare<SourceGame>('SELECT * FROM games ORDER BY id').all()) {
    insert.run({
      best_with: row.best_with,
      bgg_id: asListingId(row.bgg_id),
      categories: row.categories,
      created_at: row.created_at,
      id: row.id,
      image_path: row.image_path,
      interaction_types: row.interaction_types,
      interaction_types_source: row.interaction_types_source,
      max_players: row.max_players,
      max_playtime: row.max_playtime,
      min_age: row.min_age,
      min_players: row.min_players,
      min_playtime: row.min_playtime,
      name: row.name,
      publishers: row.publishers,
      rating: row.rating,
      recommended_with: row.recommended_with,
      source: row.source,
      updated_at: row.updated_at,
      weight: row.weight,
      year_published: row.year_published,
    });
  }
}

interface SourceBox {
  id: string;
  game_id: string;
  label: string;
  kind: string;
  bgg_id: number | null;
  homebox_entity_id: string | null;
  location_text: string | null;
  image_path: string | null;
  version_nickname: string | null;
  version_year: number | null;
  version_languages: string | null;
  created_at: string;
}

function copyBoxes(from: SqliteDatabase, db: SqliteDatabase): void {
  const insert = prepareChecked(
    db,
    `INSERT INTO board_game_boxes (
       id, game_id, label, kind, bgg_id, homebox_entity_id, location_text, image_path,
       version_nickname, version_year, version_languages, created_at
     ) VALUES (
       :id, :game_id, :label, :kind, :bgg_id, :homebox_entity_id, :location_text, :image_path,
       :version_nickname, :version_year, :version_languages, :created_at
     )`,
  );
  for (const row of from.prepare<SourceBox>('SELECT * FROM boxes ORDER BY id').all()) {
    insert.run({
      bgg_id: asListingId(row.bgg_id),
      created_at: row.created_at,
      game_id: row.game_id,
      homebox_entity_id: row.homebox_entity_id,
      id: row.id,
      image_path: row.image_path,
      // The source column has no CHECK; this one does. Anything unrecognised becomes a
      // standalone box, which is the safe direction — an expansion mis-read as standalone
      // becomes its own title and is visible, where the reverse silently hides a game.
      kind: row.kind === 'expansion' ? 'expansion' : 'standalone',
      label: row.label,
      location_text: row.location_text,
      version_languages: row.version_languages ?? '[]',
      version_nickname: row.version_nickname,
      version_year: row.version_year,
    });
  }
}

interface SourceOverride {
  game_id: string;
  min_players: number | null;
  max_players: number | null;
  best_with: string | null;
  recommended_with: string | null;
  weight: number | null;
  min_age: number | null;
  interaction_types: string | null;
  is_excluded: number | null;
  is_excluded_source: string | null;
  notes: string | null;
  image_path: string | null;
  updated_at: string;
}

function copyOverrides(from: SqliteDatabase, db: SqliteDatabase): void {
  const insert = prepareChecked(
    db,
    `INSERT INTO board_game_overrides (
       game_id, min_players, max_players, best_with, recommended_with, weight, min_age,
       interaction_types, is_excluded, is_excluded_source, notes, image_path, updated_at
     ) VALUES (
       :game_id, :min_players, :max_players, :best_with, :recommended_with, :weight, :min_age,
       :interaction_types, :is_excluded, :is_excluded_source, :notes, :image_path, :updated_at
     )`,
  );
  for (const row of from
    .prepare<SourceOverride>('SELECT * FROM game_overrides ORDER BY game_id')
    .all()) {
    insert.run({
      best_with: row.best_with,
      game_id: row.game_id,
      image_path: row.image_path,
      interaction_types: row.interaction_types,
      is_excluded: row.is_excluded == null ? null : row.is_excluded ? 1 : 0,
      // Kept verbatim. An unrecognised value fails the column CHECK and rolls the whole absorb
      // back, which is the right noise: this column is the difference between the owner taking
      // a title off the shelf and a sync removing it, and quietly nulling one hands every
      // hand-excluded title back to the next sync.
      is_excluded_source: asText(row.is_excluded_source),
      max_players: row.max_players,
      min_age: row.min_age,
      min_players: row.min_players,
      notes: row.notes,
      recommended_with: row.recommended_with,
      updated_at: row.updated_at,
      weight: row.weight,
    });
  }
}

interface SourceLink {
  id: string;
  game_id: string;
  kind: string;
  label: string;
  url: string;
  source: string;
  created_at: string;
}

function copyLinks(from: SqliteDatabase, db: SqliteDatabase): void {
  const insert = prepareChecked(
    db,
    `INSERT INTO board_game_links (id, game_id, kind, label, url, source, created_at)
     VALUES (:id, :game_id, :kind, :label, :url, :source, :created_at)`,
  );
  for (const row of from.prepare<SourceLink>('SELECT * FROM game_links ORDER BY id').all()) {
    insert.run({
      created_at: row.created_at,
      game_id: row.game_id,
      id: row.id,
      // `reference` is the escape hatch the ported type already names for anything else.
      kind: row.kind === 'rulebook' || row.kind === 'howToPlay' ? row.kind : 'reference',
      label: row.label,
      source: row.source === 'derived' ? 'derived' : 'owner',
      url: row.url,
    });
  }
}

interface SourceModule {
  id: string;
  game_id: string;
  name: string;
  source: string;
  box_id: string | null;
  created_at: string;
}

/** `is_hidden` is READ AND DISCARDED here — see `schema.sql`. It is vestigial in the source and
 * this is the one moment it can leave without an unattended `ALTER` on a live database. */
function copyModules(from: SqliteDatabase, db: SqliteDatabase): void {
  const insert = prepareChecked(
    db,
    `INSERT INTO board_game_modules (id, game_id, name, source, box_id, created_at)
     VALUES (:id, :game_id, :name, :source, :box_id, :created_at)`,
  );
  for (const row of from.prepare<SourceModule>('SELECT * FROM game_modules ORDER BY id').all()) {
    insert.run({
      box_id: row.box_id,
      created_at: row.created_at,
      game_id: row.game_id,
      id: row.id,
      name: row.name,
      source: row.source === 'derived' ? 'derived' : 'owner',
    });
  }
}

function copyCategories(from: SqliteDatabase, db: SqliteDatabase): void {
  const insert = prepareChecked(
    db,
    'INSERT INTO board_game_categories (name, created_at) VALUES (:name, :created_at)',
  );
  for (const row of from
    .prepare<{ name: string; created_at: string }>('SELECT * FROM categories ORDER BY name')
    .all()) {
    insert.run({ created_at: row.created_at, name: row.name });
  }
}

function copyCategoryMembers(from: SqliteDatabase, db: SqliteDatabase): void {
  const insert = prepareChecked(
    db,
    'INSERT INTO board_game_category_members (game_id, name) VALUES (:game_id, :name)',
  );
  for (const row of from
    .prepare<{ game_id: string; name: string }>(
      'SELECT * FROM game_categories ORDER BY game_id, name',
    )
    .all()) {
    insert.run({ game_id: row.game_id, name: row.name });
  }
}

interface SourceGrouping {
  box_label: string;
  game_id: string;
  game_name: string;
  created_at: string;
  listing_bgg_id: number | null;
}

function copyGroupings(from: SqliteDatabase, db: SqliteDatabase): void {
  const insert = prepareChecked(
    db,
    `INSERT INTO board_game_groupings (
       box_label, prefix, except_contains, game_id, game_name, listing_bgg_id,
       is_game_from_expansions, position, source, created_at
     ) VALUES (
       :box_label, NULL, NULL, :game_id, :game_name, :listing_bgg_id, 0, 0, 'owner', :created_at
     )`,
  );
  for (const row of from
    .prepare<SourceGrouping>('SELECT * FROM owner_groupings ORDER BY box_label')
    .all()) {
    insert.run({
      box_label: row.box_label,
      created_at: row.created_at,
      game_id: row.game_id,
      game_name: row.game_name,
      listing_bgg_id: asListingId(row.listing_bgg_id),
    });
  }
}

/**
 * The rules that used to be a table in the source app's code.
 *
 * `ON CONFLICT DO NOTHING` on the prefix, and it is load-bearing. The owner's own rows are
 * already in the table when this runs, and replaying the source rules against them shows the
 * two halves of this rule system ALREADY DISAGREE about a set of boxes — with the owner's rows
 * winning at read time and nothing reporting it. Seeded rows and owner rows live in different
 * columns, so a seed can never take an owner row's place even by accident; the conflict clause
 * is what makes a RE-RUN a no-op rather than a second copy of every rule.
 */
function seedGroupings(seed: GroupingSeed, db: SqliteDatabase): number {
  const rules = Array.isArray(seed.groupings) ? seed.groupings : [];
  if (rules.length === 0) return 0;

  const now = new Date().toISOString();
  const insert = prepareChecked(
    db,
    `INSERT INTO board_game_groupings (
       box_label, prefix, except_contains, game_id, game_name, listing_bgg_id,
       is_game_from_expansions, position, source, created_at
     ) VALUES (
       NULL, :prefix, :except_contains, :game_id, :game_name, :listing_bgg_id,
       :is_game_from_expansions, :position, 'migration', :created_at
     )
     ON CONFLICT DO NOTHING`,
  );

  let written = 0;
  rules.forEach((rule, position) => {
    const result = insert.run({
      created_at: now,
      except_contains: asText(rule.except_contains),
      game_id: String(rule.game_id).trim(),
      game_name: String(rule.game_name).trim(),
      is_game_from_expansions: asFlag(rule.is_game_from_expansions),
      listing_bgg_id: asListingId(rule.listing_bgg_id),
      // The file's own order IS the answer where two prefixes could both match.
      position,
      prefix: String(rule.prefix).trim(),
    });
    written += result.changes;
  });
  return written;
}

interface SourceReview {
  box_label: string;
  game_id: string | null;
  parent_game_id: string | null;
  status: string;
  reason: string | null;
  reviewed_at: string | null;
}

function copyReviews(from: SqliteDatabase, db: SqliteDatabase): void {
  const insert = prepareChecked(
    db,
    `INSERT INTO board_game_grouping_reviews
       (box_label, game_id, parent_game_id, status, reason, reviewed_at, source)
     VALUES (:box_label, :game_id, :parent_game_id, :status, :reason, :reviewed_at, 'owner')`,
  );
  for (const row of from
    .prepare<SourceReview>('SELECT * FROM grouping_reviews ORDER BY box_label')
    .all()) {
    insert.run({
      box_label: row.box_label,
      game_id: row.game_id,
      parent_game_id: row.parent_game_id,
      reason: row.reason,
      reviewed_at: row.reviewed_at,
      status: row.status,
    });
  }
}

/**
 * The "yes, that really is its own title" answers, which were a `Set` of literals in source.
 *
 * ⚠️ THE SKIP IS DONE IN CODE, NOT BY `ON CONFLICT`, and the difference is the whole safety of
 * this function. An owner's row is keyed on the RAW label off the lid; a seeded row is keyed on
 * the COMPARISON FORM, because that is what the grouping pass matched on. Those two strings are
 * not equal for the same box, so a primary-key conflict clause would never fire and the seed
 * would answer a question the owner has deliberately left open. Comparing the normalised form
 * of both is what actually asks "has this already been answered here?".
 *
 * The source app's own comment already said these two were the same ruling made by two
 * different hands. This is the line that makes the owner's hand win.
 */
function seedReviews(seed: GroupingSeed, db: SqliteDatabase): number {
  const reviews = Array.isArray(seed.reviews) ? seed.reviews : [];
  if (reviews.length === 0) return 0;

  const answered = new Set(
    prepareChecked<{ box_label: string }>(
      db,
      'SELECT box_label FROM board_game_grouping_reviews',
    )
      .all()
      .map((row) => normalizeTitle(row.box_label)),
  );

  const now = new Date().toISOString();
  const insert = prepareChecked(
    db,
    `INSERT INTO board_game_grouping_reviews
       (box_label, game_id, parent_game_id, status, reason, reviewed_at, source)
     VALUES (:box_label, NULL, NULL, 'confirmedSeparate', :reason, :reviewed_at, 'migration')
     ON CONFLICT DO NOTHING`,
  );

  let written = 0;
  for (const review of reviews) {
    const label = normalizeTitle(String(review.box_label));
    if (label === '' || answered.has(label)) continue;
    answered.add(label);
    const result = insert.run({
      box_label: label,
      reason: asText(review.reason),
      // A row with a `reviewed_at` is answered and is never asked again. These were answered
      // when they were written into the source; the absorb is when they became a row.
      reviewed_at: asText(review.reviewed_at) ?? now,
    });
    written += result.changes;
  }
  return written;
}

interface SourcePlay {
  id: string;
  game_id: string;
  played_at: string;
  notes: string | null;
}

function copyPlays(from: SqliteDatabase, db: SqliteDatabase): void {
  const insert = prepareChecked(
    db,
    `INSERT INTO board_game_plays (id, game_id, played_at, notes)
     VALUES (:id, :game_id, :played_at, :notes)`,
  );
  for (const row of from.prepare<SourcePlay>('SELECT * FROM plays ORDER BY played_at, id').all()) {
    insert.run({
      game_id: row.game_id,
      id: row.id,
      notes: row.notes,
      played_at: row.played_at,
    });
  }
}

/**
 * The source app's player id, or the person it has already become.
 *
 * Both orders converge. Absorb first and the ids sit here unresolved until the confirmed people
 * apply re-keys them; confirm first and this finds the person through `people.source_id` and
 * writes the right id straight away.
 */
function personIdFor(db: SqliteDatabase, playerId: string): string {
  const row = prepareChecked<{ id: string }>(
    db,
    "SELECT id FROM people WHERE source = 'board-game-picker' AND source_id = :source_id",
  ).get({ source_id: playerId });
  return row?.id ?? playerId;
}

function copyPlayPeople(from: SqliteDatabase, db: SqliteDatabase): void {
  const insert = prepareChecked(
    db,
    `INSERT INTO board_game_play_people (play_id, person_id) VALUES (:play_id, :person_id)
     ON CONFLICT DO NOTHING`,
  );
  for (const row of from
    .prepare<{ play_id: string; player_id: string }>(
      'SELECT * FROM play_players ORDER BY play_id, player_id',
    )
    .all()) {
    insert.run({ person_id: personIdFor(db, row.player_id), play_id: row.play_id });
  }
}

function copyKnownHow(from: SqliteDatabase, db: SqliteDatabase): void {
  const insert = prepareChecked(
    db,
    `INSERT INTO board_game_known_how (person_id, game_id, confirmed_at)
     VALUES (:person_id, :game_id, :confirmed_at)
     ON CONFLICT (person_id, game_id) DO UPDATE SET
       confirmed_at = MAX(board_game_known_how.confirmed_at, excluded.confirmed_at)`,
  );
  for (const row of from
    .prepare<{ player_id: string; game_id: string; confirmed_at: string }>(
      'SELECT * FROM player_known_games ORDER BY player_id, game_id',
    )
    .all()) {
    insert.run({
      // A play may RENEW a claim and must never invent one, so where two source players resolve
      // to one human the FRESHER timestamp survives rather than the last one read.
      confirmed_at: row.confirmed_at,
      game_id: row.game_id,
      person_id: personIdFor(db, row.player_id),
    });
  }
}

// ── The boot hook ─────────────────────────────────────────────────────────────────────── //

let lastStamp: string | null = null;

/**
 * Called at START. Cheap: two `stat`s, and it returns before anything opens the database when
 * there is no collection file — which is every CI runner and every offline harness.
 *
 * Skipped under `STORE_BACKEND=yaml`, which has no board-game tables to write to.
 */
export function ensureBoardGamesImported(): BoardGameImportReport {
  if (STORE_BACKEND === 'yaml') {
    return report(false, 'STORE_BACKEND=yaml has no board-game store');
  }

  const stamp = inputStamp();
  if (stamp === lastStamp) {
    return report(false, 'the collection has not moved since the last check');
  }
  lastStamp = stamp;

  // Once retired, the only input still read is the seed — see the file header for why the two
  // are not the same kind of thing. This branch is what the live system takes on every start
  // after the WP-4d deploy, so it must not open the source file or even ask whether it exists.
  if (isBoardGameSourceRetired()) {
    const seeded = seedGroupingRules();
    if (seeded.seededGroupings || seeded.seededReviews) {
      console.log(
        `[boardgames] the collection is this app’s own; the seed added ` +
          `${seeded.seededGroupings} grouping rule(s) and ${seeded.seededReviews} review answer(s)`,
      );
    }
    return report(false, 'the collection is this app’s own — the source file is retired', {
      counts: boardGameCounts(bookOfRecord()),
      seededGroupings: seeded.seededGroupings,
      seededReviews: seeded.seededReviews,
    });
  }

  if (!existsSync(sourcePath())) return report(false, 'no board-game collection to import');

  const result = importBoardGames();

  if (result.imported) {
    console.log(
      `[boardgames] absorbed ${result.counts.board_games} title(s) in ` +
        `${result.counts.board_game_boxes} box(es), ${result.counts.board_game_groupings} grouping ` +
        `rule(s) (${result.seededGroupings} seeded), ${result.counts.board_game_plays} play(s), ` +
        `${result.counts.board_game_known_how} known-how claim(s) — from ${result.source}`,
    );
    if (result.unresolvedPeople.length) {
      console.log(
        `[boardgames] ${result.unresolvedPeople.length} person id(s) are not resolved yet — ` +
          'they are re-keyed by the confirmed people import',
      );
    }
  } else if (result.problems.length) {
    console.log(`[boardgames] ${result.reason}:`);
    for (const problem of result.problems) console.log(`[boardgames]   - ${problem}`);
    // A rolled-back absorb left the tables as they were. Retiring now would freeze a collection
    // nobody meant to keep, so the door stays open for the start that fixes the input.
    return result;
  }

  // ── The cutover ─────────────────────────────────────────────────────────────────────── //
  //
  // The store holds a collection, and as of WP-4d this app is what writes it. Close the door
  // BEFORE the first sync can run: the hazard is not a slow leak, it is one restart between a
  // sync and a fingerprint change erasing everything the sync wrote.
  //
  // Guarded on there being rows at all, so a container whose absorb found an empty source file
  // does not latch itself out of ever receiving a real one.
  const db = bookOfRecord();
  if (!isBoardGameSourceRetired(db) && boardGameCounts(db).board_games > 0) {
    const { movedTo } = retireBoardGameSource(db);
    console.log(
      '[boardgames] the collection is now this app’s own — the source file is retired and ' +
        'will not be read again' +
        (movedTo === null ? '' : `; moved aside to ${movedTo}`),
    );
    // The seed keeps working after the door shuts, and this is the start that proves it.
    seedGroupingRules();
  }

  return result;
}

/** For tests: forget what this process has already looked at. */
export function resetBoardGameImportState(): void {
  lastStamp = null;
}
