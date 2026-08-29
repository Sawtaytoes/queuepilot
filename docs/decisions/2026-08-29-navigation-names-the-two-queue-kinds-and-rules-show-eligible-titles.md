# Navigation names the two queue kinds, and Rules show eligible titles

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** Product naming / UI
- **Supersedes:** —
- **Superseded by:** —
- **Builds on:** [kind is Picks or Rules](2026-08-23-kind-is-picks-or-rules.md)

## Decision

Primary navigation and page headings use the full plural names **Picks queues** and
**Rules queues**. The shorter **Picks** and **Rules** remain the product-kind badges where
the surrounding screen already says that both are queues.

The Rules page calls the generated result **Eligible titles** and calls its side panel
**Eligibility filters**. It does not call either one a pool. **Random pool** remains the
name of the unordered lane inside a Picks queue.

## Context

The new navigation rail removed the old management-page context. Its bare **Picks** and
**Rules** labels no longer said what those destinations contain. The Rules page then used
**Rules queue**, **Eligible rewatch pool**, and **Pool filters** on one screen, while Picks
already uses **Random pool** for a different concept.

The owner asked:

> "Rename these sidebar nav items 'Picks Queues' and 'Rules Queues' or something because
> it's not clear anymore."

> "The Rules page says 'Pool filter'. Maybe we should do Picks Pool and Rules Pool? But Pool
> here is a bit confusing. Is there a better name we can use?"

## Why

- **Picks queues** and **Rules queues** preserve the two settled product names and restore
  the noun the rail no longer supplies.
- **Eligible titles** names the generated result without creating a second meaning for pool.
- **Eligibility filters** says that the controls decide which titles may appear.
- **Random pool** remains useful because it contrasts directly with **Priority queue** inside
  one Picks queue.

## Evidence

- Owner quotes above, 2026-08-29, current conversation.
- `2026-08-23-kind-is-picks-or-rules.md` defines the full singular names **Picks queue** and
  **Rules queue**, and says not to spend **pool** on both the product type and a lane.
