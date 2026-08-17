# Profiles, Groups and navigation — the design conversation

> **Status: PARTLY SETTLED (2026-08-17).** The identity model (§2), the routing question (§3)
> and the naming (§4) are decided and shipped —
> [A Group is "who is watching", it lives in the path, and explicit membership beats derived](decisions/2026-08-17-a-group-is-who-is-watching-not-a-plex-profile.md).
> **Everything in §5 is still open**: the settings screen, the device ignore list, Plex-only
> Filtered Pools, and the Pools-screen navigation dead end. So is carrying the group through
> into `/q/<id>` and the Pools screen — groups exist on the landing only.
>
> The rest of this file stands as written: the record of what was considered on
> **2026-08-17**, in the owner's own framing, so that a later choice can be made against the
> full set of options rather than against whichever one was on screen last. He asked for it
> explicitly:
>
> > "I'm telling you this, so we can document it even if I change my mind because we need to
> > denote it in a decision doc somewhere on all the things we thought about and what we
> > eventually decided on."
>
> When one of these lands, it gets a dated record in [`decisions/`](decisions/README.md) and
> this file gains a pointer to it.

---

## 1. The problem, stated

The Play landing is three columns of rows, and it is getting hard to use:

> "I'm growing to hate this screen. I think we need some sort of filtering here."

The single sentence that everything below serves:

> "The main thing I want is to make it easier to find things. If I select 'Bob' and then
> can easily filter down pools/queues that way, that's the best. I want a way to see all
> *my* stuff *and* filter down to only Plex or *only* Kavita. Most of the queues are mine
> anyway. Only 4 pools are for the kids."

Three separate defects hide under "hard to find things":

**a. Ownership is in the NAME, inconsistently.** `Bob & Alice — Anime` says who it is
for; `Manga & Webtoons` is Bob-only and does not say so; `Theater Demo Reel` is for
nobody in particular.

> "The 'Manga & Webtoons' queue is configured for me only, but that's not in the name. It's
> not clear looking at it."

**b. The same audience is split across many rows by MEDIUM.** `Bob & Alice — Anime` and
`Bob & Alice — Movies` are two rows that are really one audience with two queues.

> "It's almost like those should be merged into 1 item with 2 separate queues to choose
> from. Would make it a lot easier for me."

…and the inverse framing, which is the more interesting one:

> "If we look at it a bit differently, me by myself includes Anime, Movies, and Manga &
> Webtoons. Those are *my* queues when I'm alone. If I'm with someone else, then I'd need to
> look at a different set of queues."

**c. Some rows are not about a person at all.** `Theater Demo Reel`, `Betterman QC (ep01)`
— demo/QC material that should not be competing for attention with tonight's viewing.

> "the Theater Demo Reel would go under a 'Demo' group. Same with the Betterman QC (ep01)
> queue."

---

## 2. The identity model (this part is close to settled)

A **QueuePilot profile** is our own object that MAPS ONTO provider accounts, N-to-M. It is
not a Plex profile and not a Kavita user.

> "I might want to be more granular on users. For instance, Carol might have his own Kavita
> pool/queue, but he's still in both the Older Kids and Younger Kids profiles. So I'd need a
> way to create a profile in QueuePilot that can be a part of different profiles from other
> providers (Plex/Kavita). For me, it's 1 to 1. 1 Plex and 1 Kavita. For Carol, it's 2 Plex
> and 1 Kavita. For other kids, it's 1 or 2 Plex and 0 Kavita. Alice has only 1 Kavita. The
> Plex stuff she shares under my account."

| QueuePilot profile | Plex accounts | Kavita accounts |
| --- | --- | --- |
| Bob | 1 (`sawtaytoes`) | 1 (`Bob`) |
| Alice | 0 — shares Bob's | 1 |
| Carol | 2 (Older Kids, Younger Kids) | 1 |
| other kids | 1–2 | 0 |

**Why the indirection is load-bearing and not ceremony:** the two backends do not agree on
who anyone is. Plex knows `sawtaytoes`; Kavita knows `Bob`. Without a QueuePilot-side
identity there is nothing to hang "all of Bob's stuff" on, and the owner's stated goal is
exactly that filter.

Detour considered and rejected by the owner mid-thought — **provider first, then account**:

