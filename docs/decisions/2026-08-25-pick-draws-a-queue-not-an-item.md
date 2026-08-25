# Pick draws a QUEUE, not an item — and the activity → backend map is written twice on purpose

- **Status:** Accepted
- **Date:** 2026-08-25
- **Type:** Architecture / product
- **Supersedes:** —
- **Superseded by:** —

## Decision

Three answers, taken while connecting the Tonight surface's Pick half (WP-7).

### 1. For Movies, Shows, Reading and Video Games, a pick chooses a QUEUE. The queue chooses the item.

`POST /api/tonight/pick` draws one queue for the activity and the people at the table. It does
**not** choose a film, an episode, a chapter or a game. The queue's own engine does that when it
starts.

What the card also carries is *what would come up next*, whenever that can be answered without
starting anything, and a null one always carries a reason:

| Queue | Where "up next" comes from | Cost |
| --- | --- | --- |
| A PULL queue (Reading, MiSTer, Steam, Board Games) | the real head of `pullLineup()` | the same round trip the launch was going to make |
| A CURATED push queue (Plex) | the first entry not marked done, out of `queues.yaml` | no Plex call at all |
| A RULES pool | nothing, by name — its lineup does not exist until it is drawn | none |

**Board Games is the exception and keeps its own door.** A board game is on a shelf, not in a
queue, so the absorbed Board Game Picker engine draws from the collection through
`POST /api/board-games/pick`. That engine is untouched by this package.

### 2. The filters that no backend can answer yet are reported, not dropped.

The Tonight form collects **Runtime** and **Seen before** for Movies, and **Knows how to play**
for Video Games. Neither is applied. The answer says so, in words, on the result card.

### 3. The activity → backend map is written twice, and a gate compares the two copies.

`server/src/tonight/routing.ts` and `web/src/lib/tonightRouting.ts` carry the same table. The
two workspaces cannot import each other, so `e2e/tonight-routing-test.ts` compares them field by
field and fails on a drift.

## Context

WP-6 built the Tonight form and WP-8 built the result card. Only Board Games was wired; the
other five activities said "Pick is not connected" rather than faking a result. The
implementation plan's WP-7 table names a pick engine per activity:

> Video Games — players, known-how, time proxy · Movies — runtime, rating gate, seen-before ·
> Shows — queue-first · Reading — queue-first · Surprise Me — crosses activities within a
> chosen narrowing

Two of those five are "queue-first" by name. The other three name filters, so the question was
whether this build can answer them. It was measured rather than assumed.

## Why

**A second opinion about what is left can disagree with the first one.** The queue's resolver
already decides what plays: which episode is next, which chapter is unread, which entry has
been finished, what a start floor and a batch stop do to all of that. An engine here that
re-derived any of it would be a second rule that drifts — the exact defect
`routes/queuesRoutes.ts tagFinishedMovies` warns about in its own header, where a "cheap
re-implementation" of a resolver rule is called out by name. Choosing the queue is a question
nothing else answers; choosing the item is a question something else already answers well.

**The three named filters have no data behind them in this build, and the measurement is
short:**

- **Movies — runtime.** `GET /api/pending` throws `duration` away, and there is no exported
  "list a movie library" anywhere; `select.movieFilms()` is private and returns
  `Map<ratingKey, title>`. A runtime filter means a new 10 000-item section dump per draw.
- **Movies — rating gate.** There is **no age→rating logic anywhere in the server**.
  `birthYear` exists on a person and is read by nothing; the only gate that exists is a
  per-binding content-rating allowlist somebody typed by hand. "Rating gate" as the plan means
  it — the table is old enough for this — does not exist to be wired up.
- **Movies — seen-before.** `finished.watchedFor()` can answer it, at the cost of a paged
  history walk per account × section, memoized for 60 seconds.
- **Video Games — known-how.** **There is no video-game known-how table.** WP-8 built the
  wording split ("Knows how to play" against "Knows the rules") and left the rows waiting.
  Steam reports lifetime playtime and no player count at all. And a play count may never be
  turned into a claim — a play may RENEW one and may never invent one
  (board-games decision `2026-08-17-knowing-the-rules-is-a-per-person-fact-not-a-play-count`).

So a filtered library draw for Movies is a real feature with a real cost, and one for Video
Games is mostly not implementable today. Reporting the gap on the card is honest; applying a
filter that silently does nothing is not, and neither is a plausible-looking draw that ignores
what the form asked.

**The map is duplicated because the alternative is worse.** `web/` and `server/` are separate
workspaces with separate module formats, and the browser must not fetch a table to know which
tile leads where. One shared file would mean a third package; a gate that compares two files
costs one e2e run and fails loudly.

**Surprise Me is refused rather than answered.** The narrowings are not settled — the owner
said "media" spans YouTube and Plex Movies/Shows, which is coarser than the tile row, and that
is all that is known. `SURPRISE_SCOPES` is empty on purpose and a unit test keeps it empty. A
route that answered it with a plausible taxonomy would read as settled and get built on.

## Evidence

Implementation plan, `agentic:docs/research/2026-08-23-tonight-absorb-implementation-plan.md`
§2 WP-7, and §5's warning that the content-type question "changes the schema, not a screen" and
that **WP-7 depends on the answer**.

Owner, on the tile row and on the queue model, 2026-08-25:

> "the Older Kids queue would show up under both Shows and Shorts, but I don't think of it like
> that in my head."

> "It should be something you select. What if instead, you selected that, and it took you to
> another screen where you could narrow it down like 'video games' … or 'media', and it chooses
> between YouTube or Movies/Shows on Plex?"

Measured in this repo on 2026-08-25: `pending.ts` copies ten fields off a `PlexMetadata` and
`duration` is not one of them; `grep -rn 'birthYear'` in `server/src/` reaches `people.ts` and
its store, and no consumer; `boardgames/types.ts minAge` is read by nothing, including
`boardgames/pick.ts`.

## Related

- `AGENTS.md` → "Tonight: one activity, one backend"
- Plan: `agentic:docs/research/2026-08-23-tonight-absorb-implementation-plan.md` §2 WP-6/7/8
- Authority: `agentic:docs/decisions/2026-08-22-queuepilot-absorbs-board-game-picker-tonight-pick.md`
- The tile row and the narrowing seam:
  `agentic:docs/decisions/2026-08-25-video-games-absorbs-retro-and-surprise-me-narrows-first.md`
- The queue model: `agentic:docs/decisions/2026-08-25-a-queue-is-people-plus-an-activity.md`
- [`2026-08-13-a-queue-draws-from-exactly-one-provider.md`](2026-08-13-a-queue-draws-from-exactly-one-provider.md)
