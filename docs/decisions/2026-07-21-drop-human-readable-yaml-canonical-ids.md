# Human-readable YAML is no longer a goal; stable IDs are canonical entry identity

- **Status:** Accepted — **2026-07-21** (direction; not yet fully implemented)
- **Date:** 2026-07-21
- **Type:** reversal / data format
- **Supersedes:** the hand-editability / human-readable goal in
  [2026-07-20-queue-entries-are-title-strings.md](2026-07-20-queue-entries-are-title-strings.md)
  as a *requirement*. Finishes the walk-back begun in
  [2026-07-20-queue-web-ui-ux-and-write-format.md](2026-07-20-queue-web-ui-ux-and-write-format.md)
  ("human-readable YAML is no longer required").
- **Superseded by:** —

## Decision

The `queues.yaml` / `sets.yaml` files **no longer need to be human-readable or hand-editable**.
The Web UI is now the editing surface, so that constraint is dropped.

Consequently, an entry's **canonical identity is a stable ID** — a Plex `ratingKey` (and set/queue
identity is the immutable slug `id` already established in
[2026-07-21-sets-registry-immutable-ids.md](2026-07-21-sets-registry-immutable-ids.md)). Free-text
**title strings are downgraded from identity to a display/label hint**: still accepted as *input*
(paste-a-folder-name, AI-added entries), resolved once to a ratingKey, and thereafter matched,
deduped, pruned, and marked `done` by ID — never by verbatim text.

## Context

The original queue format (July 20) made the title *string* the primary form, precisely because the
file was meant to be a hand-typed wishlist. That goal has been overtaken: there is now a real live
Web UI (SSE, monorepo — see
[2026-07-21-real-webapp-sse-yaml-not-sqlite.md](2026-07-21-real-webapp-sse-yaml-not-sqlite.md)) that
writes `{ratingKey, title}`. With the UI as the editor, keeping "reads like a wishlist" as a design
constraint no longer buys anything, and it actively blocks moving to stronger identifiers.

## Why

- **String identifiers don't have stable identity.** Entry identity is derived from the *verbatim*
  title (`queue_builder/queues.py` `entry_key`, ~L129-151). A re-typed, renamed, or re-cased title
  is treated as a *different* entry — so dedup, reorder, prune, and `done`-tracking are all fragile.
  A ratingKey is stable across renames and edits.
- **Titles are ambiguous / lossy.** `(year)` + `[guid]` hints exist only to disambiguate a title
  back to a single Plex item; a ratingKey needs none of that.
- **The human-readable constraint is now unpaid-for.** It cost us the weaker identifier and bought
  hand-editability we no longer rely on, now that the UI edits the files.
- **We expect to outgrow strings.** Per-entry state we want to attach (progress, collection
  expansion, `done`, ordering, provenance of who/what added it) wants a keyed record, not a string.

## Implications / follow-ups

- Key entry identity, dedup, prune, and `done` on **ratingKey**, falling back to a resolved-ID only
  when a bare title hasn't yet been resolved. Stop treating the raw title as the identity key.
- Title strings stay a *valid input* (hand-paste, AI) but the resolver's job is to attach a
  ratingKey ASAP; the persisted canonical record is `{ratingKey, title, …}`.
- YAML formatting/ordering/comments are free to optimize for the machine, not the eye (this also
  relaxes [2026-07-20-queues-yaml-no-per-set-label-comments.md](2026-07-20-queues-yaml-no-per-set-label-comments.md)'s
  concerns — the header map exists for humans, not the parser).
- Not yet implemented: the resolver/`entry_key` still key on title text today. This doc records the
  target so the migration isn't relitigated.

## Evidence

- User (chat 2026-07-21): *"I no longer care about human-readable because we have a Web UI … I think
  we're going to run into limitations if we keep using string identifiers."*
- User (chat 2026-07-20, the earlier signal): *"You also don't need the titles to be human-readable
  in the YAML anymore because we have the Web UI."*
