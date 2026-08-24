// MIGRATION CLI — propose the people mapping, and import a confirmed one.
//
//     server/node_modules/.bin/tsx server/src/tools/people-mapping.ts propose [options]
//
//       --bgp <file>      a Board Game Picker SQLite database to read `players`, `groups` and
//                         `group_players` from. Opened READ-ONLY. Point it at a snapshot, not
//                         at a database whose app is running.
//       --groups <file>   a `groups.yaml` to read QueuePilot's groups from. Parsed directly,
//                         so this touches no store and creates no database.
//       --out <path>      where to write the proposal (default: the first mapping candidate
//                         beside `$QUEUES_PATH`).
//       --write           actually write it. Without this the proposal is printed and nothing
//                         is written.
//
//     server/node_modules/.bin/tsx server/src/tools/people-mapping.ts import [--apply] [--force]
//
//       --apply           write the rows. Without it this is a dry run that validates the file
//                         and prints exactly what would be written.
//       --force           re-import a mapping whose fingerprint is already recorded.
//
// PRINT-FIRST, like `migrate-entry-objects.ts`: the dry run is the default in both
// subcommands, and neither writes anything the other did not print first.
//
// ── The rule this tool exists to keep ────────────────────────────────────────────────────
//
// IT PROPOSES. IT DOES NOT DECIDE. Every match below is an EXACT, case-insensitive string
// equality between a Board Game Picker display name (or its first word) and either a
// QueuePilot group's label or one of that group's provider account names. There is no edit
// distance, no substring, no nickname table and there must never be one. A player with no
// exact match becomes a NEW person and is merged into nobody, which is the direction that
// costs nothing to undo; a player or a group with more than one candidate goes to
// `unmatched:`, because two matches is less certain than none.
//
// The generated file is a PROPOSAL and cannot import itself: `confirmed:` is written
// commented out, and `store/migrate/people.ts` refuses every file that does not carry it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
// `node:sqlite` directly rather than `store/sqlite.ts`: this reads a FOREIGN database and must
// open it READ-ONLY, which the shim has no option for and does not need one for — everything
// it opens is ours. Rows are spread on the way out for the same reason the shim spreads them
// (driver difference #1: node:sqlite hands back null-prototype objects).
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'yaml';

import { errMessage } from '../errors.js';
import { slugify, uniqueId } from '../people.js';
import type { ProfileAccounts } from '../groups.js';
import { store } from '../store/index.js';
import {
  importPeople,
  mappingCandidates,
  mappingPath,
  validateMapping,
} from '../store/migrate/people.js';

interface BgpPlayer {
  id: string;
  display_name: string;
  birth_year: number | null;
  max_weight: number | null;
  is_beginner: number;
}

interface QueuePilotGroup {
  id: string;
  label: string;
  accounts: ProfileAccounts;
}

/** One proposed match, with the reason it was proposed. `evidence` is what a human checks. */
interface Proposal {
  player: BgpPlayer;
  personId: string;
  displayName: string;
  group: QueuePilotGroup | null;
  accounts: ProfileAccounts;
  evidence: string[];
  confidence: 'high' | 'medium' | 'low';
}

const argFor = (argv: readonly string[], name: string): string | null => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] != null ? String(argv[index + 1]) : null;
};

const norm = (value: unknown): string => String(value ?? '').trim().toLowerCase();

/** The YAML scalar form the proposal writes: quoted only when it has to be. */
const scalar = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(text) ? text : JSON.stringify(text);
};

// ── reading the two sides ─────────────────────────────────────────────────────────────── //

function readBgp(file: string): {
  players: BgpPlayer[];
  groups: { id: string; name: string }[];
  members: Map<string, string[]>;
  knownByPlayer: Map<string, number>;
  knownCount: number;
} {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const players = (
      db
        .prepare(
          'SELECT id, display_name, birth_year, max_weight, is_beginner FROM players ORDER BY created_at, id',
        )
        .all() as unknown as BgpPlayer[]
    ).map((row) => ({ ...row }));
    const groups = (
      db.prepare('SELECT id, name FROM groups ORDER BY created_at, id').all() as unknown as {
        id: string;
        name: string;
      }[]
    ).map((row) => ({ ...row }));
    const members = new Map<string, string[]>();
    for (const row of db.prepare('SELECT group_id, player_id FROM group_players').all() as unknown as {
      group_id: string;
      player_id: string;
    }[]) {
      members.set(row.group_id, [...(members.get(row.group_id) ?? []), row.player_id]);
    }
    // Per player, because this is the number that says which matches actually carry weight. A
    // play row a wrong match corrupts is two rows of history; a known-how claim on the wrong
    // human makes the picker offer a game nobody at the table can teach.
    const knownByPlayer = new Map<string, number>();
    for (const row of db
      .prepare('SELECT player_id, COUNT(*) AS n FROM player_known_games GROUP BY player_id')
      .all() as unknown as { player_id: string; n: number }[]) {
      knownByPlayer.set(row.player_id, Number(row.n));
    }
    const knownCount = [...knownByPlayer.values()].reduce((sum, n) => sum + n, 0);
    return { groups, knownByPlayer, knownCount, members, players };
  } finally {
    db.close();
  }
}

