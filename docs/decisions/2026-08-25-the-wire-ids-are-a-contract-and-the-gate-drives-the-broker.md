# The wire ids are a CONTRACT, and the gate drives the broker

- **Status:** Accepted
- **Date:** 2026-08-25
- **Type:** testing / privacy / operations
- **Supersedes:** —
- **Superseded by:** —

## Decision

The set ids on the wire are gated by `e2e/nfc-wire-contract-test.ts`, which boots the real
server against a **real MQTT broker** and publishes the exact payload `script.control_plex`
puts on `queuepilot/cmd/session/start`.

Three rules follow from it:

1. **A wire id is asserted BY NAME, in both directions.** Twenty set ids and sixteen queue
   ids, nothing missing and nothing extra. A count of twenty passes even if all twenty were
   replaced.
2. **The topics are read off the BROKER, not off `env.ts`.** The gate records the app's own
   `subscribe` at the broker and compares it against the literal strings Home Assistant
   publishes on. Reading the constant back would be the app agreeing with itself, and a
   renamed topic constant typechecks perfectly while taking every card with it.
3. **The fixture does NOT name the live ids.** `e2e/fixtures/wire-contract.sets.yaml` mirrors
   the live registry's *shape* — twenty ids, sixteen queues, the same profile gates, an
   underscore, a trailing digit, a three-word id — under this repo's placeholder cast. The
   contract is gated publicly; the live twenty are verified against the live book of record and
   the result is recorded in the private workspace.

## Context

A physical NFC card carries a set id. `automation.plex_nfc_scanner` maps a tag to
`{plex_action, kind, set, profile}`, `script.control_plex` publishes
`{"set": "<id>", "kind": …, "profile": …, "via": "ha"}`, and this app looks that id up in the
registry.

Since 2026-08-23 the path between the broker and the row has been rebuilt eight times: a store
seam, SQLite as the book of record, a people table, twelve absorbed board-game tables, a
rewritten queue model with a schema migration, a Tonight surface, an activity → provider map
and a result card. `store-backend-parity-test.ts` pinned six ids by name **through the store**.
Nothing at all covered the broker half.

## Why

- **The failure is silent.** Nothing in the chain reports a miss to a person. The card is
  tapped, the theater does not start, and the evidence is a log line in a container.
  Every other class of bug in this repo eventually shows up on a screen; this one does not.
- **A count is not a check.** `sets.id`, `queues.set_id` and `groups.id` are TEXT primary keys
  precisely so no translation table sits between a piece of cardboard and the queue it plays.
  The corresponding test has to be an exact-string comparison or the property is untested.
- **The broker is the part that was untested, so the broker is what the gate drives.** Calling
  `session.startSession()` directly would skip the subscribe, the payload parse, the topic
  constants and the discovery publish — which is most of what a card actually depends on.
- **The gate has to be able to fail.** An id that is NOT in the registry must produce
  `set '<id>' not enabled`. Without that assertion the suite would pass just as happily against
  a server that had stopped answering.
- **And the ids cannot be in this repo.** This is public. Five of the live twenty carry
  household first names, and the whole history was rewritten on 2026-08-17 to remove exactly
  that
  ([placeholders](2026-08-17-the-repo-is-public-so-people-hosts-and-ips-are-placeholders.md)).
  Writing them into a fixture "because they are unavoidable" would republish them. They are not
  unavoidable: what the gate needs is twenty ids of the same shape, and a placeholder set is
  the same test.

## Evidence

- Live registry, 2026-08-25: twenty sets, sixteen with curated queues, four rules pools. Every
  one of them reachable — verified against `https://queuepilot.octen.dev/api/sets` and against
  `/config/queuepilot.sqlite` directly. Recorded privately.
- `automation.plex_nfc_scanner`'s `tag_command_map`: twelve tags, eleven distinct set ids, plus
  two `set: auto` buttons and one advance. Read on 2026-08-25.
- The gate's own run: 45 assertions, all passing, including the negative one.

## How to apply

- Changing a set id, a topic constant or the discovery object id? This gate is the thing that
  tells you what else has to move — and the answer usually includes a piece of plastic on a
  wall and a Home Assistant automation, which is why none of them should change.
- Adding a fixture id? Use the placeholder table in
  [the 2026-08-17 record](2026-08-17-the-repo-is-public-so-people-hosts-and-ips-are-placeholders.md).
- Verifying the LIVE ids? That is a run against the live book of record, and its result belongs
  in the private workspace, not in a commit here.