> "Actually... I'm thinking differently now. First, you select the provider, then you select
> a profile. That's probably the best way. BUT, there could be multiple Kavita accounts tied
> to a single server. I think the Admin API key should suffice though right? One Admin API
> key should be able to configure all accounts."
>
> "Naw, now I'm back to my original idea of QueuePilot profiles. The reason I want to tie it
> to a QueuePilot profile is because I talked about storing it in Local Storage. There's
> only *one* QueuePilot app, not 1 per type, and if I wanna read Kavita, I don't wanna have
> to go back to the main menu, select 'Kavita', and then select 'Bob' and the one Manga &
> Webtoons pool I have... I think. I'm thinking the simplest way is I select 'Bob' from a
> list, and all my stuff is there."

He is right, and the reason is worth writing down: **provider is a filter, not a level of
the hierarchy.** Making it the first choice forces a trip back to the root every time the
medium changes, for a distinction the person already knows. Person first, medium as a
secondary filter, matches "see all *my* stuff *and* filter down to only Plex".

> ⚠️ **The Kavita admin-key question is still open and is a real one.** One admin API key
> can enumerate and act for every Kavita account, so listing them as options in QueuePilot
> is feasible. Whether QueuePilot should *hold* an admin key to do it is a separate
> question — it is a broader credential than reading one person's progress needs.

**Grouping is the same mechanism, one level up.** The owner arrives at "Groups" for the
non-person cases:

