# A search result says which library it is in, which edition it is, and whether this pool can reach it

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** fix / ux
- **Supersedes:** —
- **Superseded by:** —

## Decision

A filtered pool's **member picker** groups its results:

1. **This pool's libraries**, then a rule, then **Other libraries**.
2. **Collections still lead inside each group** — the outer sort is the group; collections-first
   only breaks ties within one.
3. Every row names its **library**, and its **edition** when Plex gave the item one.

The in-pool heading is drawn **only when there is a second group to distinguish it from**; a
search that lands entirely inside the pool is the ordinary case and gets no chrome. The
"Other libraries" heading is always drawn when that group exists, including when *everything*
is out of pool — that is exactly when the reason needs to be on screen.

The separator lives **inside the first `<li>` of its group**, not in an `<li>` of its own.

## Context

The member picker searches `scope=all` — every library, not just the pool's — because a curated
member is a manual include and need not come from a library the pool draws from. Owner,
2026-08-17:

> "One issue is we made the Search on Filtered Pools capable of searching all libraries, not
> just the specified ones. That's fine, but in search results, everything is mixed, so it's
> hard to tell which is which and where it came from. It'd be great if we could include the
> library somewhere in the search results and prioritize the selected ones first and put an
> `<hr>` style line between those selected and the 'rest of the library' items."

Separately, and in the same picker:

> "There's no 'edition' listed, so I don't know which of these is which."

Two rows reading `Big Buck Bunny 2008`, identical character for character. Verified against the
live server: `267280` carries `editionTitle: "3D"`, `267281` carries none — two library items,
same section, same title, same year.

## Why

- **`scope=all` was right and stays.** The fix is telling you what you are looking at, not
  narrowing the search back down.
- **Absent is Plex's own shape for an edition.** Only the tagged item names itself, so the
  plain one renders plain rather than inventing a "Standard" label Plex never wrote.
- **Collections-first is load-bearing and predates this.** Typing a franchise name turns up
  dozens of individual hits, the dropdown caps at 30, and a collection appended after the items
  was pushed past the cap and never shown at all. Grouping had to preserve that *within* each
  group rather than overriding it.
- **The separator is inside the row for a hard reason.** `SearchDropdown`'s click handling is
  delegated to the list and finds a row by its index among the list's children — a deliberate
  fix, because a listener bound to the row dies when a late response re-renders between
  mousedown and mouseup. A separator `<li>` would shift every index after it and fire the wrong
  result's `pick`. `flex: 0 0 100%` on a wrapping row makes it read as a rule anyway, so the
  DOM keeps a contract the styling never needed to break.

## Evidence

- Owner quotes and screenshots above.
- `editionTitle` confirmed on the live server before any code changed.
- Gate: `web/src/lib/searchGroups.test.ts`, 11 unit tests. The ones that pin the reasoning
  rather than the mechanics: an out-of-pool **collection** must not jump ahead of an in-pool
  item (group beats collections-first); the sort is **stable**, so Plex's relevance order
  survives within a group; a wholly-in-pool search draws **no** heading while a wholly-out-of-pool
  one still draws "Other libraries"; and the plain edition stays plain.
