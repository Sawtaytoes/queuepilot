# QueuePilot starts with a mode landing, and the picker is What to Watch/Play

- **Status:** Accepted
- **Date:** 2026-08-26
- **Type:** Routing / naming / UI
- **Supersedes:** —
- **Superseded by:** —

## Decision

**1. `/` is a mode landing.**

The first page offers exactly two choices: **Admin** and **What to Watch/Play**.

**2. Admin is at `/admin`.**

The existing queue and rules management landing remains the administrative surface. Its
configuration pages return to `/admin`.

**3. The activity picker is called What to Watch/Play.**

Its canonical address is `/what-to-watch-play`. The old `/tonight` address redirects to this
path so existing links keep working.

**4. `Tonight` is not user-facing copy for this surface.**

The existing internal `tonight` route and API names may remain while they preserve compatibility.
Visible headings, links, page titles, and empty states use What to Watch/Play or another
context-specific phrase.

## Context

The owner asked for a starting page like Mux-Magic and Gallery-Downloader:

> "When I go to QueuePilot, I want it to have a starting page at `/` like Mux-Magic and
> Gallery-Downloader where it lets you choose one of the two modes: Admin or What to
> Watch/Play"

He also asked:

> "I also don't want the \"choose something to watch/play\" to be called \"Tonight\". I want
> that named differently."

## Why

QueuePilot has two different jobs. A mode landing makes that split clear before either job
opens.

What to Watch/Play describes the action without tying it to a time of day. It also includes
board games, so a name limited to watching would be incomplete.

The old path redirects instead of failing because links may already use it. The internal names
stay stable because this change is a user-facing route and naming change, not an API rewrite.

## Evidence

- Direct owner request, 2026-08-26. Chat id: unavailable in this repository session.
- `web/src/state/route.test.ts` covers the mode landing, both canonical modes, the legacy path,
  and the path labels.
- `e2e/routing-test.ts` covers cold GETs, the root links, deep links, reloads, client-side
  navigation, and the legacy path rewrite.
