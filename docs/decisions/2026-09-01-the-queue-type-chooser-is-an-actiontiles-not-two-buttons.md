# The queue-type chooser is an `ActionTiles`, not two `Button`s

**Status:** Accepted
**Date:** 2026-09-01
**Type:** UI / component adoption
**Supersedes:** —
**Superseded by:** —

## Decision

The "Queue type" modal's two cards are a Charcuterie `ActionTiles`
(`@charcuterie/ui@3.32.0`). `.queue-type-options` is **deleted** from `app.css`, not
adjusted.

```tsx
<ActionTiles
  items={QUEUE_TYPE_TILES}
  label="Queue type"
  minTileInlineSize={260}
  onChoose={…}
/>
```

The hint above them gains `#queue-type-modal .subhint`, joining `#poweroffmodal`'s rule.

## Context

The owner reported the modal: *"This QueuePilot modal looks awful. Missing padding and
sizing that's typical of Charcuterie. Something's wrong."*

The cards were two Charcuterie `Button`s with an app rule over them:

```css
.queue-type-options button {
  align-items: start;
  display: flex;
  flex-direction: column;
  height: auto;
  text-align: left;
  white-space: normal;
}
```

A `Button` is sized by `h-(--control-height-md)` and carries **only `px-*`** — no block
padding at all, because a one-line control on a form row is sized by the density axis. So
`height: auto` computed to `padding: 0px 17px`. The card's title sat flush against its top
border and the description flush against its bottom one.

The hint paragraph above had `margin: 0` for a second reason: every `.subhint` rule in
`app.css` is scoped to a modal or view id, and the chooser never got one, so the class
painted nothing.

## Why

**This is the override this repo's `AGENTS.md` already bans, and the ban did not save it.**
*"A `className` on a Charcuterie component is a smell — `app.css` is unlayered and Tailwind's
utilities are in `@layer utilities`, so any app rule outranks the component it lands on. It
is never a tweak; it is a silent override."* The rule was right and the alternative it points
at — *"a control that needs a look is a Charcuterie component"* — did not exist. So the fix
is upstream, not local
(`charcuterie:docs/decisions/2026-09-01-a-tile-that-acts-is-its-own-component-and-shares-only-the-box.md`).

**Nothing in this repo could have caught it.** The class really was in the DOM, so
`borrowed-class-audit.ts` sees a match; tsc never reads the CSS; and unstyled-but-present
markup passes axe. The gate is now upstream and reads `getComputedStyle` in a real browser.

**`ActionTiles` and not `RadioGroup itemShape="tile"`, because a press here OPENS THE NEXT
STEP.** Pressing *Picks* opens the Picks editor and these tiles cease to exist — nothing
stays selected, because nothing was chosen. That is the split the upstream record settles:
a tile that records a value something below reads is a `RadioGroup`, and a tile that goes
somewhere is an `ActionTiles`.

**This app is now both sides of that split, on purpose.** The Tonight surface's activity and
queue choosers stay `RadioGroup itemShape="tile"` — they hold a value the Go button reads —
and they draw **the same box**, from one `tileStyles.ts` upstream. Do not "unify" them.

**The tiles lose their accent, and that is the fix rather than a regression.** The old cards
were `intent="accent"`, so the title and the border were both purple and the description was
not — a card that looked half-selected while nothing was selected. A resting tile is neutral
and takes its border to `border-border-strong` on hover, exactly as the Tonight tiles do.

**`minTileInlineSize={260}` rather than the 200px default.** These two hints are full
sentences; at 200px the modal would take a third empty track at its 720px width. The two
tracks it gives are the two tiles.

## Evidence

Measured on the running app with fixtures, before and after, at the same viewport:

| | Before | After |
| --- | --- | --- |
| tile padding | `0px 17px` | `12.75px 14.875px` |
| hint margin | `0px` | `0px 0px 18px` |
| tile border radius | 6px (control) | 10px (card) |

Both presses still open the right editor (`#setmodal`, `#dynmodal`) and both tiles are their
own tab stop. The Narrow View is one column. The modal's focus trap is unchanged — the same
Tab path was measured on a build of `main`, and it is `OverlayPanel`'s behaviour either way.
