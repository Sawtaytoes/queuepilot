# The provider block repeats, and its control is chosen by measurement

- **Status:** Accepted
- **Date:** 2026-08-13
- **Type:** ui / architecture
- **Supersedes:** —
- **Superseded by:** —

## Decision

**The whole `{provider, profile, libraries}` block repeats.** A queue holds N of them; each
block is homogeneous; mixing falls out of composition rather than out of a multi-select
control.

**The provider control is chosen at runtime, by how many providers are connected:**

| Connected providers | Control |
| --- | --- |
| 1 | **None.** The block renders with no provider row at all. |
| 2 | **`SegmentedControl`** — every option visible without opening anything. |
| 3 or more | **`SelectListbox`** — the long-term shape. |

This is a rule evaluated in `ProviderBlock.tsx`, not a one-time pick, because providers are
added at **runtime** from the connector surface. The rule is the owner's own conditional
applied where the condition can actually be evaluated.

## Context

The owner revised the model twice — `Listbox`, then "Combobox with multiselect" — and then
arrived at the repeating block and **withdrew the control question himself**:

> "So I think this whole section needs to be able to be added multiple times. I might be
> wrong on the list/combobox thing"

So the control went through the house mock-then-pick procedure
([runbook](../../../agentic/docs/runbooks/ui-design-previews.md) ·
[decision](../../../agentic/docs/decisions/2026-07-25-preview-ui-changes-as-served-html.md)):
four panels served over `devshare`
([preview](../previews/2026-08-13-provider-blocks.html)). He answered:

> "Option B if they fit; otherwise, Option A as that's a more long-term fix."
>
> "C1 is good when only 1 provider."

## Why

**"If they fit" is a measurement, so it was measured** rather than eyeballed. Natural widths
against the real `#setmodal` box (`width: min(440px, 92vw)`, `padding: 20px 22px` —
`app.css`), giving 396px of content on desktop and 315px inside a 390px phone:

| providers | segmented, desktop | segmented, phone |
| --- | --- | --- |
| 2 | 264px — fits | 264px — **fits** |
| 3 | 371px — fits | 371px — **overflows** |
| 4 | 470px — overflows | overflows |
| 5 | 560px — overflows | overflows |

`SelectListbox` is a flat **258px** at any count.

So the threshold is **two**. Three providers already overflow a phone, and this app has a
real phone layout with a CI gate against horizontal scroll — a control that only fits on a
desktop is not a control that fits. That is exactly the case the owner's fallback names, and
it is why the fallback is the listbox rather than a scrolling segmented row.

**One provider renders nothing at all**, which is the strongest form of C1: with nothing to
choose there is nothing to ask, and every existing Plex-only install sees *no change
whatsoever* in the editor. The "+ Add another source" button is likewise hidden until a
second provider exists, because a second block could not draw from anything the first cannot.

**The profile field is provider-scoped**, and today's copy was Plex-only. "Locks this queue
to a Plex Home profile — a scan waits (and switches the Shield)…" is meaningless for a pull
provider: there is no Shield and no scan, and the real concept is *which Kavita user owns the
reading list* — which fails **silently**, with an empty reader and no error
([feasibility §6](../kavita-feasibility.md)). Label, help text and options therefore come from
the provider. The UI branches on `delivery` (`push` | `pull`), **never on the provider's
name**, so a third backend needs no UI change.

## Consequences

- **Storage is a list from day one** — never a scalar, never provider identity encoded into
  library ids ([`server/src/providers/blocks.js`](../../server/src/providers/blocks.js)).
- **A single Plex block is still written through the legacy `sections` / `requires_profile`
  fields.** The `providers:` key only appears once it is genuinely needed, so an existing set
  is byte-identical on disk after an unrelated edit. That is what makes this additive rather
  than a migration that rewrites every user's config the first time they rename a queue.
- **`sections` is kept in sync with the Plex blocks' libraries** even when blocks are written,
  because the engine still resolves Plex through `queue_sections` / `episodic_sections`.
  Letting the two disagree would give a set whose editor says one thing and whose playback
  does another — the silent-divergence class `requires_profile` already taught this codebase
  to avoid.
- **Switching a block's provider clears its libraries and profile**, since both are scoped to
  the provider that was replaced.
- **What a MIXED queue hands off is still undecided and still refuses to run** — see
  [`docs/kavita-open-decisions.md`](../kavita-open-decisions.md). The UI stores N blocks
  today; `resolveSingle()` throws and the launcher answers 501 rather than guessing.

## Evidence

- Widths measured with Playwright against the built stylesheet, 2026-08-13; the table above
  is reproduced in `ProviderBlock.tsx`'s header so the threshold is defensible at the point
  someone would change it.
- Owner quotes: the two lines above, 2026-08-13.
- Rendered and verified in the running app (`e2e/dev.sh`, both providers configured):
  segmented at two providers, per-block profile copy switching to "Reads as user" for Kavita,
  and a save round-trip writing a two-block `providers:` list to `sets.yaml`.
