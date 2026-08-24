# The collection's grouping rules are rows in the book of record, not a table in the source

- **Status:** Accepted
- **Date:** 2026-08-23
- **Type:** architecture / privacy / absorb
- **Supersedes:** —
- **Superseded by:** —
- **Blocks:** WP-4b of the absorb (schema + data). Nothing may `CREATE TABLE` for the
  collection until this is settled, because the answer decides whether one of those tables
  is seeded from source or from the owner's file.
- **Implements:** the household absorb decision, named rather than linked because it lives in
  a sibling workspace repo that is not on GitHub —
  `agentic:docs/decisions/2026-08-22-queuepilot-absorbs-board-game-picker-tonight-pick.md`.

## Decision

**The rules that collapse a shelf of physical boxes into a list of playable titles are DATA.
They live in `/config/queuepilot.sqlite`, seeded once by the absorb migration and edited from
a screen. The public repo keeps the grouping ALGORITHM and the SHAPE of the two rule tables,
and none of their contents.**

Three parts, and the third is what makes the first two cheap.

1. **The collection-specific merge rules become rows** in the table the absorbed app already
   has for them. That table holds **150** owner-made rules today; the source file holds
   **18** more of the same kind. The 18 join the 150 and the source table is deleted.
2. **The "yes, that really is its own title" answers become rows** with a review timestamp,
   in the table that already means exactly that. There are **4** of them in source and the
   table is already the runtime home for the same answer.
3. **The algorithm ports whole and public.** Normalizing a title, finding the franchise
   prefix, recognizing an edition marker, the longest-prefix match and the two-pass box→title
   assignment are **542 of the file's 718 lines** and name nothing in anybody's collection.
   They keep their tests, they get a CI gate, and they read their rules from the store.

**A rule row carries a `source`.** `migration` for a row this absorb seeded, `owner` for one a
screen wrote. Without it a re-run doubles a merge or an unattended re-seed reverses a
correction, and neither is visible until a title goes missing from the pool.

**A rule row does NOT carry a regular expression.** Every one of the 18 matches a literal
title prefix: 17 are one prefix, the 18th is two prefixes for one title, and exactly one
carries a single literal exception. So the column is `prefix TEXT`, one row per prefix, plus a
nullable `except_contains TEXT` — and the store never compiles a pattern out of a text column.

**The REASON for a rule does not go in a column.** Each of these rulings already has a dated
decision record in the private workspace repo, and 8 of the 18 quote one in a code comment
today. A `reason` column would be a second, worse copy of a record that already exists. The
row is the ruling; the record is the argument.

### What was rejected

| Option | Why not |
| --- | --- |
| **A data file in App-Configs, loaded at boot** | It splits ONE kind of fact across two stores — 150 rows in SQLite and 18 lines in a file — with a precedence order no screen can show. It is also a fifth durable file in `/config` one day after [the fold](2026-08-23-promote-sqlite-folds-into-the-book-of-record.md) spent a decision removing the third. The `groups.yaml` precedent does not reach it: that file is config a person hand-edits and **no screen writes**, and these rules have had a screen writing them for weeks. |
| **A private sibling repo** | The private workspace repo is not mounted in the running container; the image ships one bundled file. Vendoring household data into a public image at build time is worse than either alternative, and a rule the owner can only change by asking an agent to edit a repo is a regression against a screen he already has. It stays the right home for the *documents* — the plan, the decisions, the inventory. |
| **A sanitized placeholder table in the repo, overlaid at runtime** | Two schemas for one table, and the overlay is the part that must never be wrong. It is the App-Configs option with more moving parts, plus a committed table that states things about a collection that are false. |

## Context

The absorb pulls in `import/grouping.ts` from `board-game-picker` — the file whose job is to
decide which physical boxes are the same game. Most of it is an algorithm. A quarter of it is
a hand-curated table of the owner's rulings about his own shelf.

Measured, because a recommendation without the numbers is a guess:

| | |
| --- | --- |
| The file | 718 lines, 22.2 KB |
| The two rule tables inside it | **176 lines — 24 % of the file** |
| Merge rules | **18** |
| "Kept separate" answers | **4** |
| Rules carrying a hard-coded external listing id | 3 |
| Rules carrying an exception clause | 1 |
| Comments attributing a ruling to the owner | **18**, of which **8** are dated quotes |
| Collection titles named literally in the file | **30** — 26 inside the two tables, 4 in the algorithm's own explanatory comments |
| The file's own test suite | 19 cases, 383 lines, naming **51** collection titles |

And the same fact measured from the other side, in the running database:

| | |
| --- | --- |
| Owner-made merge rules, as rows | **150** |
| Distinct physical box labels they name | 150 |
| Distinct titles they produce | 19 |
| Rows carrying an external listing id | 137 |

**The rows already win.** The importer applies the owner's rows *before* the source table, so
a row overrides a coded rule for the box it names, and 28 of the 150 do exactly that today.
Over the collection's 562 boxes the split is: **152 decided by rows, 116 more decided by the
source table, and 294 decided by the generic algorithm with no rule at all.**

