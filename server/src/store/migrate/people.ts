// THE PEOPLE IMPORT — Board Game Picker's `players` and `group_players` into the book of
// record, through a mapping file the OWNER confirms.
//
// ── Why there is a file in the middle at all ─────────────────────────────────────────────
//
// Board Game Picker knows a player by display name. QueuePilot knows the same human by a Plex
// account and a Kavita account that spell him differently, sitting inside a group whose label
// is a third spelling. Those three strings do not match each other, and the pair that matters
// most does not even share a letter.
//
// A name-matching heuristic therefore has to guess, and the thing it guesses wrong is
// `player_known_games` — "this person can sit down and play this without opening the
// rulebook". That is a per-person claim a play may RENEW and must never INVENT (board-games
// 2026-08-17-knowing-the-rules-is-a-per-person-fact-not-a-play-count). Writing it against the
// wrong person is silent, is not visible on any screen, and comes back as a picker that hides
// a game somebody would swear they know.
//
// So: IDENTITY MATCH IS MANUAL. A tool proposes, a human confirms, and this file refuses to
// write a row until it sees `confirmed: true`. Migrating people on an unconfirmed guess is
// worse than not migrating them at all — the second is a job still to do, the first is a
// corruption nobody notices.
//
// ── The gate, precisely ──────────────────────────────────────────────────────────────────
//
//   * No mapping file            → nothing happens, no log, no database opened.
//   * A file with no `confirmed` → logged ONCE per fingerprint, nothing written.
//   * `confirmed: true` but the file does not validate → logged with every problem, and
//     NOTHING is written. There is no partial import: a file that is half right is a file the
//     owner has to look at, not half a household.
//   * Valid and confirmed        → one transaction, then the fingerprint is recorded so the
//     next start is a no-op.
//
// ── What it writes, and what it leaves alone ─────────────────────────────────────────────
//
// The file OWNS the rows it names and nothing else. A person in the file is upserted; a person
// in the database the file has never heard of is untouched, because the file is a migration
// record and not a roster. Same for a group's people list. That is what makes re-running it
// safe after somebody has added a person by hand.
//
// `unmatched:` is DOCUMENTATION. It is never read, never imported, and exists so the proposal
// can say "I could not tell" in the same file rather than dropping the question on the floor.
// Moving a block out of `unmatched:` and into `people:` or `groups:` is how the owner answers.
//
// ── Personal data ────────────────────────────────────────────────────────────────────────
//
// The mapping FILE lives in `/config` beside the store and holds real names. This module is
// code and holds none; the committed example is `people-mapping.example.yaml` and its cast is
// Ada, Grace and Linus.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

import { QUEUES_PATH, STORE_BACKEND } from '../../config.js';
import { errMessage } from '../../errors.js';
import type { ProfileAccounts } from '../../groups.js';
import { normalizeAccounts } from '../../people.js';
import { rekeyBoardGamePerson } from '../db/boardgames.js';
import { bookOfRecord, prepareChecked } from '../db/open.js';
import {
  bumpPeopleVersion,
  readPeopleMeta,
  setGroupPeople,
  upsertPerson,
  writePeopleMeta,
} from '../db/people.js';
import { ensureImported } from './yaml.js';

/** The confidence a proposal carries. Only the owner's edit turns a `low` into a decision. */
export type MappingConfidence = 'high' | 'medium' | 'low';

/** One person as the mapping file spells them. Snake_case because a human types this file. */
export interface MappingPerson {
  id: string;
  display_name?: string;
  /** The `players.id` this person came from, so a re-run updates rather than duplicates. */
  board_game_picker_id?: string | null;
  accounts?: Record<string, string[]>;
  birth_year?: number | null;
  max_weight?: number | null;
  is_beginner?: boolean;
  evidence?: string[];
  confidence?: MappingConfidence;
}

/** One group's roster. `id` is an EXISTING QueuePilot group's wire id — this file never
 * invents a `/g/<id>` URL, because a wire id is a promise and creating one is the owner's. */
export interface MappingGroup {
  id: string;
  /** For the reader only. The group's real label is in the groups store and is not rewritten. */
  label?: string;
  people: string[];
  evidence?: string[];
  confidence?: MappingConfidence;
}

