# A queue draws from exactly ONE provider — mixing is not a goal

- **Status:** Accepted
- **Date:** 2026-08-13
- **Type:** architecture / scope
- **Supersedes:** —
- **Superseded by:** —

## Decision

**A queue is Plex or Kavita, never both.** Mixing is not deferred, not "future work" — it is
out of scope, and the runtime is right to refuse it.

This **closes** the open question carried by
[`docs/kavita-open-decisions.md`](../kavita-open-decisions.md) §2 ("what a MIXED queue hands
off"). That question no longer needs an answer, because the case it was about does not arise.

**Also settled: the provider set is Plex and Kavita.** Jellyfin / Emby / Kodi are named in the
[provider ADR](2026-08-12-backends-are-providers-behind-a-media-neutral-seam.md) as what the
seam *permits*, not as things anyone is asking for.

## Context

The owner, 2026-08-13, while testing the live app:

> "We don't have any way to 'cast' to a Kavita install or Jellyfin etc. I only really care
> about Plex and Kavita for now, and it's either-or for me if that helps you figure out where
> to put your efforts in solving bugs."

That was volunteered as a scoping aid while he was hitting bugs, and it should be read that
way: it is a direction for where effort goes, not only a statement about data.

## Why

- **`materialize` / `handoff` stop being ambiguous.** The whole difficulty of a mixed queue
  was that it is a push target *and* a pull URL at once — a playQueue for the Shield and a
  reading list for the tablet, with no obvious answer for what a single NFC scan should do.
  One provider per queue makes the answer trivially the provider's own.
- **The refusal becomes correct rather than provisional.** `resolveSingle()`
  ([`server/src/providers/blocks.js`](../../server/src/providers/blocks.js)) throws on a mixed
  set and the launcher answers `501`. That was built as a deliberate refuse-to-guess while the
  question was open; it is now simply the right behaviour, and the test that guards it
  (`e2e/provider-seam-test.mjs`, "a mixed set THROWS rather than silently picking a provider")
  guards a rule instead of a placeholder.
- **It tells the UI what to do at every fork.** A queue has ONE delivery mode, so the start
  affordance, the Plex-only knobs and the library pickers all follow from a single per-set
  fact rather than from per-block reconciliation. `delivery` on the registry set exists
  because of this.

## What does NOT change

**Storage stays a list of blocks.** It would be a mistake to "simplify" `providers:` back to a
scalar now:

- The block is still the unit that carries `{provider, profile, libraries}` together, and a
  queue drawing from **two Plex profiles** — which the editor already allows and which is
  *not* mixing — needs more than one block.
- The list costs nothing while unused and would be a migration to reintroduce.

So: **N blocks, all naming the same provider.** `isMixed()` is what is forbidden, not
`blocks.length > 1`.

## Consequences

- The UI may keep offering "+ Add another source" — a second block on the *same* provider is
  legitimate. It must not let a second provider be chosen into an existing queue; today that
  is caught at save/launch rather than in the picker, which is a rough edge worth closing.
- Anything still written as "mixing is a future question" is now stale and should point here —
  starting with `kavita-open-decisions.md`.

## Evidence

- Owner quote above, 2026-08-13, in the live-testing thread.
- The refusal it ratifies: `resolveSingle()` in `server/src/providers/blocks.js`, the launcher's
  `501` branch in `server/src/providers/launcher.js`, and the guarding test in
  `e2e/provider-seam-test.mjs`.
