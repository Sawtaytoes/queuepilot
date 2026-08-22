# Pending draws from an INCLUDE list of libraries

- **Status:** Accepted
- **Date:** 2026-08-21
- **Type:** Product
- **Supersedes:** the "Other Videos unless a set draws from it" rule in
  [2026-08-17-pending-is-what-nothing-will-play.md](2026-08-17-pending-is-what-nothing-will-play.md)
- **Superseded by:** —

## Decision

The Pending screen draws from a configured **include** list of library sections, held in
`pending.yaml` as `libraries` and edited on the page itself.

1. A library that is not named is not on the screen.
2. When nothing is named, the default is every video library that is **not** Plex "Other
   Videos" (Personal Media, `com.plexapp.agents.none`).
3. `[]` and "unset" are different states. `[]` means "no libraries" and gives a blank page
   on purpose. Unset means "nobody has chosen" and falls back to the default. The `libraries`
   key is omitted from the file while it is unset, never written as an explicit null.
4. An explicit list overrides the default in **both** directions. Naming a Personal Media
   library puts it back on the screen.
5. `video` is enforced even against an explicit choice. Nothing this app builds can queue a
   photo or music section, so naming one is a mistake and not a preference.

The rule this replaces admitted an Other Videos library whenever any set drew from it.

## Context

The owner reported the page as slow. It held **2,162** rows. Two facts explain that number:

- `seen_through` is `0` — the watermark has never been moved, so "new" means the whole
  library history.
- `Demos` (359) and `Movie Clips` (738) are Personal Media libraries, and the `demo` and
  `betterman_qc` queues draw from sections 2 and 7. The conditional hatch therefore admitted
  **1,097 rows, 51% of the page**, every one a clip or a test encode.

The subtraction rules themselves were working: queue coverage, collection children,
title-resolved entries, pool rules and watch state were all being applied.

## Why

The owner's words settle both the direction and the mechanism:

> "Virtualize, exclude Demos and Movie Clips because none of those are things I wanna queue
> unless i need to queue them. They're never going to be 'Pending'. So we need some way to
> configure the 'Pending' queue, and then remove those. Don't hardcode them that way."

> "Pending is for new additions not in a queue, not watched, from specific libraries (not the
> inverse). So instead of exclude, just have it be include."

Include and exclude differ in what happens to a library nobody has thought about. Under an
exclude list a new Plex library silently joins the screen and has to be noticed and named to
get rid of. Under an include list it stays out until someone asks for it. On a screen whose
entire job is subtraction, that is the correct default direction.

"Don't hardcode them that way" is why `Demos` and `Movie Clips` appear nowhere in the code.
The default is a property — *has this library a metadata agent* — and the configuration
overrides it.

The hatch it replaces was wrong for a reason worth stating: a queue that plays out of a
scratch library says something about **that queue** and nothing about whether a new file
there is news.

## Evidence

- Measured on the live server, 2026-08-21: 2,162 items before, **1,065** after, with the
  default. Exactly the 1,097 Demos + Movie Clips rows leave.
- `e2e/pending-test.ts` — hermetic and offline, **52 checks**, 17 of them new: the default
  fold, an explicit list widening and narrowing, `[]` against `null`, a non-video library
  refused, an unknown id dropped, and the file round trip in both directions.
- `POST /api/pending/libraries` takes `{libraries: number[] | null}` and rejects anything
  else with a 400.
- The filter is a `CheckboxGroup`, the same control the set modal's libraries already use.