/** QueuePilot's groups, parsed straight out of a `groups.yaml`. No store, no database. */
function readQueuePilotGroups(file: string): QueuePilotGroup[] {
  const parsed = parse(readFileSync(file, 'utf8')) as { groups?: unknown } | null;
  const listed = Array.isArray(parsed?.groups) ? parsed.groups : [];
  return listed
    .map((raw) => {
      const group = (raw ?? {}) as Record<string, unknown>;
      const id = String(group.id ?? '').trim();
      if (!id) return null;
      const accounts: ProfileAccounts = {};
      for (const [kind, value] of Object.entries((group.accounts ?? {}) as Record<string, unknown>)) {
        const names = (Array.isArray(value) ? value : [value]).map((n) => String(n ?? '').trim());
        if (names.filter(Boolean).length) accounts[norm(kind)] = names.filter(Boolean);
      }
      return { accounts, id, label: String(group.label ?? id).trim() || id };
    })
    .filter((group): group is QueuePilotGroup => group !== null);
}

// ── the proposal ──────────────────────────────────────────────────────────────────────── //

/**
 * Every EXACT reason a group and a player might be the same human. An empty list is the
 * answer for most pairs and is not a problem — it means nothing is being merged.
 */
function evidenceFor(player: BgpPlayer, group: QueuePilotGroup): string[] {
  const full = norm(player.display_name);
  const given = norm(String(player.display_name).split(/\s+/)[0] ?? '');
  const found: string[] = [];

  if (norm(group.label) === full) found.push(`the group label is this player's full name`);
  else if (given && norm(group.label) === given) {
    found.push(`the group label is this player's given name`);
  }

  for (const [kind, names] of Object.entries(group.accounts)) {
    for (const name of names) {
      if (norm(name) === full) found.push(`the group's ${kind} account is this player's full name`);
      else if (given && norm(name) === given) {
        found.push(`the group's ${kind} account is this player's given name`);
      }
    }
  }
  return found;
}

function buildProposals(
  players: readonly BgpPlayer[],
  groups: readonly QueuePilotGroup[],
): { proposals: Proposal[]; ambiguous: { player: BgpPlayer; candidates: string[] }[] } {
  // Two passes, because ambiguity runs in both directions: a player matching two groups is as
  // uncertain as a group matching two players, and either one must stop the match rather than
  // pick a winner.
  const matches = new Map<string, { group: QueuePilotGroup; evidence: string[] }[]>();
  const claimedBy = new Map<string, string[]>();

  for (const player of players) {
    const found: { group: QueuePilotGroup; evidence: string[] }[] = [];
    for (const group of groups) {
      const evidence = evidenceFor(player, group);
      if (evidence.length) {
        found.push({ evidence, group });
        claimedBy.set(group.id, [...(claimedBy.get(group.id) ?? []), player.id]);
      }
    }
    matches.set(player.id, found);
  }

  const proposals: Proposal[] = [];
  const ambiguous: { player: BgpPlayer; candidates: string[] }[] = [];
  const taken = new Set<string>();

  for (const player of players) {
    const found = matches.get(player.id) ?? [];
    const contested = found.filter((match) => (claimedBy.get(match.group.id) ?? []).length > 1);

    if (found.length > 1 || contested.length > 0) {
      ambiguous.push({ candidates: found.map((match) => match.group.id), player });
      continue;
    }

    const match = found[0] ?? null;
    const displayName = match ? match.group.label : player.display_name;
    const personId = uniqueId(
      slugify(String(player.display_name).split(/\s+/)[0] ?? player.display_name) ||
        slugify(player.display_name),
      taken,
    );
    taken.add(personId);

    proposals.push({
      accounts: match ? match.group.accounts : {},
      confidence: !match ? 'high' : match.evidence.length > 1 ? 'high' : 'medium',
      displayName,
      evidence: match
        ? match.evidence
        : ['no QueuePilot group names this player, so nothing is being merged'],
      group: match?.group ?? null,
      personId,
      player,
    });
  }

  return { ambiguous, proposals };
}

