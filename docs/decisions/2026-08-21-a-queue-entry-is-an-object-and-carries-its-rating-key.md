# A queue entry is an OBJECT, and it carries its rating key

- **Status:** Accepted
- **Date:** 2026-08-21
- **Type:** data format / reversal
- **Supersedes:** the string-entry half of
  [2026-07-20-queue-entries-are-title-strings](2026-07-20-queue-entries-are-title-strings.md)
- **Extends:** [2026-08-21-a-queue-entry-names-an-item-not-a-line](2026-08-21-a-queue-entry-names-an-item-not-a-line.md)
- **Superseded by:** —

## Decision

Four rules.

1. **Every `queues.yaml` entry is a MAPPING.** An item is
   `{ratingKey: "<key>", title: "<text>"}`, a collection is `{collection: "<name>"}`, and a
   title nothing answers to is `{title: "<text>"}`. The bare-string forms — `- "Duel (1971)"`,
   `- 12345`, `- "Collection: Godzilla"` — are not written and are not played.
2. **Rating keys are backfilled.** Every title the engine's own resolver can name is written
   into the file as a rating key. 80 of the owner's 327 entries gained one; none was left
   unresolved.
3. **A bare string is refused per ENTRY, never per file.** `loadEntries()` drops it by name and
   logs the fix; every other entry in that queue still plays. It stays in the file, stays in the
   editor's list, stays addressable by `entryKey`, and paints as an unresolved (red) tile — so
   it can be seen and repaired rather than silently ignored.
4. **`entryKey()` is untouched, and so is the HTTP surface.** The key still keys a scalar. The
   API still accepts `{value: "Some Title"}`; `queues.toEntryObject()` normalizes it at the
   write boundary. Only the disk shape changed.

The migration is `server/src/tools/migrate-entry-objects.ts` (dry run by default, backup before
writing, idempotent). The data change runs BEFORE the code is deployed.

## Context

> "Backfill rating keys. Let's upgrade everything to the new object version. No old string
> versions supported in YAML anymore." — owner, 2026-08-21

The 2026-08-21 record above found the cause and left the repair: an entry had two possible
identities on disk — a rating key or a bare title — and 84 live entries carried only the title.
That record fixed the symptoms in code (coverage resolves titles; the add path runs a second,
looser duplicate test) and explicitly deferred the data change: *"Nothing is written to
`queues.yaml`."* This is that change, plus the format break that stops the shape coming back.

The 2026-07-20 record is why the strings were there. It is right about the half that still
holds — **a human must never need a rating key** — and a hand-written `- {title: "Duel (1971)"}`
still resolves at scan time exactly as it always did. What it is superseded on is the SHAPE: an
entry is a mapping, not a scalar.

## Why

**Why backfill at all.** A title is resolved fresh on every scan, against a library that
changes. Two items can answer to one title, and `resolveTitle` breaks that tie on the lowest
rating key — so an entry's meaning can move under it when a new copy is added. A rating key
cannot. The backfill freezes each entry on the item it plays TODAY, which is why the resolver
used is the ENGINE's own (`resolveQueueEntry`) and not a second matcher: the migration must
change nothing about what plays, only about how permanently it is named.

**Why the string form had to go, and not just be discouraged.** Three reasons, in the order they
cost something:

- A scalar cannot carry a sibling field. `markDone` has to *rewrite* an entry into a mapping to
  stamp `done_at`, and `entryNode()` used to *collapse it back* the moment the last override was
  cleared. The file oscillated between two shapes on ordinary edits.
- Every reader carried a scalar arm — `entryKey`, `entryDone`, `entryDoneAt`, `splitEntry`,
  `describe`, `resolveValue`, `displayFor`. Seven places that had to agree about what a bare
  string means.
- A `Collection: <name>` string encodes an entry's KIND in a text prefix that each of those
  readers re-parses with its own regex. `plex.resolveValue` did not have one for the mapping
  form at all, so a `{collection: …}` entry — a shape `entryKey` and the engine have understood
  for months — painted as an UNRESOLVED tile in the grid while playing perfectly. That bug was
  found by choosing this target shape, which is the argument for the shape.

**Why `{collection: "<name>"}` and not `{title: "Collection: <name>"}`.** Both key identically —
`entryKey` returns `title:Collection: <name>` for the string, the title mapping and the
collection mapping alike, so nothing is re-keyed either way. The title spelling was the cheaper
change and it is the wrong one: it keeps the kind in the prose. A collection has no per-item
rating key and is resolved by NAME per section; saying so in the key is what makes the entry
readable without a regex. The cost was two readers that only understood the prefix
(`plex.resolveValue`, `tiles.displayFor`), both fixed here, both verified against the live
server — the two forms return the same rating key, the same poster and the same child count.

