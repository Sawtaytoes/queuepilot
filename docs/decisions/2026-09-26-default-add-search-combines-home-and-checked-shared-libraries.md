# Default Add search combines home and checked shared libraries

- **Status:** Accepted
- **Date:** 2026-09-26
- **Type:** product rule / search / UI
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [Shared Plex libraries use the queue library scope](2026-09-26-shared-plex-libraries-use-the-queue-library-scope.md)

## Decision

The default Add search on a Plex queue searches its selected home libraries and every shared
library checked in that queue's settings. It returns one mixed result list. Each result names
its Plex server, and item identity includes the server id so equal rating keys on two servers
stay distinct. Source results are interleaved after Collections so a 30-row dropdown cannot
show only home items when a checked shared library has a match.

An unchanged queue with no checked shared libraries searches only home libraries. The Server
picker remains available for a one-server search. On that explicit path, no boxes checked for
a shared server means every library granted on that server. The combined Library picker names
both the server and the library, since section ids can repeat.

## Context

The first shared-library settings change saved checkboxes, but the default Add search still
searched only the home server. The owner clarified that checked shared libraries must be
searched alongside home libraries without first choosing a server.

## Why

The queue's selected libraries are its search scope. A saved shared-library selection that
does not affect the default Add search requires an extra server choice every time, unlike the
local-library selection it sits beside. Keeping unchanged queues home-only avoids fanning
every keystroke out to all shared servers by default.

## Evidence

- Owner, 2026-09-26: “Yes, search local and shared together.” Chat
  `25db5d8f-617e-4b07-a701-b8c4fda89f30`.
- `server/src/routes/plexMetadataRoutes.test.ts` checks that equal rating keys from home and
  a checked shared server both reach the result. `e2e/shared-plex-search-ui-test.ts` checks
  that the default Add search shows both after the scope is saved.
