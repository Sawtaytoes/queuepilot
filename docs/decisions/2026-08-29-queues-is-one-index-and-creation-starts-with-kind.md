# Queues is one index, and creation starts with kind

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** Product / routing / UI
- **Supersedes:**
  - [The Picks page is `/picks` and starts collapsed](2026-08-29-the-picks-page-is-picks-and-starts-collapsed.md) (route only; collapsed shelves remain)
  - [Navigation names the two queue kinds, and Rules show eligible titles](2026-08-29-navigation-names-the-two-queue-kinds-and-rules-show-eligible-titles.md) (navigation only; the Rules terminology remains)
- **Superseded by:** [Rules and Picks use the same collapsible queue region](2026-08-29-rules-and-picks-use-the-same-collapsible-queue-region.md) (Rules-card clause only)

## Decision

`/queues` is the canonical index for every Picks and Rules queue. Primary navigation calls the
destination **Queues**. `/picks` and the bare `/channels` address remain replace rewrites to the
index. A Rules queue detail keeps its direct `/channels/<id>` address and no longer carries a
queue picker.

Creating a queue starts with a **Queue type** choice. **Picks** describes a queue whose titles a
person chooses and arranges. **Rules** describes a queue whose eligibility filters generate its
titles. The selected kind then opens its existing editor.

The index keeps the existing people and provider filters, with space between the filter picker
and the toolbar above it. Each Rules card opens one Rules detail. Each Picks shelf opens its
familiar two-lane vertical detail.

## Context

Separate Picks and Rules destinations made the same product concept occupy two navigation rows.
The Rules detail then repeated the index as a selector inside one selected queue. Creation also
asked for queue settings before it established which of the two stored kinds was being made.

The owner asked for one Queues destination, `/queues` as its route, one queue per detail page,
and Picks or Rules as the first creation choice.

## Why

- The index answers which queue to open before a detail page loads.
- One navigation destination matches the shared queue data model.
- The first creation choice determines which editor and membership model apply.
- Direct detail routes remain bookmarkable.
- Legacy rewrites preserve existing links without keeping duplicate destinations.

## Evidence

Owner, 2026-08-29, current conversation and six attached images.
