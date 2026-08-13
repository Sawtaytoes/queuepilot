# Kavita feasibility — can this app drive reading the way it drives Plex?

**Verdict: yes, and it is LESS work than the Plex side was.**

Kavita already ships the equivalent of Plex's `playQueue` — an ordered, cross-series,
auto-advancing runtime artifact. That is the piece `playback.js` has to hand-build and push to
the Shield. What Kavita does *not* have is the recipe/rotation layer that decides **what goes in
the queue** — and that layer is precisely what this app already is.

- **Verified:** 2026-08-12, against the live instance `kavita.example.com`, **read-only** (no
  reading list was created, modified, or deleted; no progress was written).
- **Live server version:** `0.9.0.2` (`GET /api/Server/server-info-slim`).
- **Spec used for the write endpoints:** `openapi.json` on Kavita's `develop` branch, which
  self-reports **`0.9.0.19` and 488 paths**
  ([raw](https://raw.githubusercontent.com/Kareadita/Kavita/develop/openapi.json)). Swagger is
  **disabled on our instance** (`/swagger/v1/swagger.json` → 404), so the spec is the only
  machine-readable reference. Note the version skew: the spec is ahead of what we run, so treat
  a spec-only endpoint as "exists upstream", not "exists here".

> **Why this matters for the product.** The whole point of the app is to stop *deciding*.
> Reading has that problem worse than TV — manga and webtoons get skipped nightly because
> picking is work. The ask is a queue that plays the next chapter of series A, then rolls into
> series B, with a configurable "read at least X chapters before switching". Every mechanical
> piece of that is below.

---

## 1. Auth

The API-key → JWT exchange already used by `comic-ingest/kv-lib.mjs:5-12`:

```
POST /api/Plugin/authenticate?apiKey=<KAVITA_API_KEY>&pluginName=<name>
  → { "token": "<JWT>", "username": …, "apiKey": …, "refreshToken": … }
```

Every subsequent call carries `Authorization: Bearer <JWT>`. The key lives in the root `.env`
as `KAVITA_API_KEY` (base URL `KAVITA_API_SERVER_URL`) — **never** in a committed file.

The key is **per-user**, and that matters more here than it does on Plex: see
[§6 Ownership](#6-ownership-build-lists-as-his-user-not-an-admin).

## 2. The endpoint table (each one actually called)

| Need | Endpoint | Verified result |
| --- | --- | --- |
| "Next unread chapter of series X" | `GET /api/Reader/continue-point?seriesId=` | ✅ 200, returns the full `ChapterDto` |
| Ordered **cross-series** queue | `GET /api/ReadingList/items?readingListId=` | ✅ 200, ordered items (see field list below) |
| **Auto-advance across series** | `GET /api/ReadingList/next-chapter?readingListId=&currentChapterId=` | ✅ 200 → next `chapterId`; **`-1` at the end** |
| Walk backwards | `GET /api/ReadingList/prev-chapter?readingListId=&currentChapterId=` | ✅ 200 → `-1` at the start |
| Enumerate lists | `POST /api/ReadingList/lists?pageNumber=&pageSize=` | ✅ 200 — **POST, not GET** (easy to get wrong) |
| Per-chapter progress | `GET /api/Reader/get-progress?chapterId=` | ✅ 200 `{volumeId, chapterId, pageNum, seriesId, libraryId, bookScrollId, lastModifiedUtc}` |
| Build a list in order | `POST /api/ReadingList/create` + N× `POST /api/ReadingList/update-by-chapter` | ✅ present in spec (**not called** — read-only session) |
| Reorder later | `POST /api/ReadingList/update-position` | ✅ present in spec, but **single-item move only** → build in order instead |
| Prune finished | `POST /api/ReadingList/remove-read?readingListId=` | ✅ present in spec |
| Progress events | SignalR `/hubs/messages`, event `UserProgressUpdate` | ✅ negotiate 200 with the JWT, **401 without**; transports WebSockets + ServerSentEvents |
| OPDS (incl. reading lists) | `GET /api/opds/<apiKey>` | ✅ 200 Atom catalog; `…/<apiKey>/reading-list` → "All Reading Lists" |

`ReadingList/items` entries carry everything the selection layer needs without a second call:

```
id, order, chapterId, seriesId, seriesName, seriesSortName, seriesFormat,
pagesRead, pagesTotal, chapterNumber, volumeNumber, chapterTitleName, volumeId,
libraryId, title, libraryType, libraryName, releaseDate, readingListId,
lastReadingProgressUtc, fileSize, summary, isSpecial, chapter{…}, volume{…}
```

`order` + `pagesRead`/`pagesTotal` + `lastReadingProgressUtc` mean **one** call returns the
whole queue's completion state. That is strictly better than the Plex side, which needs a
history sweep per profile.

> ⚠️ **`/api/opds/<apiKey>` puts a live credential in the URL path.** Never log it, never put
> it in a screenshot, never commit an example with a real key. Use `<apiKey>` in docs.

## 3. The reader deep link — the substitute for "cast"

Confirmed by reading the **live** Angular bundle served by our instance
(`chunk-4XJKNB7C.js`, the manga reader; `chunk-7R3IRPAA.js`, the reader service).
**Bundle hashes change on every Kavita upgrade** — re-derive rather than trusting the filename.

```
/library/{libraryId}/series/{seriesId}/manga/{chapterId}?incognitoMode=false&readingListId={id}
```

Both halves are built by the reader service, and both were read out of the bundle verbatim:

```js
getNavigationArray(libraryId, seriesId, chapterId, seriesFormat) {
  return seriesFormat === EPUB ? ["library", libraryId, "series", seriesId, "book",  chapterId]
       : seriesFormat === PDF  ? ["library", libraryId, "series", seriesId, "pdf",   chapterId]
       :                         ["library", libraryId, "series", seriesId, "manga", chapterId];
}
getQueryParamsObject(incognito = false, readingListMode = false, readingListId = -1) {
  const p = {}; p.incognitoMode = incognito;
  if (readingListMode) p.readingListId = readingListId;
  return p;
}
```

So there are **three reader variants** — `…/manga/`, `…/book/` (EPUB), `…/pdf/` — chosen by the
chapter's `seriesFormat`, which `ReadingList/items` already gives us.

### What `?readingListId=` actually switches on

In the reader component:

```js
const r = this.route.snapshot.queryParamMap.get("readingListId");
if (r != null) { this.readingListMode = true; this.readingListId = parseInt(r, 10); }
```

and once `readingListMode` is set, next/prev resolve through the **reading list**, not the
series:

```js
getNextChapter(seriesId, volumeId, chapterId, readingListId = -1) {
  return readingListId > 0
    ? http.get(base + "readinglist/next-chapter?seriesId=" + seriesId
                    + "&currentChapterId=" + chapterId + "&readingListId=" + readingListId)
    : http.get(base + "reader/next-chapter?seriesId=" + …);
}
```

The advance happens **in place** — `window.history.replaceState({}, "", nextUrl)` plus a
`toasts.load-next-chapter` toast — so finishing a Webtoon chapter rolls straight into a chapter
of a *different series* without leaving the reader. **This is the auto-advance the whole feature
needs, and it is native.** No client patching, no fork.

One wrinkle worth knowing before it surprises someone: in `readingListMode`, if the next
chapter's `seriesFormat` is EPUB or PDF the reader **re-navigates** to the book/pdf reader
rather than rendering inline. A mixed-format list therefore bounces the user between readers.
Keep a queue format-homogeneous unless that bounce is acceptable.

## 4. The one real gap: no cast, no webhooks

**Nothing in Kavita opens a chapter on a remote reader.** The closest-sounding endpoint is not
it: `POST /api/Device/send-to` takes a **`SendToEmailDeviceDto`** and is summarised
*"Sends a collection of chapters to the user's device"* — it is **Send-to-Kindle email**, not a
cast/handoff. There is no outbound webhook either.

Open upstream requests:
[#4390](https://github.com/Kareadita/Kavita/discussions/4390) ·
[#3406](https://github.com/Kareadita/Kavita/discussions/3406).

### Mitigation (chosen): one stable URL per queue that 302-redirects

Each queue gets a **stable, bookmarkable launcher URL** on this app. Hitting it rebuilds the
reading list, then **302-redirects** into the reader deep link at the current position. The
tablet keeps its Kavita session, so the redirect lands logged-in; the URL never changes, so it
can go on a bookmark, a home-screen tile, or (later) an NFC tag.

This is a genuinely better fit than cast would be: reading is **pull** (you pick up the tablet
when you're ready), where TV is **push** (the card starts the show on a screen already on).

HA push — `browser_mod` or Fully Kiosk `loadUrl` — is a **documented future option, not built
now**, and would make the tablet behave like the Shield does.

## 5. How the Plex design maps

| Concept | Plex | Kavita |
| --- | --- | --- |
| **queue** — the declarative recipe in `queues.yaml` | — | **unchanged; still the source of truth** |
| static saved list | Playlist | Reading List |
| ephemeral, auto-advancing runtime artifact | `playQueue` | **Reading List + `?readingListId=`** |
| push to a device | Companion API → Shield | ❌ none → **302 launcher URL** instead |

The standing argument in
[`why-queues-not-plex-playlists.md`](why-queues-not-plex-playlists.md) **survives intact, and
transfers verbatim**: a Reading List is the **runtime artifact**, never the store. A Reading
List is a static list of concrete chapters; a queue is a watched-state-aware recipe that
resolves, per user, at launch time. Do not be tempted to "just use Reading Lists" for the same
reasons we don't just use Playlists.

The one asymmetry: on Plex the runtime artifact (`playQueue`) is genuinely ephemeral and dies
with playback, whereas a Reading List **persists and is visible to the user in Kavita's UI**.
That is a UX consequence, not a design one — see the rebuild-on-launch rule in §6.

## 6. Ownership: build lists as *his* user, not an admin

Reading lists are **per-user** — `ReadingListDto` carries `ownerUserName`, and on our instance
every existing list reports the owner's own account. A list built with a *different* account's
key is invisible to the reader that is supposed to play it.

**Rule: build with the same user's API key that reads on the tablet.** This is the reading-side
analogue of the Plex per-profile token rule, and it will fail silently — empty reader, no error
— if it is got wrong.

### Progress: poll, don't subscribe (for now)

`GET /api/ReadingList/items?readingListId=` returns the whole queue's completion state in one
call. That is the recommended mechanism.

SignalR `UserProgressUpdate` is faster, but carries a caveat that must be recorded because it
is invisible from the outside — in `Kavita.Services/SignalR/EventHub.cs`:

```csharp
public async Task SendMessageAsync(string method, SignalRMessage message,
                                   bool onlyAdmins = true, CancellationToken ct = default)
{
    var users = messageHub.Clients.All;
    if (onlyAdmins)
    {
        var admins = await presenceTracker.GetOnlineAdminIds();
        users = messageHub.Clients.Users(admins.Select(i => i.ToString()).ToArray());
    }
    …
}
```

`onlyAdmins` **defaults to `true`**, and `Kavita.Services/Reading/ReaderService.cs` emits
`UserProgressUpdate` at five call sites **without ever overriding it**. So the event reaches
**admin connections only**. In our case the account in play *is* the admin, so a subscription
would in fact work here — but it is load-bearing on an incidental privilege, and it would break
silently for any non-admin reader. Poll unless and until that changes upstream.

## 7. Libraries in play

Verified live (`GET /api/Library/libraries`):

| id | Library | Type |
| --- | --- | --- |
| 5 | **Webtoons** | 0 (manga) — the full-colour ones actually wanted |
| 2 | **Manga** | 0 |
| 3 | **Comics** | 5 |
| 6 | **Books** | 2 |
| 7 | Manga Ingest | 0 |
| 1 | Board Game Rulebooks | 2 |
| 4 | Learn Japanese | 2 |

The first four are the ones this feature targets. Note that libraries 1/4/6 are book-type, so
their chapters route to the **book** reader variant (§3) — another reason to keep a queue
format-homogeneous.

## 8. What is left to build

Nothing in Kavita. On our side:

1. A **Kavita provider** behind the media-neutral seam
   ([ADR](decisions/2026-08-12-backends-are-providers-behind-a-media-neutral-seam.md)) —
   `buckets` from `Reader/continue-point`, `progressState` from `ReadingList/items`,
   `materialize` into a Reading List, `handoff` returning the deep link.
2. The **302 launcher route** per queue
   ([UI design](queuepilot-ui-design.md)).
3. **Connector config** for the base URL + token
   ([ADR](decisions/2026-08-12-provider-tokens-live-in-a-separate-config-file.md)).

## Reproducing these probes

Read-only; safe to re-run. Auth as in §1, then call each `GET` in the §2 table. Do **not**
re-verify the four write endpoints by calling them — they mutate a real reading list; the spec
is the reference. Re-derive §3 from the live bundle rather than trusting the chunk hash.
