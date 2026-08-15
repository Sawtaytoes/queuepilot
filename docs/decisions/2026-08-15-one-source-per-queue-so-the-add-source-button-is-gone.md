# One source per queue — "+ Add another source" is removed

- **Status:** Accepted
- **Date:** 2026-08-15
- **Type:** ui / scope
- **Supersedes:** the "Consequences" clause of
  [2026-08-13-a-queue-draws-from-exactly-one-provider](2026-08-13-a-queue-draws-from-exactly-one-provider.md)
  that kept the button ("The UI may keep offering '+ Add another source'")
- **Superseded by:** —

## Decision

**The "+ Add another source" button is removed from the queue editor.**

What does NOT change:

- **Storage stays a list.** `providers:` remains N blocks; `blocksForSet()` /
  `resolveSingle()` are untouched. Nothing migrates, and no set on disk is rewritten.
- **Existing multi-block sets still render**, each block with its Remove button, so one can be
  collapsed by hand.
- The single-provider rule and its refusals (`isMixed()`, the launcher's 501, the save-time
  rejection) are unchanged.

## Context

The owner, 2026-08-15, with the button circled in red:

> "I think you said some decision was made to not combine providers since it causes all sorts
> of logistical issues. At that point, should we remove this 'Add another source' button and
> functionality since it's no longer viable?"

The 2026-08-13 decision had kept it, on the reasoning that a second block on the *same*
provider is legitimate — specifically "a queue drawing from **two Plex profiles** … which the
editor already allows and which is *not* mixing".

**Checked before answering: that case is not implemented.** Nothing in the engine reads a
block's `profile`. The only fields any consumer touches are `resolveSingle().provider` and
`.libraries`; `block.profile` appears exclusively in serialization
(`sets.ts` `writableBlocks`). Meanwhile the editor writes the set-level `requires_profile`
from a state variable that no control in the modal ever sets on the multi-block path.

So a second block does exactly one thing: its libraries get unioned into the same `sections`
list. Which is what ticking more checkboxes on the first block already does.

Presented with that, the owner chose removal over implementing per-block profiles.

## Why

- **The button promised a capability that did not exist.** A second source that silently
  contributes nothing but a library union is worse than no button — it invites a
  configuration whose second half is inert, which is the same class of fault as the Kavita
  block that nothing ever read.
- **Removing the affordance is not removing the shape.** The 2026-08-13 argument for keeping
  the list as storage still holds in full: it costs nothing while unused and would be a
  migration to reintroduce. Only the UI claim goes away.
- **If two Plex profiles per queue is ever wanted, it is engine work**, not a button. It
  means threading per-block `profile` through a selection path that is gated by the golden
  parity corpus, and it deserves its own change with its own gates.

## Consequences

- `ProviderBlock.tsx` still renders N blocks and still switches every block's provider
  together; it simply has no "add" entry point.
- A user who already has a two-block set sees it, and can remove the extra block.
- The provider CONTROL rule from
  [2026-08-13-provider-block-repeats-and-picks-its-control](2026-08-13-provider-block-repeats-and-picks-its-control.md)
  (none at one provider, segmented at two, listbox at three+) is unaffected.

## Evidence

- Owner quote above, 2026-08-15.
- The unimplemented case, read off the tree the same day: no consumer of `block.profile`
  outside serialization; `sets.ts` writes `requires_profile` from unedited state on the
  multi-block path.
