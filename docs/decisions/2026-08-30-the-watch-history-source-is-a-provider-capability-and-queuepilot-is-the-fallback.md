# The watch-history source is a provider capability, and QueuePilot is the fallback

- **Status:** Accepted
- **Date:** 2026-08-30
- **Type:** architecture / playback semantics / durable data
- **Supersedes:** —
- **Extends:** [Provider watch history is the default, and entries can opt out](2026-08-30-provider-watch-history-is-the-default-and-entries-can-opt-out.md)
- **Superseded by:** —

## Decision

**Watch history has three possible sources, and which ones are available is a property of the
provider, not of the app.**

1. **The provider** — Plex, Kavita. The provider is asked, live, at the moment the answer is
   needed.
2. **QueuePilot** — the queue-owned completion ledger that already exists.
3. **An external history service** — a third party that observes plays QueuePilot cannot see.
   Optional, opt-in, configured per deployment. None is adopted today.

**A provider declares whether it can report watch history.** A provider that cannot report it has
no `provider` option to offer, and its queues own their history in QueuePilot by default. This is
not an opt-out and there is nothing to opt out of: no other source exists unless one is
configured.

The stored field from the extended record gains a third value:
`watch_history: provider | queue | external`. Resolution order is unchanged and now ends in a
capability check:

```
entry override  →  queue default  →  provider capability
```

`provider` resolving against a provider that cannot report watch history resolves to `queue`. It
is not an error and it does not refuse; the request is for the truest available source, and for
that provider the truest available source is the local ledger. A queue whose provider cannot
report history may still be set to `external` explicitly.

**Catalog and history are separate seams.** A provider that answers "what exists" says nothing
about "what was watched", and the reverse. A catalog source is not promoted to a history source
because it happens to be configured.

## Context

The question arrived as a request to add a subscription streaming service — Disney+ — as a
QueuePilot provider, for someone who subscribes to several services rather than running a Plex
library.

Three separate things were being called "source of truth" and they have three different owners.
The **queue** — what plays next — is QueuePilot's, for every provider, and nobody disputed it. The
**catalog** — what exists to pick from — belongs to the provider or to a metadata service. Only
**watch history** was in dispute, and the dispute dissolved once it was separated from the other
two.

The extended record already settled the two-source case and made provider history the default,
because a play started directly in Plex must not be invisible. That reasoning depends on the
provider being *able* to answer. A subscription streaming service cannot: it publishes no API, it
issues no key, and its playback is DRM-locked, so nothing outside its own app can observe a play.
See [streaming-service feasibility](../streaming-service-feasibility.md).

So the default flips, and it flips because of a fact about the provider rather than a preference
about the app.

## Why

- **The safe default is the one that cannot silently be wrong.** For Plex, that is Plex: it sees
  plays started from any client, including the ones that bypass QueuePilot entirely. For a
  service that reports nothing, a QueuePilot ledger that is only as good as its marking still
  beats a source that is always empty.
- **The capability belongs on the provider because that is where the fact lives.** Encoding it as
  a per-queue setting would invite a queue to be configured into a state its provider cannot
  serve, and the failure would surface as an empty history rather than as a refused save.
- **The third value is needed even though nothing fills it today.** An external history service is
  the only way a streaming play started outside QueuePilot can ever be seen. Leaving the field
  two-valued would make adopting one a migration rather than a configuration.
- **Nothing changes for the providers that work.** Plex and Kavita resolve exactly as they do
  today. The existing manual controls — mark complete, undo, attach the item playing now — are
  what a queue-owned streaming entry needs, already built, for a reason that had nothing to do
  with streaming.
- **The seams stay separate because the sources are unrelated.** The metadata service that lists a
  service's catalog has no access to any account, and an account-linked history service carries no
  authoritative catalog. Conflating them would tie two independent credentials to one switch.

## Consequences

- The provider interface gains a capability flag. A provider that cannot report watch history
  must say so rather than returning an empty history, which is indistinguishable from "nothing
  watched yet".
- The queue and entry watch-history controls hide or disable the **Use provider watch history**
  option when the queue's provider cannot serve it, and say why. A control that cannot work must
  not be offered.
- `external` needs a configured service before it can be selected. Until one is adopted the value
  exists in the schema and is unreachable in the interface.
- Accuracy of a queue-owned streaming history depends entirely on the play being marked. Whether
  that marking can be automatic is a question about the *player*, not about the provider, and is
  answered in
  [a streaming service is a catalog read and a launch hand-off](2026-08-30-a-streaming-service-is-a-catalog-read-and-a-launch-hand-off.md).

## Evidence

Owner, chat 2026-08-30, on the default:

> "if there's no access to watch history somewhere, then QueuePilot needs to be in charge by
> default"

> "That means we'll have 3 sources of watch history: 1. The provider itself (like Plex). 2.
> QueuePilot. 3. Trakt"

And on why the Plex default stays exactly as it is:

> "For any Plex media, Plex can safely keep watch history unless you get into a weird opt-out
> situation"

That opt-out is the case the extended record already covers, and it is unchanged by this one.
