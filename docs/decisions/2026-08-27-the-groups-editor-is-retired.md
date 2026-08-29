# The Groups editor is retired

- **Status:** Accepted
- **Date:** 2026-08-27
- **Type:** product scope / frontend
- **Supersedes:** [The landing filters by PEOPLE, and the group chips go](2026-08-26-the-landing-filters-by-people-and-the-group-chips-go.md) §5's decision to keep the Groups editor; [The roster is edited in the app, not in a config file](2026-08-26-the-roster-is-edited-in-the-app-not-in-a-config-file.md) §1's Groups-editor link and §2's group-label editing
- **Superseded by:** [People groups use explicit rules and the queue audience is one vertical list](2026-08-29-people-groups-use-explicit-rules-and-vertical-audience-editor.md)

## Decision

**1. The user-facing Groups editor is removed.** QueuePilot no longer exposes a Groups modal,
an **Edit groups** control, or a Groups section in the People editor. The client no longer
loads group-editor data into its general snapshot or keeps overlay state for that modal.

**2. The server-side group model remains as compatibility data.** QueuePilot keeps the groups
file, the group API, group membership, group claims on sets, and group members in queue
audience rows. These records still express `min_present` audience rules and resolve the
provider profile used for playback. This change does not delete or rewrite live group data.

**3. The legacy `/g/<id>` route remains a redirect to `/admin`.** It preserves old links while
the app no longer presents a group page or group editor.

**4. A full group-model retirement needs a separate migration.** That work must convert every
group-backed queue audience into an equivalent people or provider rule, preserve playback
profile selection, and define the treatment of existing group claims before it removes the
server API or storage.

## Context

The owner requested this change after the landing filter moved from groups to people and
provider categories:

> "Remove this groups thing from QueuePilot. I don't think we need it anymore now."

The request names the Groups feature as a product surface. It does not define a safe data
migration for the group-backed queue audience model.

## Why

- The Groups editor is no longer needed for the landing workflow. People and provider filters
  now answer that discovery question without maintaining a second set of labels.
- Group data is still load-bearing for current queues. A group can mean "at least one of these
  people" and can select the one provider profile a queue uses.
- Removing the editor removes the unused maintenance surface without silently changing queue
  audiences or playback accounts.

## Evidence

- Direct user quote: "Remove this groups thing from QueuePilot. I don't think we need it anymore now."
- Chat id: not exposed in this T3 Code session.
