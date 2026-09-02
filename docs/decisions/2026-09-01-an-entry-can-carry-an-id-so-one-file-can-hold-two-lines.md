# An entry can carry an `id`, so one file can hold two lines

- **Status:** Accepted
- **Date:** 2026-09-01
- **Type:** data model / queue identity
- **Supersedes:** The single-copy clause (§3) of
  [`2026-08-21-a-queue-entry-names-an-item-not-a-line`](2026-08-21-a-queue-entry-names-an-item-not-a-line.md),
  and the *"Why `entryKey` is still pinned"* reasoning in
  [`2026-08-21-a-queue-entry-is-an-object-and-carries-its-rating-key`](2026-08-21-a-queue-entry-is-an-object-and-carries-its-rating-key.md)
- **Superseded by:** —

## Decision

A queue entry may carry an optional opaque **`id`**, and `queues.entryKey()` reads it as its
**first** branch:

```
id:<opaque>   when the mapping carries an id
rk:<n>        otherwise, when it carries a ratingKey     (unchanged)
title:<text>  otherwise                                   (unchanged)
```

`addItem` mints an `id` **only for an add that would otherwise be refused as a duplicate**. An
entry without one keys exactly as it did before, byte for byte, so nothing re-keys and no
existing line moves.

Two rules keep the hole closed:

1. **`loadEntries()` refuses an entry that carries a section but no `id` when the queue already
   holds another line for the same item.** It refuses that ENTRY by name, the way it already
   refuses a legacy scalar, and every other entry in the queue still plays. This is the
   hand-edited-YAML case: someone typing a second section into `queues.yaml` over SMB.
2. **The duplicate guard stays, with a door in it.** `entryIdentity.findDuplicateItem` still
   refuses adding a film a queue already names, because an accidental second copy in a watch
   queue is a bug. An add that **carries a section** bypasses it, the way a collection add
   already does, and an add that does not gets an explicit **"Add another"** action on the
   already-here row.

Coverage is **not** changed. `pending.ts` asks "does a queue already name this item?", and two
sections of one film still cover one film.

## Context

`entryKey()` returns `rk:<ratingKey>`, so one queue could never hold the same file twice. That
was correct while an entry named an item. A section entry names a **line**: the demo reel needs
the same film at three positions with three different windows.

The existing behaviour was not merely a refusal — it was inconsistent underneath. Had a
duplicate key existed, the ~60 call sites that address an entry by key would have split three
ways: `rewriteEntry` and every per-entry setter take the **first** match; `removeItem`,
`removeBulk`, `markDone` and `clearDone` take **all** matches; `moveItem`'s destination guard
**drops the node entirely**; and `applyOrder`'s `Map` collapses two lines onto one rank. In the
web app, two lines would have shared one React key, one `selKey`, one drag `data-key` and one
`?only=` URL. That inconsistency is itself the evidence that key uniqueness is load-bearing.

Two SQLite tables are keyed on it and would have been actively destructive:
`queue_entry_history (set_id, entry_key, item_key)` — one section's resume position overwriting
the other's, and finishing one marking the other complete — and
`lead_cooldown (set_id, entry_key)`, where one promoted section suppresses its sibling.

## Why

**Restore the invariant rather than teach 60 call sites a new one.** Once a key names one line
again, "first match" and "all matches" converge on the same single line, so neither family of
mutation changes. Both SQLite primary keys become correct with **no migration**. Every React
key, selection id and URL segment becomes unique. Every pinned entry-key string in
`e2e/entry-objects-test.ts`, `e2e/mark-done-parity.ts`, `e2e/pending-test.ts`,
`e2e/priority-lane-test.ts` and `e2e/play-one-entry-test.ts` passes unmodified, because an
id-less entry keys as it always did.

**The stated reasons for pinning `entryKey` no longer hold.** Both 2026-08-21 records give the
same two, and they are repeated in roughly a dozen comments across the tree:

1. *"the Python prune addresses the same lines by it."* `queue_builder/` was **deleted** in
   `7bf01e0` ("chore: delete queue_builder — Node is the only implementation"). There is no
   second writer. Only `cast_sidecar/` is tracked Python and it never reads an entry key.
2. *"`e2e/fixtures/golden/` records what it returns."* It does not. None of `curated.json`,
   `engine.json`, `passthrough.json` or `routing.json` contains an `rk:` or `title:` key. The
   contract those fixtures pin does not cover entry identity.

The third reason — *"`removeItem`/`reorder`/`moveItem` address a line by it"* — stands, and is
precisely why `id` is **additive**: the key still keys a scalar, and a file that still holds a
legacy line can still be repaired through the editor.

**The 2026-08-21 mapping record makes this cheap rather than blocking it.** It established that
an entry is a mapping carrying arbitrary sibling fields, and its own gate asserts that "a field
this code has never heard of" survives a round-trip. `id` is that field.

## Alternatives rejected

- **A clip discriminator in the key (`rk:123#12000-45000`).** Editing a section's timecodes
  would **re-key the entry**, orphaning its `queue_entry_history` and `lead_cooldown` rows,
  breaking any `/go/<set>?only=<key>` bookmark or NFC card, and invalidating a held selection.
  It also reserves `#` and `-` in a namespace that today accepts any title verbatim, and it
  cannot express the same section twice.
- **Keying by position.** `queue_entry_history` and `lead_cooldown` would be keyed on a value
  that changes on every reorder, insert and remove, so a single drag would re-attribute progress
  and cooldowns to whatever entry moved into the slot. Every key-addressed URL becomes actively
  wrong rather than merely stale. It also changes `entryKey`'s signature at every call site.

## Consequences

Documentation debt is cleared in the same change: every comment claiming a Python second writer
or a golden-fixture entry-key contract is factually wrong at HEAD, and those two claims are the
entire load-bearing argument for the pin being lifted. They are listed in
`docs/clip-playback-design.md`.

`historyTarget()` in `routes/queuesRoutes.ts` uses `.find(row => row.key === key)`. That is
correct under unique keys and now depends on the invariant; it gains a comment saying so.

Two residual item-keyed sets are **not** fixed by this and are called out rather than papered
over: `resolve.skippedKeys()` and the provider `watched` set are keyed by ratingKey, so two
sections of one film share a provider watched mark. An entry that needs otherwise uses
`watch_history: queue`, which
[`2026-08-30-a-manual-start-can-own-its-progress`](2026-08-30-a-manual-start-can-own-its-progress.md)
already provides.

## Evidence

- Owner, chat 2026-09-01: *"If that mode is enabled, then make it also able to add the same file
  multiple times with different timecodes, but they can be at different points in the queue."*
- Owner, same chat, choosing scope: sections are available on any entry in any queue rather than
  behind a per-queue mode.
- `git show 7bf01e0 --stat` — `queue_builder/` deleted, including `queues.py` and its
  `entry_key`.
- `docs/demo-reel.queues.yaml` — the reel that motivates this, twenty pre-cut files.