So the source table is not the rule system. It is the smaller, older, unreachable half of a
rule system whose bigger half is already a table with a screen on it.

## Why

### One of the 18 has already gone stale, and nothing could tell

A source rule names the title id it produces. For one of the 18, **that id does not exist in
the collection any more.** Thirty-five owner rows have since re-formed that family under a
different id and a different display name, and the coded rule has been dead ever since — no
error, no warning, no test failure, because a rule that matches nothing simply does not fire.

This is the argument on its own. A rule the owner can revise from a screen is a rule that
stays true. A rule in source that only an agent can revise drifts silently from the collection
it describes, and drift in this system is invisible by construction: a wrong grouping removes
a title from the pool, and a title that is never offered is a title nobody misses.

### They look like code and they are not

The temptation is to say a rule with a regular expression in it is code. Six fields per rule,
and only two are executable — both anchored literal prefixes. The function that reads them is
a six-line `Array.find`. Nothing needs a pattern engine, which is why the row shape above has
a `prefix` column and no pattern column: the data was never using the capability.

The reverse test settles it. Ask whether a rule would be identical in another household's
copy of this app. Every line of the algorithm would be. Not one of the 22 rules would.

### A fresh container is empty, not broken

This is the property that makes the whole recommendation cheap, and it is worth stating
because the alternatives were all attempts to avoid a broken first run.

The rule tables start empty. The algorithm still groups a collection — it decides 294 of 562
boxes today with no rule at all — and the ones it cannot decide are **reported, not guessed**,
which is the behaviour the file was written around from the start. A contributor with a fresh
container sees a working picker holding a review list, which is precisely what an unreviewed
collection looks like. Nobody sees a placeholder table describing somebody else's shelf.

### The CI gate becomes honest

WP-4a could not commit the absorbed app's own database suites as a gate, because running them
here means vendoring the file this record is about. Its proof is an out-of-band script, and it
said plainly that **nothing in CI protects the port from drift**.

Splitting the file closes that. The algorithm is public, so its 19 cases are committable and
CI can run them — after they are re-authored against invented titles, which is real work and
is sized above at 51 names across 383 lines. What CI cannot ever gate is the *contents* of the
owner's rules, and it should not: those are answers, not assertions.

### It is the split this repo already runs on

`server/src/groups.ts` is the identity layer and is public; the file that says who is in the
household is in App-Configs and has never been in the tree. WP-2 kept the same line — the
schema, the queries and the projection are public, and the rows are not. The absorbed app made
the same commitment in its own first-week record and then broke it here, in one file, on a
host where nobody would notice.

## What this costs

Stated rather than argued away.

1. **A rule is no longer edited by editing a file.** For a box-label merge that is an
   improvement — the screen exists. For a title-prefix rule it is a gap: no screen writes one
   today, so until WP-4b or a later package builds the editor, changing one means SQL over the
   share. That is worse than a text file for exactly one kind of edit, and the answer is to
   build the editor, not to keep the source table.
2. **Four collection titles sit in the algorithm's own comments** and must be re-authored as
   invented examples before the file is committed. This is the third time absorbing this app
   has meant stripping household content out of otherwise-portable code, so treat it as the
   rule and check for it rather than being surprised by it.
3. **The test suite must be re-authored.** 19 cases, 51 real titles. The cases are good and
   the fixtures are not portable.
4. **A seeded row and an owner row must stay distinguishable forever.** That is the `source`
   column, and it is the one column here that cannot be added later without guessing which
   existing rows were which.

## Evidence

- The two source tables, counted: 18 merge rules and 4 kept-separate answers across 176 of
  718 lines; 30 collection titles named, 26 of them inside those tables.
- The runtime table, counted: 150 owner rows over 150 distinct box labels, 137 carrying a
  listing id, 28 of them overriding a source rule for the same box.
- Precedence read from the importer: the owner rows are applied first and short-circuit the
  source lookup, so a row wins wherever both exist.
- One source rule names a title id absent from the live collection; 35 owner rows have
  reformed that family under a different id.
- The absorbed app's own comment on its kept-separate table says the source set "is the same
  ruling made by an agent editing the importer; this is how he makes one himself" — the two
  homes for one fact were known when the second was built.
- Absorbed app's founding record, named rather than linked (sibling workspace repo):
  `agentic:board-games-private/docs/decisions/2026-08-09-board-games-code-is-public-data-is-private.md`
  — *"App code, schema, migrations, scoring config, tests"* publishable; the collection,
  the people and the rulings never in git.
- This repo's standing rule, [`AGENTS.md`](../../AGENTS.md): people, plays and known-how are
  **schema and code here, data in App-Configs**.
- WP-4a's script header, which raised the question and correctly refused to answer it:
  *"Sanitizing them is a design question about where owner rules should live, which is WP-4b's
  call and not a side effect of a driver port."*
