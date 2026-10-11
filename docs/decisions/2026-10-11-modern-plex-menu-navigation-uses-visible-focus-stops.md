# Modern Plex menu navigation uses visible focus stops

- **Status:** Accepted
- **Date:** 2026-10-11
- **Type:** Performance / device control
- **Supersedes:** —
- **Superseded by:** —

## Decision

On the modern Plex primary navigation rail, count the visible, enabled focusable controls
between the focused control and Account using their vertical bounds. Send that measured
number of UP events in one bounded input command, then read the actual landing before
opening the submenu. Replan if events were missed. Exclude headings and separators; use
single arrows when geometry is missing or ambiguous. Count individual arrows against the
existing navigation budget.

Check onboarding and the profile picker from one accessibility snapshot in the driver's
preflight. Preserve the legacy adapter, fresh profile commit guard, signed-in navigation
verification and independent playback account audit. These changes extend the existing
[visible picker batching](2026-10-09-modern-profile-navigation-batches-visible-distance.md).

## Context

The profile tiles already supported measured batches, but getting to the picker still
sent one menu arrow per screen dump. The modern preflight also dumped the screen separately
for onboarding and the picker. A hierarchy dump dominates each of these steps.

## Why

Visible focus stops describe the current menu without hardcoding its order or using child
indices that include non-focusable headings. Landing verification handles missed events
without guessing whether Account or Switch User is selected. One preflight snapshot avoids
both duplicate idle-window waits and two different views of the same screen.

## Evidence

Owner request in chat `af086239-eb25-442f-a6f7-35dbdcf1752d`:

> "We need to figure out why it's so slow to use Plex now and speed that up if possible."

Unit tests cover menu batches, headings, missed events, individual-arrow budgets and
ambiguous geometry. The three-stop opening fixture needs four screen dumps instead of six.
Onboarding and picker preflight together require one dump instead of two. The existing
legacy FSM and independent account-audit harnesses pass.

Live comparison on the dedicated test profile, starting with the Home menu control focused:
the old adapter completed in 24.316 seconds with eight dumps; the updated adapter completed
in 17.385 seconds with six dumps (28.5% faster). Successful hierarchy reads typically took
1.8–2.3 seconds; compressed dumps did not consistently reduce that delay. This compares
menu opening and same-profile commit, not total queue startup or cross-profile travel.