function renderProposal(
  proposals: readonly Proposal[],
  ambiguous: readonly { player: BgpPlayer; candidates: string[] }[],
  groups: readonly QueuePilotGroup[],
  bgp: ReturnType<typeof readBgp>,
  sources: { bgpFile: string; groupsFile: string },
): string {
  const byPlayerId = new Map(proposals.map((proposal) => [proposal.player.id, proposal]));
  const matchedGroupIds = new Set(
    proposals.map((proposal) => proposal.group?.id).filter((id): id is string => Boolean(id)),
  );
  const everyPersonId = proposals.map((proposal) => proposal.personId);
  const out: string[] = [];

  out.push('# QueuePilot — people mapping. GENERATED PROPOSAL; nothing is imported until it is');
  out.push('# confirmed. Read it, fix it, then uncomment the `confirmed: true` line below.');
  out.push('#');
  out.push('# Every match here is an EXACT, case-insensitive equality between a Board Game');
  out.push("# Picker display name (or its first word) and a QueuePilot group's label or one of");
  out.push('# its provider account names. Nothing was matched by resemblance. A player with no');
  out.push('# exact match is proposed as a NEW person and is merged into nobody; anything with');
  out.push('# two candidates is in `unmatched:` rather than guessed into place.');
  out.push('#');
  out.push('# `confidence` is about the IDENTITY CLAIM, not about the data. A player who becomes');
  out.push('# a brand-new person claims nothing and is `high`; a player merged into an existing');
  out.push('# group is `high` only when two independent things matched, and `medium` on one.');
  out.push('#');
  out.push(`# Sources: ${sources.bgpFile}`);
  out.push(`#          ${sources.groupsFile}`);
  out.push(
    `# Read: ${bgp.players.length} player(s), ${bgp.groups.length} group(s), ` +
      `${[...bgp.members.values()].reduce((sum, list) => sum + list.length, 0)} group member(s), ` +
      `${bgp.knownCount} known-how claim(s).`,
  );
  out.push('#');
  out.push('# ⚠️ `player_known_games` is the record that matters. The play log is nearly empty, so');
  out.push('#    a wrong match costs a couple of play rows; a wrong match on a known-how claim');
  out.push('#    says somebody knows a game they do not, and no screen shows that. Each person');
  out.push('#    below carries `known_how_claims:` — CHECK THE NON-ZERO ONES FIRST. It is read');
  out.push('#    only and the import ignores it.');
  out.push('#');
  out.push('# After confirming, the app imports this the NEXT TIME IT STARTS. Nothing watches');
  out.push('# the file. To do it by hand and see the report first:');
  out.push('#   server/node_modules/.bin/tsx server/src/tools/people-mapping.ts import');
  out.push('#   server/node_modules/.bin/tsx server/src/tools/people-mapping.ts import --apply');
  out.push('');
  out.push('# confirmed: true');
  out.push('');
  out.push('version: 1');
  out.push('');
  out.push('people:');

  for (const proposal of proposals) {
    out.push(`- id: ${proposal.personId}`);
    out.push(`  display_name: ${scalar(proposal.displayName)}`);
    out.push(`  board_game_picker_id: ${scalar(proposal.player.id)}`);
    const accountKinds = Object.entries(proposal.accounts);
    if (accountKinds.length === 0) out.push('  accounts: {}');
    else {
      out.push('  accounts:');
      for (const [kind, names] of accountKinds) {
        out.push(`    ${kind}: [${names.map(scalar).join(', ')}]`);
      }
    }
    out.push(`  birth_year: ${scalar(proposal.player.birth_year)}`);
    out.push(`  max_weight: ${scalar(proposal.player.max_weight)}`);
    out.push(`  is_beginner: ${proposal.player.is_beginner ? 'true' : 'false'}`);
    // Read-only, and the field to look at first. The import ignores it.
    out.push(`  known_how_claims: ${bgp.knownByPlayer.get(proposal.player.id) ?? 0}`);
    out.push('  evidence:');
    for (const line of proposal.evidence) out.push(`  - ${scalar(line)}`);
    out.push(`  confidence: ${proposal.confidence}`);
    out.push('');
  }

  out.push('groups:');
  const matched = proposals.filter((proposal) => proposal.group);
  if (matched.length === 0) out.push('# nothing here could be settled — see `unmatched:` below');
  for (const proposal of matched) {
    out.push(`- id: ${proposal.group?.id}`);
    out.push(`  label: ${scalar(proposal.group?.label)}`);
    out.push(`  people: [${proposal.personId}]`);
    out.push('  evidence:');
    for (const line of proposal.evidence) out.push(`  - ${scalar(line)}`);
    out.push(`  confidence: ${proposal.confidence}`);
    out.push('');
  }

  out.push('unmatched:');
  out.push('  # NEVER IMPORTED. Move a block up into `people:` or `groups:` to answer it.');
  // An empty list is written INLINE. `people:` followed by a bare `[]` on the next line at the
  // same indent is not a list, it is a parse error, and a proposal that will not parse is a
  // proposal nobody can confirm.
  out.push(ambiguous.length === 0 ? '  people: []' : '  people:');
  for (const item of ambiguous) {
    out.push(`  - board_game_picker_id: ${scalar(item.player.id)}`);
    out.push(`    display_name: ${scalar(item.player.display_name)}`);
    out.push(`    candidates: [${item.candidates.join(', ')}]`);
    out.push('    question: >-');
    out.push('      More than one group matches this player, or this group matches more than one');
    out.push('      player. Two candidates is less certain than none — say which, or neither.');
    out.push('    confidence: low');
  }

  const unmatchedGroups = groups.filter((group) => !matchedGroupIds.has(group.id));
  const bgpGroups = bgp.groups.filter(
    (group) => !groups.some((existing) => norm(existing.label) === norm(group.name)),
  );
  out.push(unmatchedGroups.length === 0 && bgpGroups.length === 0 ? '  groups: []' : '  groups:');

  for (const group of unmatchedGroups) {
    out.push(`  - id: ${group.id}`);
    out.push(`    label: ${scalar(group.label)}`);
    const accounts = Object.entries(group.accounts)
      .map(([kind, names]) => `${kind}: ${names.join(', ')}`)
      .join('; ');
    out.push(`    accounts: ${scalar(accounts || 'none')}`);
    out.push(`    candidates: [${everyPersonId.join(', ')}]`);
    out.push('    question: >-');
    out.push('      Which people is this group? Nothing in its label or its accounts names a');
    out.push('      Board Game Picker player exactly, so there is nothing to read it off.');
    out.push('      Add a `people:` list and move it up into `groups:`.');
    out.push('    confidence: low');
  }

  for (const group of bgpGroups) {
    const people = (bgp.members.get(group.id) ?? [])
      .map((playerId) => byPlayerId.get(playerId)?.personId)
      .filter((id): id is string => Boolean(id));
    out.push(`  - board_game_picker_group: ${scalar(group.name)}`);
    out.push(`    people: [${people.join(', ')}]`);
    out.push('    question: >-');
    out.push('      Board Game Picker has this group and its membership is CERTAIN — it is a');
    out.push('      primary-key join, not a name match. QueuePilot has no group with this label,');
    out.push('      and this file never invents a /g/<id> URL. Create the group in the app, then');
    out.push('      move this block into `groups:` with that id.');
    out.push('    confidence: high');
  }

  out.push('');
  return out.join('\n');
}

