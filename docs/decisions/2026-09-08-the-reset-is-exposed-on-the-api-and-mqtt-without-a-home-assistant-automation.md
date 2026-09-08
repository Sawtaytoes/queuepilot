# The reset is exposed on the API and MQTT, and QueuePilot ships no Home Assistant automation

**Status:** Accepted
**Date:** 2026-09-08
**Type:** architecture / integration surface / scope
**Supersedes:** —
**Superseded by:** —

## Decision

Clearing a queue's watched state is one server function. It is reachable three ways, and the
third is deliberately left empty.

1. **The Actions menu** in the web UI
   ([record](2026-09-08-a-destructive-queue-action-lives-in-an-actions-menu-behind-a-confirm.md)).
2. **The HTTP API** — the route the menu itself calls. No second implementation.
3. **An MQTT command topic**, alongside the existing `queuepilot/cmd/*` topics, so an NFC
   card, a voice command or somebody else's scheduler can do the same thing.

**QueuePilot ships no Home Assistant automation, and no Home Assistant dependency.** The
topic is a seam other people can use. What is published on it, and when, is not this repo's
business.

The reset date ([record](2026-09-08-a-queue-can-clear-its-own-watched-state-on-a-date-each-year.md))
already covers the household's own case, so nothing needs to publish on this topic for the
Halloween queue to work.

## Context

The house rule for this workspace is that Home Assistant owns schedules and services talk
over MQTT. Applying it literally here would have put the seasonal reset in a Home Assistant
automation. The owner rejected that, and named the reason:

> "Option 4, having the ability to trigger this via the API, is great. […] I'd love to have
> all that automation in QueuePilot, but I'm not sure if it should go there or an external
> service."

and then:

> "I know I put all these automations in Home Assistant, but this one seems very much like it
> belongs in QueuePilot. […] it feels like tight coupling, and wouldn't work well for others
> using QueuePilot."

## Why

- **This repo is public.** A feature that only works with a Home Assistant install is a
  feature most people who clone it cannot use. That is the deciding reason.
- **The house rule is about cross-service bridges, not an app's own data.** It exists to stop
  new REST and shell bridges between services. A queue clearing its own rows is one app
  maintaining its own state. The workspace record that narrows this is
  `agentic:docs/decisions/2026-09-08-an-apps-own-data-maintenance-is-not-the-ha-schedule-rule.md`
  (a sibling workspace repo, not on GitHub, so it is named rather than linked).
- **The topic costs almost nothing once the function exists.** Exposing a seam is cheap;
  depending on a consumer is not.

## Evidence

Owner, 2026-09-08, quoted above.
