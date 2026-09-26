# Shared Plex libraries use the queue library scope

- **Status:** Accepted
- **Date:** 2026-09-26
- **Type:** product rule / UI / search
- **Supersedes:** —
- **Superseded by:** —

## Decision

The queue settings offer checkboxes for the libraries on each shared Plex server available to
the selected Home profile. Each server sits in an accordion. Checked shared libraries join the
default Add search alongside the home libraries. An unchanged queue searches only home
libraries, so adding this feature does not make every search fan out to every shared server.
A queue saves the selections by Plex server id; the home server's existing `sections` setting
is unchanged.

The queue search keeps its Server picker for a search on one server. On that explicit server
path, no boxes checked means every library granted there, matching the local-library rule.
Its Library picker and server-side search obey a named selection. The server intersects it
with the profile's current Plex grant. Changing the queue profile clears the old shared
selections, since the new profile has a different grant.

## Context

The multi-server queue feature added a Server picker to the queue's Add search. The queue
settings still showed shared libraries as a read-only list. The owner opened the settings
and could not select shared libraries the way local ones can be selected.

## Why

The source settings are where a queue declares which libraries it searches. Putting only a
temporary library choice in the Add search left the shared side with no saved answer. The
server id is part of the scope because library ids can repeat across servers.

## Evidence

- Owner, 2026-09-25/26: “Huh, can we just fix it to work like the local libraries?” Chat
  `25db5d8f-617e-4b07-a701-b8c4fda89f30`.
- Owner, 2026-09-26: “Yes, search local and shared together” in answer to whether checked
  shared libraries should join the default Add search, same chat.
- `e2e/shared-plex-search-ui-test.ts` saves a synthetic selection, reopens the editor and
  verifies that the queue search excludes the other shared library.
