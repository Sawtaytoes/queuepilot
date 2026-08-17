# The start button wears its provider's ICON as well as its verb

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** ui / architecture
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [2026-08-15-a-provider-carries-its-own-vocabulary](2026-08-15-a-provider-carries-its-own-vocabulary.md),
  [2026-08-16-copy-is-authored-in-plex-words-and-rewritten-per-provider](2026-08-16-copy-is-authored-in-plex-words-and-rewritten-per-provider.md)

## Decision

**`ProviderVocabulary` gains `startIcon`, and the pull-queue button reads its label off the
vocabulary instead of hardcoding one.**

| kind | `startIcon` | `verb` | the button |
| --- | --- | --- | --- |
| `plex` | `▶` | Play | `▶ Play on ▾` (push — unchanged) |
| `kavita` | `📖` | Read | `📖 Read ↗` |
| `board-game-picker` | `🎲` | Play | `🎲 Play ↗` |

`↗` stays in the LABEL rather than moving into the vocabulary: it means *this leaves the
app*, which is true of every pull provider and is not a word any of them gets to choose.

## Context

The owner, 2026-08-17, on the Manga & Webtoons row:

> "Instead of 'Open', can that say 'Read'? Maybe we show a Book emoji instead of the 'play'
> icon?"

## Why

- **An icon is copy.** The vocabulary ADR fixed the WORD on a reading queue and left a play
  triangle sitting next to it — the glyph still promising a screen after the label had
  stopped. Two answers to "what medium is this?" in one button, one of them wrong.
- **"Open" was wrong on its own terms**, before the icon. It is what a *file* does. The
  provider already declares `verb: "Read"` and nothing was reading it here.
- **No branch on the provider's name.** `OpenQueueButton` still branches only on
  `delivery`; a fourth backend is one more map entry in `providers/config.ts`, not an
  edit to this component.
- **`DEFAULT_VOCABULARY` supplies `▶`**, so a definition naming a kind this build has never
  heard of renders exactly what it renders today rather than a gap where a glyph should be.

## Evidence

- Owner quote + screenshot, 2026-08-17.
- Before/after: `__screenshots__/kavita-row-before.png`, `kavita-row-after.png`.
