# A queue wears its provider's colour; the app's own accent is Charcuterie's

- **Status:** Accepted
- **Date:** 2026-08-15
- **Type:** ui
- **Supersedes:** the accent-override rationale in
  [2026-07-31-frontend-is-react-typescript-vite-tailwind-on-charcuterie-tokens](2026-07-31-frontend-is-react-typescript-vite-tailwind-on-charcuterie-tokens.md)
  (that decision stands; only its Plex-amber-everywhere premise is replaced)
- **Superseded by:** —

## Decision

**The accent intent family is scoped per queue, by its provider's KIND.** A Plex queue is
amber `#E5A00D`; a Kavita queue is green `#4AC694`; anything that belongs to no queue — the
header, "New queue", global focus — is Charcuterie `daylight`'s own indigo.

Implemented as `[data-provider="plex" | "kavita"]` blocks in `web/src/styles/app.css`, with
`data-provider` emitted on the queue page (`#queue`), each Home shelf, each Play landing row,
and the Set modal. There is **no `:root` override any more**: the app inherits the design
system's accent and each queue paints over it.

**The full seven-role family is overridden per provider, never a subset.** That part of the
original reasoning survives intact: a partial override silently mixes brands the moment a
component reaches for a role nobody rewrote.

**Scoped on the provider's `kind`, not its id.** A second Kavita added at runtime from the
connector surface has its own id (`my-kavita`) and must still come out Kavita-green; keying
the stylesheet on ids would drop such a queue back to the neutral accent with no error. The
registry therefore carries `provider_kind` beside `delivery` and `vocabulary`.

## Context

The owner, 2026-08-15, looking at the live app:

> "In the UI, I'd like to covert it to pure Charcuterie and not stylize it to Plex. That OR we
> stylize each queue to match a provider color. That way, it's clear by looking which provider
> you're targetting. What do you think? I like that stylized by color for the 'bold/solid'
> buttons."

Three options were rendered in the REAL app against the real Plex library and live Kavita —
only the accent variables differed — and served over `devshare` per the
[house procedure](../../../agentic/docs/runbooks/ui-design-previews.md):

| | |
| --- | --- |
| **A** | pure Charcuterie, no provider colour anywhere |
| **B** | the whole accent family follows the provider |
| **C** | only solid/bold buttons follow the provider |

He picked **B**.

Note that C was his own stated leaning ("I like that stylized by color for the bold/solid
buttons") and he chose B once he could see the difference — which is the entire reason the
mock-then-pick loop exists. C and B are identical on the landing page, because the only
accent-coloured things there ARE solid buttons; they diverge on the Queues page, where the
accent also carries the entry count, the "1 of 8" collection line and the drag ring.

## Why

- **The old premise expired.** `app.css` justified the override as *"queuepilot's entire
  affordance language … is Plex's amber `#E5A00D`, and it reads as Plex on purpose."* That was
  true when Plex was the only backend. With a second one it makes a brand claim about a
  service that has nothing to do with the queue — the Kavita queue's own button was painted in
  Plex's colours.
- **It answers a question the user actually has.** Every start affordance is a question of
  "what will this talk to". `delivery` already changes the button's shape (`Play on ▾` vs
  `Open ↗`); colour makes the same fact legible without reading.
- **It is the same knob, not a new one.** The app already routed its whole affordance
  language through one intent family. This changes the SCOPE of that override from global to
  per-queue; no component learns anything new, and no component branches on a provider name.

## Colours, and the contrast that constrains them

Each service's own, read from the service — not chosen here. Kavita's came off
`kavita.example.com`'s live stylesheet (`--primary-color`, with its `#3B9E76` / `#338A67` /
`#25624A` shades).

| | measured | |
| --- | --- | --- |
| dark | Plex content `#E5A00D` on base `#131822` | 7.6:1 |
| dark | Plex on-solid `#111111` on `#E5A00D` | 10.4:1 |
| light | Plex content `#7A5300` on base `#F5F7FA` | 6.5:1 |
| dark | Kavita content `#4AC694` on base `#131822` | 8.3:1 |
| dark | Kavita on-solid `#111111` on `#4AC694` | 8.9:1 |
| light | Kavita content `#25624A` on base `#F5F7FA` | 6.8:1 |
| light | Kavita on-solid `#111111` on `#4AC694` | 8.9:1 |

**Kavita's own UI puts WHITE on that green**, which is **2.1:1** and fails outright. The
on-solid ink here is therefore near-black, the same call the Plex amber already made — so a
filled button reads equally well on either provider. Light mode needs a darker green for
*text* (`#25624A`); the fill stays `#4AC694` in both schemes.

## Consequences

- A queue whose provider this build does not recognise reports `provider_kind: ''`, renders
  no `data-provider`, and inherits the neutral accent. That is a legible fallback, not a bug.
- New provider ⇒ two CSS blocks (light + dark) and nothing else. No component changes.
- The Set modal wears the block being **edited**, taken from live state rather than the saved
  set, so switching the source repaints before anything is written — which is what fixes the
  reported oddity of a *Kavita* chip rendered in Plex amber.

## Evidence

- Owner quote above, 2026-08-15.
- Three options rendered in the running app and served over `devshare`; owner picked B.
- Kavita's colour read live off `kavita.example.com` on 2026-08-15, not from memory.
- Verified after the change in the running app: Plex queue `#e5a00d` and unchanged, Kavita
  queue `#4ac694`, page chrome `#5A54E8`.
