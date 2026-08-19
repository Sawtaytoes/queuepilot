# "All" is an address (`/g/all`), not the absence of one

**Status:** Accepted
**Date:** 2026-08-19
**Type:** Bug fix / routing
**Supersedes:** the "`/` for the everything view" half of
[2026-08-17 — a group is who is watching, not a Plex profile](2026-08-17-a-group-is-who-is-watching-not-a-plex-profile.md)
(the group model, the memory rule and `/g/<id>` all stand; only All's URL changes)
**Superseded by:** —

## Decision

The everything view has its own URL, **`/g/all`**, and the All chip links to it. Bare `/`
still exists and still means "did not say" — it is what a typed domain or a link from Home
Assistant lands on, and it is still answered from the device's remembered group.

Landing on `/g/all` **clears** the remembered group rather than storing `"all"`, so the stored
value keeps meaning one thing (a specific group) and the next bare `/` lands on All — which is
what the device did in fact look at last.

`all` is already reserved server-side (`server/src/groups.ts`, `ALL_ID`), so no real group can
collide with it. `findGroup('all')` returns `null` **by design**: the everything view is the
absence of a filter, which is why `/g/all` and `/` render the same page.

## Context

Reported 2026-08-19:

> "clicking 'Alex' or any tag, then clicking 'All', it never goes back to 'All'. I think it
> keeps redirecting or something."

He was right about the mechanism. The chip was a real `<a href="/">`, the click worked, and
the landing effect in `App.tsx` then read `lastUsedGroup()` — set to `alex` on the way in —
and `navigate('/g/alex', {replace: true})` before the page painted. `/g/alex` → `/` →
`/g/alex` in one frame. Once any group had been visited on a device, All was unreachable
until localStorage was cleared.

## Why

- **The rule was right; All's spelling was wrong.** "The URL wins; storage only answers a URL
  that did not say" is what makes a group bookmarkable, per-device-honest and Back-safe.
  Spelling All as bare `/` made the one deliberate choice indistinguishable from the absence
  of a choice, so the rule ate it. Giving All its own address fixes the bug *without*
  weakening the rule — All is now a URL that says something.
- **The alternatives all weaken something.** Suppressing the redirect for in-app navigation
  (`useNavigationType() !== 'POP'`) leaves Back from `/g/bob` bouncing forward again — the
  dead-button symptom the `replace: true` was added to avoid, moved one control over. A
  once-per-session flag fixes the click but not a reload, and needs care to survive a
  StrictMode double-effect.
- **`/g/all` is worth having on its own merits.** It is bookmarkable and shareable, which
  bare `/` never was: a link to `/` shows the recipient *their* last group, not the everything
  view you meant to send.
- **The provider chips had the same latent bug.** They hang off `basePath`, which was `/` on
  the everything view — so tapping Plex there would have bounced into somebody's group too.
  `basePath` is `/g/all` on that page now.

## Consequences

- `groupPath()` returns `/g/all` for the synthesized group; `ALL_ID` is exported from
  `web/src/state/group.ts` to keep the client's spelling of the reserved id in one place.
- `parsePath` needs no change: `/g/all` was already a valid `{view: "play", group: "all"}`.
- The All chip's `aria-current` is unchanged — it keys off `activeId`, which is null on
  `/g/all` because `findGroup` deliberately returns null there.
- `web/src/state/group.test.ts` is new and pins both halves: the chip's href says `all`, and
  resolving `all` still means "no filter".

## Evidence

> "clicking 'Alex' or any tag, then clicking 'All', it never goes back to 'All'."
> (owner, 2026-08-19)

Reproduced and then verified against a local server on the landing fixture, 2026-08-19:
click a group → `/g/bob-others`, 7 cards; click All → `/g/all`, 17 cards, the All chip
carries `aria-current="page"`; **reload stays on `/g/all`**. Before the fix the second click
returned to `/g/bob-others`.