export interface PeopleMapping {
  /** ABSENT BY DEFAULT. The whole gate. */
  confirmed?: boolean;
  version?: number;
  people?: MappingPerson[];
  groups?: MappingGroup[];
  /** Documentation only — never read by the import. */
  unmatched?: unknown;
}

export interface PeopleImportReport {
  imported: boolean;
  reason: string;
  /** Where the mapping was read from, or null when there was none. */
  file: string | null;
  personIds: string[];
  groupIds: string[];
  accountCount: number;
  rosterCount: number;
  /** How many board-game rows were re-keyed off a source player id onto a person. */
  rekeyedBoardGameRows: number;
  /** Every validation failure, in the order found. Non-empty means nothing was written. */
  problems: string[];
}

const EMPTY = {
  accountCount: 0,
  groupIds: [] as string[],
  personIds: [] as string[],
  problems: [] as string[],
  rekeyedBoardGameRows: 0,
  rosterCount: 0,
};

/** An id that is safe in a URL and readable in one. Same shape `groups.slugify()` produces. */
const ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Where the mapping file may be, most specific first.
 *
 * Two default names, on purpose. The tool writes `people-mapping-proposal.yaml`, and the whole
 * confirmation step is meant to be ONE edit — uncomment `confirmed: true` — rather than an
 * edit plus a rename that is a second chance to get it wrong. `people-mapping.yaml` wins when
 * both are present, so renaming it is still allowed and still means what it looks like.
 *
 * Derived from `QUEUES_PATH` rather than hard-coded to `/config`, so every offline harness
 * that points the four YAML paths at a scratch directory gets its own mapping file for free.
 */
export function mappingCandidates(): string[] {
  const explicit = process.env.PEOPLE_MAPPING_PATH;
  if (explicit) return [explicit];
  const dir = dirname(QUEUES_PATH);
  return [join(dir, 'people-mapping.yaml'), join(dir, 'people-mapping-proposal.yaml')];
}

/** The first candidate that exists, or null. */
export const mappingPath = (): string | null =>
  mappingCandidates().find((candidate) => existsSync(candidate)) ?? null;