// ── subcommands ───────────────────────────────────────────────────────────────────────── //

function propose(argv: readonly string[]): number {
  const bgpFile = argFor(argv, '--bgp');
  const groupsFile = argFor(argv, '--groups');
  if (!bgpFile || !groupsFile) {
    console.log('propose needs --bgp <board-game-picker.sqlite> and --groups <groups.yaml>');
    return 2;
  }
  for (const file of [bgpFile, groupsFile]) {
    if (!existsSync(file)) {
      console.log(`no such file: ${file}`);
      return 2;
    }
  }

  const bgp = readBgp(bgpFile);
  const groups = readQueuePilotGroups(groupsFile);
  const { ambiguous, proposals } = buildProposals(bgp.players, groups);
  const text = renderProposal(proposals, ambiguous, groups, bgp, { bgpFile, groupsFile });

  // A generator that emits YAML nobody can parse is a generator that wasted the owner's
  // evening. Re-read our own output before offering it, and check it the way the import will.
  const reparsed = parse(text) as { people?: unknown[] } | null;
  const check = validateMapping({ ...reparsed, confirmed: true }, new Set(groups.map((g) => g.id)));
  if (check.problems.length) {
    console.log('the generated proposal does not validate — this is a bug in this tool:');
    for (const problem of check.problems) console.log(`  - ${problem}`);
    return 1;
  }

  const out = argFor(argv, '--out') ?? mappingCandidates()[1] ?? mappingCandidates()[0] ?? '';
  if (argv.includes('--write')) {
    writeFileSync(out, text, 'utf8');
    console.log(`wrote ${out}`);
  } else {
    console.log(text);
    console.log(`# (dry run — pass --write to save this to ${out})`);
  }

  const byConfidence = (level: string) =>
    proposals.filter((proposal) => proposal.confidence === level).length;
  console.log(
    `\n${proposals.length} person proposal(s): ${byConfidence('high')} high, ` +
      `${byConfidence('medium')} medium, ${byConfidence('low')} low. ` +
      `${proposals.filter((proposal) => proposal.group).length} group link(s). ` +
      `${ambiguous.length} ambiguous player(s), ` +
      `${groups.length - new Set(proposals.map((p) => p.group?.id).filter(Boolean)).size} unmatched group(s).`,
  );
  return 0;
}