> "if I did wanna modify those in the app, I'd wanna switch to a 'Kids' profile or QueuePilot
> Group (maybe that's a better way: 'Groups') that includes their pools/queues."

So: a **Group** is a named bag of pools/queues. `Bob`, `Bob & Alice`, `Kids`, `Demo`.
Some groups correspond to a profile; some (`Demo`) do not. A queue can plausibly be in more
than one.

**Open:** are Profile and Group one concept with two uses, or two? The owner used both words
for the same job within a few sentences. Collapsing them is simpler; keeping them separate
lets "who plays this" (an account binding, which the engine needs) stay distinct from "where
does this show up" (a shelf label, which only the UI needs). **Recommendation: two
concepts, one control.** A profile OWNS an account mapping and implies a group; a group is
just a label. The picker at the top offers both in one list because the user does not care
which kind a given entry is.

---

## 3. The routing question — the one he asked for pros/cons on

> "If we don't store the account at all but change the route based on the current profile:
> `https://queuepilot.example.com/plex/sawtaytoes`, then I could bookmark each variant and
> refresh the page without losing my place, but I should be able to easily switch between
> accounts. Gimme some pros-cons and your thoughts on this because I'm not really certain
> right now."

### Option A — the selection lives in `localStorage` only

Path stays `/`, a header picker sets the active profile, `localStorage` remembers it.

| | |
| --- | --- |
| ✅ | One URL. Nothing to bookmark wrong. |
| ✅ | Trivial to build. |
| ❌ | **Not bookmarkable and not linkable.** Cannot put "Bob's stuff" on a phone home screen. |
| ❌ | **`localStorage` is per-device and per-browser**, so the TV browser, the phone and the desktop each drift to a different profile. This is the tab-sync complaint again, one layer up. |
| ❌ | Back button does not undo a profile switch. |

### Option B — the profile is in the PATH (`/p/bob`), no persistence

| | |
| --- | --- |
| ✅ | **Bookmarkable, linkable, home-screen-able** — his stated want. |
| ✅ | Refresh keeps your place, which is the thing `localStorage` was being asked to buy. |
| ✅ | Back/forward work on profile switches, for free. |
| ✅ | Shareable: an HA button or an NFC tag can point at a person's page. |
| ❌ | Bare `/` needs an answer — a chooser, or a redirect to a default. |
| ❌ | Renaming a profile breaks old bookmarks unless the slug is immutable (`sets.yaml` already learned this: **ids are immutable, labels are free**). |

### Option C — path AND `localStorage` (the recommendation)

`/p/<profile>` is the truth; `localStorage` remembers only *the last profile you used*, and
is consulted **only** when you land on bare `/`.

| | |
| --- | --- |
| ✅ | Every advantage of B. |
| ✅ | Typing `queuepilot.example.com` still lands you where you were — the convenience A was after. |
| ✅ | One rule, stated once: **the URL wins; storage is only a default for an unspecified URL.** |
| ❌ | Two sources of "current profile" to keep straight — mitigated entirely by that rule. |

### Option D — provider in the path too (`/plex/sawtaytoes`)

His original spelling. Rejected above, and there is a second reason: it encodes the
*provider account* rather than the QueuePilot profile, so Bob needs two URLs
(`/plex/sawtaytoes`, `/kavita/bob`) for what he described as one person's stuff. The
provider belongs as a **filter chip inside** a profile's page — `All · Plex · Kavita ·
Board games` — which is exactly what "see all my stuff *and* filter to only Plex" asks for,
and it can live in the query string (`/p/bob?provider=kavita`) so it is still linkable
without becoming a route.

### Recommendation

**C, with the provider as a chip.**

```
/                     → redirect to the last-used profile, else a chooser
/p/bob              → Bob's pools + queues, all providers
/p/bob?only=kavita  → …filtered to Kavita
/p/kids               → the group
/q/<id>, /channels/<id>   unchanged — a queue is still addressed by its own id
```

The header keeps a profile picker so switching is one tap, and the picker is a `<Link>` per
profile (`2026-08-15-navigation-is-an-anchor-not-a-button`), so every affordance —
middle-click, copy link, open in new tab — comes for free.

**Do NOT scope a queue's own URL by profile.** `/q/bob_anime` must stay one canonical
address; a queue belongs to a profile, so putting the profile in the path would create N
URLs for one object and immediately raise "what if it is in two groups".

---

## 4. Naming — the part that is genuinely unresolved

Merging by audience and slicing by medium point in opposite directions:

- **Audience-first**: `Bob & Alice` is one card that opens onto `Anime` / `Movies`.
  Matches "merged into 1 item with 2 separate queues to choose from" and matches how he
  actually decides (who is on the couch, then what).
- **Medium-first**: `Anime` is one card that opens onto `Bob` / `Bob & Alice` /
  `Bob & Carol` / `Family`. Matches how the pools were BUILT — "I took the 'Anime'
  definition and divided it up between Family, Bob & Alice, Me by myself, Bob & Carol,
  etc."

Both are true; they are the same grid read along different axes. The grid is small (≈4
audiences × ≈3 media), which suggests **do not commit to a hierarchy at all** — keep one
flat list and give it two independent controls:

- **profile / group** (the route, §3), and
- **provider** and/or **medium** (chips).

The names then stop mattering, because the label no longer has to carry the metadata: once
a queue KNOWS its profile and its provider, `Bob & Alice — Anime` can just be `Anime`
inside Bob & Alice's page. That resolves defect (a) without a rename campaign, and
defect (b) without picking a winner between the two readings.

**Open:** whether to also rename the stored labels once the metadata carries the meaning, or
leave them long. Renaming is safe (`sets.yaml` labels are free; only ids are immutable), but
HA automations and NFC cards quote *ids*, not labels — so the risk is only cosmetic.

---

## 5. Adjacent problems raised the same day

These are separate changes; they are recorded here because they came out of the same
conversation and the IA work should not be planned without them.

### 5.1 There is no settings screen, and there needs to be

> "How am I supposed to add and remove providers? All those configs are managed by you, not
> inside the app. The only thing that should be via env vars are the Plex token and Kavita
> token. The rest should be via config settings in the app itself to make it easy to change
> stuff if need be."

Half of this already exists server-side and has **no UI**:
`providers/config.ts` splits *definitions* (`/config/providers.yaml`, plaintext, editable)
from *tokens* (`/config/providers.secrets.yaml`, 0600, write-only) — decision
[`2026-08-12-provider-tokens-live-in-a-separate-config-file`](decisions/2026-08-12-provider-tokens-live-in-a-separate-config-file.md).
That is exactly the split he is asking for. What is missing is the screen, plus moving the
remaining deploy-time values (`KAVITA_API_SERVER_URL`, `BOARD_GAME_PICKER_URL`,
`SHIELD_*`) out of env into the same file. The env layer stays as an override — it already
wins over the file — so nothing about the current deploy breaks.

### 5.2 The device list is dynamic already; it needs an ignore list

> "I dunno why Plex Dash shows up here. You can't play anything on it I thought. Also, one is
> my phone. I'd like to add that to an ignore list somehow."

Answering the direct question — **nothing is hardcoded.** `devices.ts` sweeps
plex.tv `/api/v2/devices`, keeps every row whose `provides` contains `player`, and
re-announces the set over retained MQTT every `DEVICE_ANNOUNCE_SECONDS`; a device that stops
appearing has its retained topic cleared. Only the theater Shield is pinned, from env, so
the dropdown is never empty when plex.tv is unreachable. So turning the Master Bedroom
SHIELD back on, or opening Plex in a browser, **does** add an entry — which is precisely why
Plex Dash (a browser session) and a phone are in the list. The sweep is working; it has no
opinion about which players are *useful*.

What is missing: a per-device **hidden** flag, stored in the app's own config (not env, per
§5.1), applied at the point the dropdown is rendered rather than at the sweep — so a hidden
device that later becomes the only reachable one can still be un-hidden without a redeploy.

### 5.3 Filtered Pools are Plex-only

> "I noticed it looks like Kavita isn't wired up with Filtered Pools. I'm not sure why, but
> it should have the same capabilities as the Plex queues/pools. Same with Board Game
> Picker."

Correct, and it is structural rather than an oversight:

- **Curated Pools / Ordered Queues** (`source: queue`) go through the provider seam —
  `providerFor(id).buckets()` — and Kavita and Board Game Picker both implement it. That is
  why Manga & Webtoons works.
- **Filtered Pools** (`source: rotation`) do not touch the seam at all. `engine/select.ts`
  + `engine/rotation.ts` are a direct port of the Plex-only Python engine: Plex library
  sections, Plex `contentRating` allow-lists, Plex watch history per `accountID`.

Making a Kavita filtered pool work therefore needs two things, and the second is the hard
one: route the rotation path through `Provider.buckets()` (mechanical), and decide what a
provider-neutral FILTER is. `allowed_ratings` / `movie_ratings` / `watch_count_accounts` are
Plex content-rating vocabulary. Kavita has age ratings and genres; the picker has player
counts and durations. A filter model that is honest about this probably looks like the
vocabulary seam — each provider declares its own filter axes and the editor renders them —
rather than one shared set of checkboxes.

### 5.4 Navigation is confusing, and the back button is the symptom

> "I can't seem to get back to the pools dropdown from here."
>
> "I hit '‹ Pools' and it goes to the 'Pools' screen, but it's a bit jarring because I'd
> expect that button to typically take me back to the '‹ Play' or 'QueuePilot' main screen."

The back button targets the ORIGIN — where you navigated in FROM — which was a deliberate
2026-08-16 choice so that opening a queue from Play returns to Play. It does what it says;
the trouble is that the Pools screen's own **Pool** dropdown lists curated pools too, and
picking one navigates to `/q/<id>`, a different view with a different chrome and no way back
into that dropdown. So you can leave the Pools screen without meaning to, and then "back"
honestly returns you to a screen you did not think you were on.

Two candidate fixes, both cheap, and they are not exclusive:

1. **The back button always goes to Play** (or the profile page, post-§3). Predictable;
   loses the "return where you came from" nicety.
2. **The Pool dropdown stops listing things it cannot edit** — or the two editors merge, so
   picking any pool keeps you on one screen. This is the actual defect; (1) only hides it.

This whole area is downstream of §3: if the landing becomes a profile page with filters, the
"Configure ›" split into three separate editors may not need to survive at all.

---

## 6. What was already changed, and what is still open

**Shipped 2026-08-17** (each with its own decision record):

- [A filtered pool is locked to one account](decisions/2026-08-17-a-filtered-pool-is-locked-to-one-account.md) — the per-row profile picker is gone; the account prints in the meta line.
- [The start button wears its provider's icon](decisions/2026-08-17-the-start-button-wears-its-providers-icon.md) — `📖 Read ↗` on a Kavita queue.
- [The pool editor wears its provider's colour](decisions/2026-08-17-the-pool-editor-wears-its-providers-colour.md) — the violet button on `/channels/<id>` is Plex amber.
- [A live refresh commits each endpoint independently](decisions/2026-08-17-live-refresh-commits-each-endpoint-independently.md) — cross-tab settings sync goes from 6.9 s (or never) to 0.8 s.

**Still open, in the order they probably want doing:**

| | What | Why this order |
| --- | --- | --- |
| 1 | QueuePilot profiles + groups (§2) and the `/p/<profile>` route (§3) | Everything else is easier once a queue knows whose it is. |
| 2 | Filter chips: provider, medium (§4) | Cheap once §1 exists; kills the naming problem without renaming. |
| 3 | Settings screen: providers, devices, host values (§5.1, §5.2) | Independent of §1; the server half already exists. |
| 4 | Navigation / editor merge (§5.4) | Wants §1 settled first, or it gets redone. |
| 5 | Filtered Pools on non-Plex providers (§5.3) | Largest, and needs its own decision on what a provider-neutral filter is. |
