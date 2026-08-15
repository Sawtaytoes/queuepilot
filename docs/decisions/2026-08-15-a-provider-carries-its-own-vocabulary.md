# A provider carries its own vocabulary — "Play" is not a universal verb

- **Status:** Accepted
- **Date:** 2026-08-15
- **Type:** architecture / ui
- **Supersedes:** —
- **Superseded by:** —

## Decision

**Each provider declares the WORDS its medium is described in**, and every piece of UI copy
that names an action or a count reads them instead of hardcoding Plex's:

```ts
interface ProviderVocabulary {
  verb: string    // "Play"  / "Read"
  unit: string    // "episode" / "chapter"
  units: string   // "episodes" / "chapters"
  member: string  // "show" / "series"
  done: string    // "watched" / "read"
}
```

Served on `/api/providers`, and **carried on every set** beside `delivery`, so no screen has
to re-join a set to the provider list to decide between "Play" and "Read".

**A provider this build does not recognise gets Plex's words**, so an unknown backend renders
exactly what it rendered before the field existed — never a blank label.

**`MediaUnit` gains `volume`, as a PER-ITEM refinement of `chapter`.** One Kavita library
holds volume-based manga beside chapter-based webtoons, so the provider declares `chapter` and
an individual item corrects it. This is the one place a unit is not a provider-level fact.

## Context

The owner, 2026-08-15, on a tile in the live Kavita queue:

> "It says 'Play' when I'm going to read. We should have some metadata for the kinds of
> providers."

`delivery` (`push` | `pull`) already existed and was already doing its job — the queue-level
button correctly said `Open ↗` rather than `Play on ▾` on that very queue. It was not enough,
and the gap is instructive: **`delivery` is how a lineup STARTS; the vocabulary is what the
medium is CALLED**, and they are different questions. A screen that knows only the first still
says "Play “The Sword-Eating Swordmaster” now", asks a reading channel how many *episodes each
show plays per visit*, and tags a manga entry `3 eps`.

## Why

- **It is the same seam, one level up.** The provider ADR made backends implement one
  media-neutral interface so the engine never branches on `kind`. The UI had no equivalent, so
  its copy branched on nothing at all — it just assumed. Declaring the words is what lets the
  frontend follow the same rule.
- **The fallback is what makes it safe.** Every consumer takes Plex's words when a set has no
  vocabulary, so a stale cached registry response degrades to today's rendering rather than to
  `undefined`.
- **It is labels only.** Anything a provider *does* stays on `Provider` (server-side).
  Keeping the label layer separate is what lets it be serialized to a browser that cannot call
  `materialize()`.

## What it fixed, concretely

| | before | after |
| --- | --- | --- |
| tile ▶ tooltip | `Play “Alice in Borderland” now` | `Read “Alice in Borderland” now` |
| channel subtitle | "how many episodes each show plays per visit" | "how many chapters each series contributes per visit" |
| entry tag | `3 eps` | `3 ch` |
| entry panel | "Episodes queued per play" | "Chapters queued per turn" |
| a whole manga volume | `Ch -100000`, then `Vol 1 · Volume 1` | `Vol 1` |

## Consequences

- **New provider ⇒ one map entry** in `providers/config.ts`, no component edits.
- `SetRegistryCommon` carries `vocabulary` and `provider_kind`. The web mirror is
  `ProviderVocabulary` in `web/src/lib/types.ts` and `PLEX_WORDS` is the shared fallback.
- The sentence templates deliberately use neutral verbs ("comes up", "contributes") so they
  need no per-provider branch of their own — only the NOUNS come from the vocabulary.

## Evidence

- Owner quote above, 2026-08-15, with a screenshot of the tooltip.
- The `-100000` sentinel and the volume shape verified live against `kavita.example.com` the
  same day; see
  [2026-08-15-a-curated-reading-queue-is-its-entries](2026-08-15-a-curated-reading-queue-is-its-entries.md).
- Verified in the running app: Plex path unchanged, Kavita path reading-worded.