/** `(mtimeMs, size)` for the candidates — the cheap gate, so a start does not hash. */
function sourceStamp(): string {
  return mappingCandidates()
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

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asStringList = (value: unknown): string[] =>
  asList(value).map((item) => String(item ?? '').trim()).filter(Boolean);

/**
 * Read and check a mapping. Returns the problems rather than throwing, so the caller can log
 * every one of them at once — a file with four typos should take one round trip, not four.
 *
 * `knownGroupIds` is passed in rather than read here so the checker is pure and a test can
 * drive it without a database.
 */
export function validateMapping(
  raw: unknown,
  knownGroupIds: ReadonlySet<string>,
): { mapping: PeopleMapping; problems: string[] } {
  const problems: string[] = [];
  const mapping = (raw && typeof raw === 'object' ? raw : {}) as PeopleMapping;

  if (mapping.version !== 1) {
    problems.push(`version must be 1, found ${JSON.stringify(mapping.version ?? null)}`);
  }

  const people = asList(mapping.people) as MappingPerson[];
  const seenIds = new Set<string>();
  const seenSourceIds = new Map<string, string>();

  if (people.length === 0) problems.push('`people:` is empty — there is nothing to import');

  for (const [index, person] of people.entries()) {
    const id = String(person?.id ?? '').trim();
    const where = `people[${index}]${id ? ` '${id}'` : ''}`;
    if (!id) {
      problems.push(`${where} has no id`);
      continue;
    }
    if (!ID_SHAPE.test(id)) {
      problems.push(`${where}: an id is lower-case letters, digits and hyphens — it is a URL`);
    }
    if (seenIds.has(id)) problems.push(`${where}: duplicate id`);
    seenIds.add(id);

    const sourceId = person.board_game_picker_id;
    if (sourceId != null && String(sourceId).trim() !== '') {
      const key = String(sourceId).trim();
      const owner = seenSourceIds.get(key);
      // The one check that catches the mistake this whole file exists to prevent: two people
      // claiming the SAME Board Game Picker player is a merge nobody asked for, and it takes
      // that player's known-how with it.
      if (owner) problems.push(`${where}: board_game_picker_id is already claimed by '${owner}'`);
      seenSourceIds.set(key, id);
    }

    if (person.birth_year != null && !Number.isInteger(person.birth_year)) {
      problems.push(`${where}: birth_year must be a whole year`);
    }
    if (
      person.max_weight != null &&
      (typeof person.max_weight !== 'number' || person.max_weight <= 0 || person.max_weight > 5)
    ) {
      problems.push(`${where}: max_weight is BoardGameGeek's 1–5 scale`);
    }
    if (person.is_beginner != null && typeof person.is_beginner !== 'boolean') {
      problems.push(`${where}: is_beginner must be true or false`);
    }
  }

  for (const [index, group] of (asList(mapping.groups) as MappingGroup[]).entries()) {
    const id = String(group?.id ?? '').trim();
    const where = `groups[${index}]${id ? ` '${id}'` : ''}`;
    if (!id) {
      problems.push(`${where} has no id`);
      continue;
    }
    // A group id is a wire id and a bookmarked URL. This file attaches people to one that
    // already exists; it never creates one, so an unknown id is a typo and not a request.
    if (!knownGroupIds.has(id)) {
      problems.push(`${where}: no such group — this file attaches people to existing groups only`);
    }
    for (const personId of asStringList(group.people)) {
      if (!seenIds.has(personId)) {
        problems.push(`${where}: names '${personId}', who is not in \`people:\``);
      }
    }
  }

  return { mapping, problems };
}

const groupIdsInStore = (): Set<string> => {
  ensureImported();
  return new Set(
    prepareChecked<{ id: string }>(bookOfRecord(), 'SELECT id FROM groups').all().map((row) => row.id),
  );
};

const report = (
  imported: boolean,
  reason: string,
  file: string | null,
  extra: Partial<PeopleImportReport> = {},
): PeopleImportReport => ({ ...EMPTY, file, imported, reason, ...extra });

/**
 * Run the import if the mapping file allows it. Returns what it did, either way.
 *
 * `force` skips the fingerprint check — a deliberate re-run — but never the confirmation gate
 * or the validation. There is no flag that writes an unconfirmed mapping, on purpose.
 */
export function importPeople({ force = false }: { force?: boolean } = {}): PeopleImportReport {
  const file = mappingPath();
  if (!file) return report(false, 'no people-mapping file', null);

  let raw: unknown;
  const text = readFileSync(file, 'utf8');
  try {
    raw = parse(text);
  } catch (e) {
    return report(false, `the mapping file is not valid YAML: ${errMessage(e)}`, file, {
      problems: [errMessage(e)],
    });
  }

  const fingerprint = createHash('sha256').update(text).digest('hex');

  // THE GATE. Checked before the fingerprint, so an unconfirmed file says the same thing every
  // time it is asked rather than going quiet after the first look.
  if ((raw as PeopleMapping)?.confirmed !== true) {
    return report(false, `waiting for \`confirmed: true\` in ${file}`, file);
  }

  const db = bookOfRecord();
  if (!force && readPeopleMeta('mapping_fingerprint', db) === fingerprint) {
    return report(false, 'the mapping has not changed since the last import', file);
  }

  const { mapping, problems } = validateMapping(raw, groupIdsInStore());
  if (problems.length) {
    return report(false, `the mapping does not validate — nothing was written`, file, { problems });
  }

  const people = asList(mapping.people) as MappingPerson[];
  const groups = asList(mapping.groups) as MappingGroup[];
  let accountCount = 0;
  let rosterCount = 0;
  let rekeyedBoardGameRows = 0;

  db.withTransaction(() => {
    people.forEach((person, position) => {
      const accounts: ProfileAccounts = normalizeAccounts(person.accounts ?? {});
      accountCount += Object.values(accounts).reduce((sum, names) => sum + names.length, 0);
      upsertPerson(
        {
          accounts,
          birthYear: person.birth_year ?? null,
          createdAt: new Date().toISOString(),
          displayName: String(person.display_name ?? person.id).trim() || person.id,
          id: person.id,
          isBeginner: person.is_beginner === true,
          maxWeight: person.max_weight ?? null,
          position,
          source: person.board_game_picker_id ? 'board-game-picker' : null,
          sourceId: person.board_game_picker_id ? String(person.board_game_picker_id) : null,
        },
        db,
      );

      // ── THE BOARD-GAME RE-KEY (WP-4b) ──────────────────────────────────────────────────
      //
      // The collection absorb ran before this and could not name a person: `people` was empty,
      // because it is gated on the very file being read right now. So its two people-keyed
      // tables hold the SOURCE APP'S own player ids, verbatim, and this is where they become
      // this app's ids — inside the same transaction as the person they belong to, behind the
      // same `confirmed: true`, and with no second gate to keep true.
      //
      // `board_game_known_how` is the record that actually matters here. Losing or
      // mis-attributing one of those rows is worse than losing a play: it is a claim a person
      // STATED, a play may renew it and must never invent it, and it appears on no screen
      // attached to a name — so a wrong one is never noticed. That is the whole reason this
      // import refuses to guess.
      if (person.board_game_picker_id) {
        rekeyedBoardGameRows += rekeyBoardGamePerson(
          String(person.board_game_picker_id).trim(),
          person.id,
          db,
        );
      }
    });

    for (const group of groups) {
      const roster = asStringList(group.people);
      setGroupPeople(group.id, roster, db);
      rosterCount += roster.length;
    }

    writePeopleMeta('mapping_fingerprint', fingerprint, db);
    writePeopleMeta('mapping_file', file, db);
    writePeopleMeta('imported_at', new Date().toISOString(), db);
    bumpPeopleVersion(db);
  });

  return report(true, force ? 'forced' : 'the mapping changed', file, {
    accountCount,
    groupIds: groups.map((group) => group.id),
    personIds: people.map((person) => person.id),
    rekeyedBoardGameRows,
    rosterCount,
  });
}

let lastStamp: string | null = null;
let saidWaiting = false;

/**
 * The boot hook. Cheap: it `stat`s the two candidate paths and returns before anything opens
 * the database when there is no mapping file — which is every CI runner and every e2e harness.
 *
 * ⚠️ Called at START. Safe to call again — the `(mtimeMs, size)` stamp makes a repeat call two
 * `stat`s — but nothing watches the file, so confirming the mapping takes effect on the app's
 * next restart. The file's own header says that out loud, so nobody edits it and then waits
 * for something to happen.
 *
 * Skipped entirely under `STORE_BACKEND=yaml`. That backend has no `people` table to write to
 * and an empty `groups` table to validate against, so every group id in the mapping would look
 * like a typo.
 */
export function ensurePeopleImported(): PeopleImportReport {
  if (STORE_BACKEND === 'yaml') {
    return report(false, 'STORE_BACKEND=yaml has no people store', null);
  }
  const stamp = sourceStamp();
  if (stamp === lastStamp) {
    return report(false, 'the mapping file has not moved since the last check', mappingPath());
  }
  lastStamp = stamp;
  if (!mappingPath()) return report(false, 'no people-mapping file', null);

  const result = importPeople();

  if (result.imported) {
    console.log(
      `[people] imported ${result.personIds.length} person(s), ${result.accountCount} account(s), ` +
        `${result.rosterCount} roster place(s) across ${result.groupIds.length} group(s), ` +
        `${result.rekeyedBoardGameRows} board-game row(s) re-keyed — from ${result.file}`,
    );
  } else if (result.problems.length) {
    console.log(`[people] ${result.reason}:`);
    for (const problem of result.problems) console.log(`[people]   - ${problem}`);
  } else if (result.reason.startsWith('waiting') && !saidWaiting) {
    saidWaiting = true;
    console.log(`[people] ${result.reason}`);
  }

  return result;
}

/** For tests: forget what this process has already looked at. */
export function resetPeopleImportState(): void {
  lastStamp = null;
  saidWaiting = false;
}