**Why an unresolvable title stays as an object rather than being dropped or guessed.** A rating
key cannot be invented. Deleting the line loses a wish the owner typed; guessing pins the entry
to the wrong film for ever. So it becomes `{title: "…"}` like every other line, and the tool
names it in a section of its own for him to fix. On his live file that list is EMPTY — every one
of the 327 entries resolved.

**Why the refusal is per entry and never per file.** A file-level error was considered and
rejected. This app runs unattended: the household plays queues from NFC cards, and a hard read
error would take EVERY queue off the air over one stale hand-typed line — a failure wildly out
of proportion to the fault, and one nobody would be at a keyboard to diagnose. A warning that
still plays the string was rejected for the opposite reason: "supported, with a log line" is
still supported, and the shape would never leave.

The danger of the middle path is silence — an entry that stops playing and looks fine. That is
answered rather than accepted: the entry is not resolved at all in `/api/queues`, so the grid
paints it with the red **unresolved** border it already has for an entry naming nothing, and the
server logs one named line per broken entry with the exact mapping to write.

**Why `entryKey` is still pinned.** The Python prune addressed lines by it, `e2e/fixtures/golden/`
records what it returns, and `removeItem`/`reorder`/`moveItem` address a line by it. It must keep
keying a scalar, or a file that still holds one could not be repaired through the editor. All
five parity oracles pass unchanged.

## Evidence

- Owner quote above.
- **Live file, measured read-only, then migrated on a COPY.** 327 entries in 16 queues: 225
  already objects, 80 titles backfilled, 22 collections reshaped (18 from strings, 4 from
  `{title: "Collection: …"}`), **0 unresolved**. 102 lines changed; 247 of 327 keys are
  byte-identical afterwards and **every one of the 80 that moved is `title:<text>` → `rk:<key>`**,
  which is the backfill itself. No entry was added, dropped or reordered.
- **Idempotent, byte for byte.** A second `--apply` over the migrated copy produces an identical
  file (`cmp`).
- **Comments survive.** The head block, the per-queue notes and the free-standing group comments
  are untouched. One cosmetic change: an entry's own TRAILING comment moves to the line above
  it, because a block mapping has no single line to end. `# not in library yet` is the live
  example — and it is now stale, since that film resolved.
- **Parity.** `engine-parity`, `curated-parity`, `binding-parity`, `set-passthrough-parity` and
  `mark-done-parity` all pass with the fixtures rewritten to the object form, which is the proof
  that the reshape is a spelling change: the same entries, the same keys, the same play lists.
- **Gate.** `e2e/entry-objects-test.ts`, hermetic and offline (the Plex lookup is injected), 38
  checks: every sibling field survives (`start`, `done`, `done_at`, `weight`, `episodes`,
  `volumes`, `batch_stops_at`, `queued_at`, **and a field this code has never heard of**); a
  second run rewrites nothing; comments survive; an unresolvable title keeps its title, gains no
  key and is reported every run; `loadEntries` drops a legacy scalar while `listSet` keeps it;
  `addItem` writes a mapping for a title, a rating key, a collection string and a mapping alike;
  and clearing an entry's last override no longer collapses it to a scalar.
- **Collections still paint.** Against the live server, `Collection: <name>` and
  `{collection: "<name>"}` resolve to the same rating key, the same poster and the same child
  count.

## Deploy order — the data first

The migration MUST run before the new code is deployed. Both halves are safe on their own; only
this order is safe together.

1. Run the dry run against `/config/queues.yaml` and read the UNRESOLVED list.
2. Run it with `--apply`. It writes `queues.yaml.bak-objectform-<date>` first.
3. Then pull and redeploy the app.

The old code reads the migrated file perfectly (mappings have always been legal), so step 2 is
safe while the current build is running. The reverse order is not: the new build would meet the
old strings and refuse them, one entry at a time, until the migration caught up.

## Still open

- **The live file's header comment still describes the old formats.** It is a hand-written block
  in `/config/queues.yaml` and this change does not rewrite prose. The fixture copy is updated;
  the live one needs one hand edit.
- **`sets.yaml` members and blocklists are NOT in scope.** They still accept a bare string and a
  `Collection: <name>` string, and `describe()` still reads both. This decision is about queue
  entries.
