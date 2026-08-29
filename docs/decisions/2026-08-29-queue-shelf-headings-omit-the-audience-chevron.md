# Queue shelf headings omit the audience chevron

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** UI
- **Supersedes:** [Queue shelf headings use avatar badges and one baseline](2026-08-29-queue-shelf-headings-use-avatar-badges-and-one-baseline.md)
- **Superseded by:** —

## Decision

The `/queues` shelf heading keeps the queue title, item count, lane summary, audience avatar
badges and audience names. It omits the provider kind label and the small audience chevron.
The title, badges and names remain baseline-aligned.

## Context

After reviewing the restored avatar badges and baseline alignment, the owner said:

> "Great! Looks good. The little chevron can go away though. No longer needed."

## Why

- The avatar badge and name identify the queue audience.
- The chevron adds no information after the audience badge was restored.
- Removing the redundant glyph makes the heading shorter without changing its meaning.

## Evidence

- Owner quote above, 2026-08-29, current conversation.
- `e2e/ui-test.ts` checks that shelf headings have avatar badges, omit repeated labels and keep
  the title, link and audience row on one baseline.
