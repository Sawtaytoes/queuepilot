# The README is an entry point, not a decision log

- **Status:** Accepted
- **Date:** 2026-08-30
- **Type:** documentation
- **Supersedes:** —
- **Superseded by:** —

## Decision

`README.md` is the short entry point for QueuePilot. It contains:

- a concise description of the product;
- a prominent link to the Docker installation and provider setup guide;
- the commands that run the published container;
- the commands that run the source checkout; and
- links to the focused documentation.

Detailed provider configuration lives in `docs/setup.md`. Product history, naming rationale,
rejected alternatives, behavior rationale and architecture decisions live in focused documents
under `docs/` and `docs/decisions/`. They do not accumulate in the README.

## Context

The README had grown to 382 lines. Its opening discussed the completed rename from
`plex-channels`, the meaning of the QueuePilot name, rejected names, two household-specific
experiences, detailed selection rules, the repository layout and every provider's setup. A
reader who wanted the Docker command had to pass the internal history first. The provider
instructions were useful, but they needed their own stable address.

## Why

A README must answer what the project does and where to start. A setup guide must carry enough
detail to complete an installation. A decision record must preserve why a choice was made.
Keeping those purposes separate makes the first page easier to scan without deleting the setup
instructions or the decision history.

## Evidence

The owner said: *"I want the README tightly focused about how to run it. The docs about how to
configure it etc should be called out at the top and linked to from there for people looking for
'setup instructions' with the Docker container."* (T3 Code chat, 2026-08-30.)

