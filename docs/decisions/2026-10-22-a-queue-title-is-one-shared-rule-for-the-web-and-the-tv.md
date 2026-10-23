# A queue title is one shared rule for the web app and the native TV catalog

- **Status:** Accepted
- **Date:** 2026-10-22
- **Type:** Bug fix / architecture / UI
- **Supersedes:** —
- **Superseded by:** —

## Decision

1. **The native TV catalog prints the title the web Queues page prints.**
   `GET /api/native/queues` titles each queue with `queueTitle(set, number)`: the typed name
   verbatim, otherwise the activity, numbered as "Movies & Shows 2" (a plain space).
2. **The rule lives in `shared/queueTitle.ts`, and both workspaces import it by relative
   path.** It holds `queueTitle`, `queueNumbers`, `queueListNumbers`, `nestFilteredQueues`
   and the activity list and labels. `web/src/lib/people.ts`, `web/src/lib/filteredQueues.ts`
   and `server/src/activity.ts` re-export it. The server-only `numberDuplicates()` is
   deleted.
3. **`queueListNumbers` is the Queues page's numbering, and every list-wide caller uses
   it.** Picks queues (`source: queue`) in registry order with each filtered queue nested
   under its parent, then the Rules queues that are not superseded legacy tiers. The Queues
   page, What to Watch/Play, the single-queue page and the native catalog all call it over
   the whole registry. A filtered queue is numbered with its parent's people.
4. **A NAMED queue takes no duplicate number and uses none up.** This applies the 2026-08-26
   rule ("numbered only when two nameless ones would read identically") to the counting as
   well as to the printing.
5. **The Rules shelves print `queueTitle` too**, not `label`. `label` falls back to the id,
   so a nameless Rules queue showed its slug.

## Context

The owner reported that the TV app's queue names did not match the web app. The native
catalog (`server/src/nativeTv.ts`) hard-coded the title for every Plex queue:

```
`Movies & Shows${number ? " · " + number : ""}`
```

So a queue named "Anime" on the web was "Movies & Shows · 2" on the TV. Its numbering was a
separate server function with a different signature (no source) over a different list (Plex
queues only, registry order). The two could never agree, even on the activity text.

The web and the server had no shared code. The web's own comments record that the web
workspace "cannot import" the server, and several rules are mirrored by hand.

## Why

- **Two copies of a display rule drift, and this one already had.** One copy cannot. A
  parity test between two copies would still leave two places to edit.
- **A plain `shared/` directory is the smallest thing that makes one copy possible.** It is
  not a pnpm workspace, so the lockfile and both filtered Docker installs are unchanged. It
  has no dependencies and imports nothing, so it compiles under the web's program (Bundler
  resolution, DOM lib, no Node types) and the server's (NodeNext, Node types). Vite and
  esbuild both bundle it. `shared/package.json` only sets `"type": "module"`, because the
  root manifest deliberately has no type field and NodeNext would otherwise read the file as
  CommonJS.
- **The cost is three edits outside the source:** `server/tsconfig.json` `rootDir` moves to
  the repo root, and each Docker build stage copies `shared/`. Both builds were run from a
  copy of each stage's exact file layout before merge, because `docker-deploy.yml` builds the
  image only after the merge.
- **The numbering source has to match as well as the text.** The web numbered the Picks
  shelves in nested order and the native catalog numbered Plex queues in registry order, so
  the same queue could carry different numbers. One function over one list removes that.
- **A named queue counting toward the number was a defect against the 2026-08-26 record.**
  A queue named "Movies" beside one nameless queue for the same person made the nameless one
  "Movies & Shows 2", with no "Movies & Shows" anywhere.

## Evidence

- Owner report, relayed by the orchestrating agent on 2026-10-22: the TV app's queue names
  do not match the QueuePilot web app.
- `server/src/nativeTv.test.ts` "native TV queue titles": a fixture registry of nine sets
  (named, nameless, filtered, Kavita, Rules, superseded). Before this change the catalog
  printed "Movies & Shows", "Movies & Shows · 2" … "Movies & Shows · 4" for all eight Plex
  queues. After it prints "Movies", "Movies & Shows", "Movies & Shows 2", "Movies & Shows 3",
  "Shorts", "Movies & Shows", "Movies & Shows 2" and "Old Tier".
- `server/src/queueTitle.test.ts`: the moved `numberDuplicates` cases, plus nesting,
  superseded tiers, and a named queue that uses no number.

## Related

- [A queue's name is optional, and the activity fills in](2026-08-26-a-queue-name-is-optional-and-the-activity-fills-in.md)
  — the rule this makes the TV follow
- `docs/native-tv.md` — the native catalog contract
