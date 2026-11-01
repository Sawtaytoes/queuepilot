# A pinned player ID outranks its display name

- **Status:** Accepted
- **Date:** 2026-11-01
- **Type:** Playback correctness / device identity
- **Supersedes:** The name-fallback characterization in `e2e/profile-session-observation-test.ts` when a machine identifier is configured.
- **Superseded by:** —

## Decision

When a target has a machine identifier, session telemetry and account observations must
match that identifier. A matching display name cannot override a conflicting identifier.
Name matching remains available when no identifier is configured. Explicit secondary
players never inherit the default player's identity fields.

## Context

A single-player implementation accepted either an ID match or a name match to tolerate
an application reinstall changing its identifier. With multiple targets, two devices can
share a display name. The old fallback can then use another device's playback or profile
as proof for the selected target.

## Why

Device identity determines where commands go and whose watch history a queue updates.
Refusing an ambiguous observation preserves both boundaries. A deployment that pins an
identifier must update it after an application reinstall changes it; it cannot silently
substitute another same-named player.

## Evidence

`accountDevice.test.ts` covers conflicting identifiers with identical display names and
secondary configurations without an identifier. `profile-session-observation-test.ts`
checks the real HTTP observation path. `currentSession` and account verification use the
same predicate. Physical playback and profile tests remain separate from these offline
identity checks.
