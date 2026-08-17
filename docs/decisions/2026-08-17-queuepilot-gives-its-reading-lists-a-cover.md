# QueuePilot puts its own artwork on the reading list it builds

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** ui / provider seam
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [2026-08-15-the-reading-list-is-rebuilt-not-appended](2026-08-15-the-reading-list-is-rebuilt-not-appended.md),
  [2026-08-15-a-queue-wears-its-providers-colour](2026-08-15-a-queue-wears-its-providers-colour.md)

## Decision

**`materialize()` uploads a cover for the set's Reading List, and it is the ONE part of that
artifact that is not rebuilt per launch.** The artwork is written when the list is created, or
when an existing list is still wearing Kavita's own (`coverImageLocked: false`), and never
again — an uploaded cover sets that flag and Kavita stops regenerating one.

The design: the app mark on near-black, in **Kavita green `#4AC694`** rather than QueuePilot's
amber, over the set's human label in the design system's heading face. A Kavita queue wears
its provider's colour everywhere else in this app; its artifact inside Kavita does too.

**The cover is rendered as SVG by Satori and uploaded as raw base64. Kavita rasterizes it.**

**The list TITLE is untouched** — it still carries the set id (`QueuePilot — manga_webtoons`),
because the title is how `materialize()` finds the list again. The label goes on the artwork
only; renaming the list would strand `/lists/153` and mint a fresh id.

## Context

The owner, 2026-08-17:

> "For the Kavita reading list from queuepilot, can you add a nice cover image for it?"

What he was looking at: Kavita generates a list's cover from the first item and regenerates it
whenever the items change. This list's items change on **every launch** by design, so its cover
was a different interior page of a different webtoon every time — that day, a "STRONG LANGUAGE"
splash page from *Becoming the Monarch*.

Four designs were rendered against the real queue and served over `devshare` per the
[house procedure](../../../agentic/docs/runbooks/ui-design-previews.md) — a brand plate, a 3x3
mosaic of the queue's real covers, a green type poster, and the mosaic blurred under the plate.
He picked the **plate**, and asked for it in `materialize()` rather than as a one-off upload.

## Why these mechanics

- **SVG out, not PNG.** Kavita's upload endpoint rasterizes what it is handed (libvips) and
  stores a 213x320 PNG either way. Handing it SVG means this repo needs no rasterizer —
  no `@resvg/resvg-js`, no `sharp`, no native addon in a bundle that currently externalizes
  nothing. Verified live: a Satori SVG comes back as a correct cover PNG, gradients included.
- **Satori, not a hand-written `<text>` SVG.** Kavita's rasterizer **ignores an `@font-face`
  with a data-URI src** — probed, and the text came back set in the container's DejaVu. Satori
  converts glyphs to PATHS, so the cover is set in Baloo 2 / Outfit regardless of what fonts
  the far side has. It also brings flex layout, which is what wraps a long label without this
  code measuring text by hand.
- **RAW base64, no `data:` prefix.** `POST /api/Upload/reading-list` with
  `{id, url: "data:image/png;base64,…"}` answers **400 Unable to save cover image to Reading
  List**; the bare base64 answers 200. Both spellings were probed on a throwaway list that was
  then deleted. Kavita's own web UI sends the prefixed form to some upload endpoints, so this
  is a trap worth the comment it carries.
- **Fonts are inlined as base64 in a source file.** The runtime image carries ONLY
  `server/dist/index.js`, so a `.ttf` read from disk is a file that is not in the image.
  Inlining is also the only form that behaves identically under `tsx` in dev and the esbuild
  bundle in prod. They are the design system's own faces (SIL OFL) as static per-weight TTFs
  subset to latin — `@charcuterie/tokens` ships woff2, which Satori does not parse, and
  decompressing those yields a variable font whose `name` table Google subset away
  (satori's opentype fork throws on its `fvar` axis names).
- **Best-effort, like the stale-item clear.** A cover is decoration and a launch that dies for
  want of one is a dead card. The failure is logged and the lineup still goes on the list.

## Consequences

- **The server bundle grows ~956 KB** (2673 → 3628 KB): Satori and its asm-yoga, plus ~110 KB
  of inlined font. That is the price of correct typography with no native dependency, on a
  container image, paid once.
- Every Kavita queue gets artwork on its first launch after deploy, including ones that do not
  exist yet. Existing lists heal on their next launch.
- **Changing the design later needs a manual unlock.** Once a cover is uploaded the list is
  locked and this code will not touch it again, so a new design means clearing the flag (or
  deleting the list) — deliberate: it is what stops the artwork churning per launch.
- The live `manga_webtoons` list (`/lists/153`) was given this cover by hand on the day, from
  this same code path, so what is on it is what the app produces.

## Evidence

- Owner quote above, and his pick out of four rendered options, 2026-08-17.
- Live probes on throwaway reading lists, all deleted afterwards: `data:`-prefixed upload → 400;
  raw base64 → 200 with `coverImageLocked: true` and Kavita's derived primary/secondary colours;
  SVG accepted and rasterized; `@font-face` data-URI ignored by the rasterizer.
- The new gates in `e2e/kavita-provider-test.ts` fail on the pre-change code (checked by
  disabling the upload branch): a new list gets no artwork, an unlocked list keeps Kavita's,
  and nothing is attempted at all.
- Screenshot of the live list after a real launch rebuilt its items: the cover survived.
