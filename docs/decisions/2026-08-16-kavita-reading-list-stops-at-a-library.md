# A Kavita reading list must not cross libraries

- **Status:** Accepted
- **Date:** 2026-08-16
- **Type:** bug / workaround
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [2026-08-15-the-reading-list-is-rebuilt-not-appended](2026-08-15-the-reading-list-is-rebuilt-not-appended.md)

## Decision

**QueuePilot writes only the first library's run onto the Kavita reading
list.** The tiles still show the full rotation. After the last chapter of
that library, Kavita has nothing next — Open again and the next library
starts as a *new* reader navigation, which is when its reading profile
applies.

This is a workaround for a Kavita bug, not a product preference.
Upstream: [Kareadita/Kavita#4859](https://github.com/Kareadita/Kavita/issues/4859).

## Context

The owner, 2026-08-16, on a mixed Manga & Webtoons launch:

> "Read two ch from the same Webtoon. Then a manga came up, and instead
> of changing to the reading mode of the Manga library, it kept the
> reading mode of the Webtoons library for that particular one. So it
> scrolled instead of paginated, and the width was not 100%, it was
> based on the custom width of that webtoon."

Webtoons library: scroll + custom width. Manga library: paginated + 100%
width. Both series use Kavita's **manga** reader (`/manga/`), so this is
not the EPUB/PDF bounce feasibility §3 already documented.

Kavita [reading profiles](https://wiki.kavitareader.com/guides/user-settings/reading-profiles/)
are supposed to pick, when *opening a series*:

1. implicit profile for the series
2. series-bound profile
3. library-bound profile
4. default

What actually happens on reading-list auto-advance
(`UI/Web/src/app/manga-reader/_components/manga-reader/manga-reader.component.ts`):

- `ngOnInit` loads the profile from the **route resolver** once.
- `loadChapter` does `history.replaceState` and `init()`, and does **not**
  remount, re-resolve, or call `setupReaderSettings`.
- `init()` reloads pages. It never updates `this.seriesId` / `this.libraryId`
  from the new chapter. It never fetches the destination profile.
- `switchToWebtoonReaderIfPagesLikelyWebtoon()` can switch *into* Webtoon
  mode and never back out.

So a manga that follows a webtoon on the same list keeps scroll + width.
Filed as [Kareadita/Kavita#4859](https://github.com/Kareadita/Kavita/issues/4859)
(searched 2026-08-16; nothing already described the list-advance case).

## Why

- **We cannot patch Kavita's reader.** The auto-advance is native and
  in-place; there is no query param that forces a profile reload.
- **Stopping the list at the library is the smallest honest workaround.**
  Same-library series (two webtoons) still auto-advance. The manga is not
  dumped into the webtoon scroller. The next Open is a real navigation.
- **Truncating the *tiles* would lie.** The lineup is still the rotation;
  only the artifact the reader walks is shortened.

## Consequences

- A mixed-library visit needs a second tap on Open after the first
  library's batch. That is worse than "one launch, whole lineup" and
  better than the wrong reader.
- Series-level profiles *inside* one library have the same Kavita bug
  and are not split here — we only have `libraryId` on the play item.
- When Kavita reloads the profile on series change, this prefix can be
  removed. Do not remove it until that ships and is verified.

## Evidence

- Owner quote above, 2026-08-16.
- Kavita `manga-reader.component.ts` `loadChapter` / `init` / `ngOnInit`
  on `develop` (read 2026-08-16).
- Gate: `sameLibraryPrefix` of `[lib 5, lib 5, lib 6]` is the first two;
  `materialize` adds only those two chapters.
