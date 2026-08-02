# Every dynamic channel is a first-class UI entry, and rotation channels are deletable

- **Status:** Accepted (implemented + deployed)
- **Date:** 2026-07-29
- **Type:** UI / data model
- **Supersedes:** the "rotation channels cannot be deleted from the UI" clause of
  [2026-07-21-sets-registry-immutable-ids](2026-07-21-sets-registry-immutable-ids.md)
- **Superseded by:** clause 3 only, by
  [2026-07-29-rewatch-pool-follows-the-channels-own-libraries](2026-07-29-rewatch-pool-follows-the-channels-own-libraries.md)
  (the rewatch pool now follows the channel's libraries, so the pickers are real and shown).
  Clauses 1 and 2 stand.

## Decision

1. **The web UI's dynamic-channel surface is data-driven, one entry per rotation channel.**
   The Play landing and the Channels picker previously hardcoded exactly two function
   buckets ("Shows & Shorts", "Movies") and folded every `behavior: progress` channel into
   the first via `channelsForSub`. They now iterate `rotationChannels()` and render **one row
   / one picker entry per channel** — Shows & Shorts, Shows, Shorts, Movies, and any future
   rotation. Each channel's tier picker lists **only that channel's own bindings**, so a tier
   never appears more than once. Routing is `#/channels/<id>`; the channel's `behavior`
   (progress vs rewatch) derives the editor kind, replacing the `sub`-view argument.

2. **Rotation channels can now be deleted from the UI.** The Configure modal has a **Delete
   channel** button (any rotation channel, including the function channels), and
   `sets.deleteSet` no longer throws for `source: rotation`. The confirm dialog warns that any
   NFC card or HA button pointing at the channel's id will stop working until repointed —
   because this process cannot see HA's `tag_command_map`, deletion cannot auto-unwire a card.

3. **A rewatch channel hides its (inert) library pickers.** The Movies channel's rewatch pool
   is hardwired to the Movies library (`config.SEC_MOVIES`) in `queue_builder/plex.py`; its
   `sections`/`item_sections` never drove the pool (they only scoped the ratings picker). The
   modal showed movie-library checkboxes that looked controlling but did nothing — and, worse,
   rendered "Movies" *unchecked* because the channel stores its library in `sections` (which
   the form maps to the *show*-library group, where a movie library isn't listed). For a
   `behavior: rewatch` channel the modal now hides the library fieldsets and shows a note
   ("Rewatch always draws from your Movies library — there's no library to pick"); on save it
   preserves the channel's existing `sections` rather than reading the hidden checkboxes.

## Context

The two-function-bucket UI was correct when the only rotation channels were the two fixed kid
tiers. Once the kid channels became user-created and splittable
([2026-07-27-younger-kids-shows-and-shorts-are-two-cards](2026-07-27-younger-kids-shows-and-shorts-are-two-cards.md)),
adding `shows`/`shorts` produced a visible bug: the "Shows & Shorts" landing row listed
**Younger Kids / Older Kids three times each** (one pair per progress channel). Bob caught
it — *"This is so messed up"* (screenshot of the triplicated dropdown) — then asked to make
the split channels first-class: *"Yes, you can make it so, in the UI, I can make Older Kids
also do shorts only. That's useful."* He separately asked how to delete an unwanted channel
(there was no way), and why the Movies modal showed the Movies library unchecked while clearly
playing from it.

The e2e default seed (`server/src/sets.js`) was still the pre-migration legacy shape
(`younger`/`older`); it was migrated to the function-channel shape so the tests exercise what
production actually runs (one code path, no legacy/production branching). The migration-history
verifier (`verify-pr4-cutover`) keeps its own legacy seed.

## Why

- **The channel model was always meant to be data (`sets.yaml`), not hardcoded UI.** The
  landing/picker were the last hardcoded remnant; making them data-driven is the natural
  completion of [2026-07-21-sets-registry-immutable-ids](2026-07-21-sets-registry-immutable-ids.md).
- **Deletion is a real need now.** The no-delete rule assumed rotation channels were fixed and
  account-bearing. With user-created channels, "I made one I don't want" is normal; the id ↔
  card risk is handled by a warning, the same blind spot every web-side set change already has.
- **A control that does nothing is worse than no control.** The inert Movies library pickers
  actively misled (unchecked ≠ "not used"); hiding them removes the contradiction.

## Evidence

- Bob, 2026-07-29 session: the quotes above; approved the previewed 4-row landing
  ("Looks good!"); chose *"Allow deleting any dynamic channel"* (no core-channel protection).
- Live preview (local server on a copy of production `sets.yaml`): 4 dynamic rows, each tier
  dropdown = Younger/Older once; Movies modal hides libraries + shows the note; Delete button
  present on every channel modal.
- e2e: full gating suite green (`suites failed: 0`); `api-v2-test` gained rotation-delete
  assertions (deletes, gone from registry, idempotent); `channels-test` repointed its
  persistence checks from the legacy `younger` set to the `shows_shorts` Younger binding.

## See also

- [2026-07-29-drop-set-auto-from-ui-every-play-explicit.md](2026-07-29-drop-set-auto-from-ui-every-play-explicit.md)
- [2026-07-27-younger-kids-shows-and-shorts-are-two-cards.md](2026-07-27-younger-kids-shows-and-shorts-are-two-cards.md)