function runImport(argv: readonly string[]): number {
  const file = mappingPath();
  if (!file) {
    console.log(`no mapping file — looked at:\n  ${mappingCandidates().join('\n  ')}`);
    return 1;
  }

  if (!argv.includes('--apply')) {
    // The dry run does the same reading and the same checking as the real thing and stops one
    // statement short of writing, so "it validated" means what it says.
    let raw: unknown;
    try {
      raw = parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.log(`${file} is not valid YAML: ${errMessage(e)}`);
      return 1;
    }
    const confirmed = (raw as { confirmed?: unknown } | null)?.confirmed === true;
    const { mapping, problems } = validateMapping(raw, new Set(groupIdsForDryRun()));
    console.log(`file:      ${file}`);
    console.log(`confirmed: ${confirmed ? 'yes' : 'NO — the import will refuse to write'}`);
    console.log(`people:    ${(mapping.people ?? []).length}`);
    console.log(`groups:    ${(mapping.groups ?? []).length}`);
    if (problems.length) {
      console.log(`\n${problems.length} problem(s) — nothing would be written:`);
      for (const problem of problems) console.log(`  - ${problem}`);
      return 1;
    }
    console.log('\nvalidates. Re-run with --apply to write it.');
    return confirmed ? 0 : 1;
  }

  const result = importPeople({ force: argv.includes('--force') });
  console.log(`file:   ${result.file}`);
  console.log(`reason: ${result.reason}`);
  if (result.problems.length) {
    for (const problem of result.problems) console.log(`  - ${problem}`);
    return 1;
  }
  if (!result.imported) return 1;
  console.log(
    `imported ${result.personIds.length} person(s), ${result.accountCount} account(s), ` +
      `${result.rosterCount} roster place(s) across ${result.groupIds.length} group(s)`,
  );
  console.log(`people: ${result.personIds.join(', ')}`);
  console.log(`groups: ${result.groupIds.join(', ')}`);
  return 0;
}

/** The group ids the dry run validates against — the store's, read through the same path the
 * import uses, so a dry run cannot pass on a set of groups the real run would not see. */
function groupIdsForDryRun(): string[] {
  const doc = store.groups.readSync();
  const listed = Array.isArray(doc.groups) ? doc.groups : [];
  return listed
    .map((raw) => String((raw as { id?: unknown } | null)?.id ?? '').trim())
    .filter(Boolean);
}

const USAGE = `people-mapping — propose the people mapping, and import a confirmed one.

  propose --bgp <board-game-picker.sqlite> --groups <groups.yaml> [--out <path>] [--write]
  import  [--apply] [--force]

Both are PRINT-FIRST: nothing is written without --write / --apply. The import refuses every
mapping file that does not carry an explicit \`confirmed: true\`.`;

const [, , subcommand = '', ...rest] = process.argv;
const code =
  subcommand === 'propose' ? propose(rest) : subcommand === 'import' ? runImport(rest) : (console.log(USAGE), 2);

process.exit(code);
