# queuepilot UI design — the queue deck, the mode picker, and connectors

**Status: design proposal. Nothing here is built.** This is the written-down target so the
build can start cleanly; it is not a description of the shipped UI.

> ⚠️ **Before any of this is built, it gets mocked up as served HTML and reviewed.**
> "Make this look better" work goes: mock up in HTML → serve it → `devshare` the URL → the
> owner picks → *then* build. See `agentic/docs/runbooks/ui-design-previews.md` and the
> preview-UI-as-served-HTML decision
> (`agentic/docs/decisions/2026-07-25-preview-ui-changes-as-served-html.md`).
> Screenshots of the built result are served over `devshare`, never cited by file path.

Three things drive this design:

1. The app is being renamed and is no longer Plex-only
   ([rename ADR](decisions/2026-08-12-plex-channels-becomes-queuepilot.md)).
2. The queue/channel split is gone, replaced by five orthogonal knobs
   ([mode-knobs ADR](decisions/2026-08-12-queues-have-orthogonal-mode-knobs-not-named-types.md)).
3. Kavita has no cast, so a queue launches from **a URL**, not a push
   ([feasibility record](kavita-feasibility.md) §4).

---

## Where the UI is today

`#/` is already **play-first** — a posterless list of every channel and queue with a per-row
"Play on ▾", and the poster/drag editors live behind "Configure ›" links at `#/queues` and
`#/channels` (`web/src/views/PlayView.tsx`, per the 2026-07-21 IA decision). That decision's
IA **survives**; only its queue-vs-channel taxonomy was superseded.

So this is not a rewrite. It is: make the landing a **deck**, collapse two configurators into
one, add a **mode picker** for the new knobs, and add a **connectors** settings surface.

## 1. Queue deck — the landing

One large tile per queue. Tap to start. That is the whole interaction.

- **Replaces** the posterless rows at `#/`, and **absorbs** the queue/channel distinction — with
  the taxonomy gone there is one kind of thing to list, so one grid instead of two groups.
- **Each tile carries** the queue's label, what plays next (the existing tiles already resolve
  a member-first "what plays next" line — see
  [collection tiles are member-first](decisions/2026-07-31-collection-tiles-are-member-first.md)),
  its mode as a short human phrase (see §3), and its provider badge once there is more than one
  provider.
- **The tile's primary action is the launcher URL** (§2) — the same URL a bookmark or an NFC tag
  would carry. The existing "Play on ▾" device picker stays as the tile's secondary action for
  push-capable providers; for Kavita there is no device menu, because there is no push.
- **Reuses existing components — no new ones.** The app already imports `Accordion`, `Badge`,
  `Button`, `Checkbox`, `ColorSchemeSwitcher`, `EmptyState`, `Listbox`, `Modal`, `Skeleton`,
  `Spinner` and `Tooltip` from `@charcuterie/ui`, plus its own `PosterTile` / `TileMenu` /
  `PlayMenu`. A deck is a grid of the tile that already exists.
  Per [adopting a component means deleting its skin](decisions/2026-08-02-adopting-a-component-means-deleting-its-skin.md),
  don't re-skin them on the way in.
- **Pickers are `Listbox`, never a native `<select>`**
  ([decision](decisions/2026-08-07-plex-channels-pickers-are-listbox-not-native-select.md)).

## 2. The launcher route — one stable URL per queue

```
GET /play/<queue-id>   →  302  →  the provider's "start here" target
```

This is the concrete form of the provider seam's `handoff`
([provider ADR](decisions/2026-08-12-backends-are-providers-behind-a-media-neutral-seam.md)).
On request the app resolves the queue, materializes the runtime artifact, and redirects:

| Provider | What the 302 goes to |
| --- | --- |
| **Kavita** | `…/library/{libraryId}/series/{seriesId}/{manga\|book\|pdf}/{chapterId}?incognitoMode=false&readingListId={id}` — the reader then auto-advances across series by itself |
| **Plex** | the push path is unchanged; the URL exists for parity and for devices that can only open a link |

Why a redirect rather than a page: the tablet already holds a Kavita session, so a 302 lands
logged-in and *inside* the reader with zero extra taps. A landing page would add a tap to every
single launch, which is precisely the friction the product exists to remove.

**The URL must be stable** — same id, same URL, forever — because its whole value is that it can
be bookmarked, put on a home screen, or written to an NFC tag later. It must not encode the
chapter, the position, or the reading-list id; all three change on every launch.

**Failure is a page, not a redirect.** An unconfigured provider, an empty queue, or a
missing token renders a named error (per the fail-loudly rule in the
[tokens ADR](decisions/2026-08-12-provider-tokens-live-in-a-separate-config-file.md)) rather than
redirecting somewhere unhelpful. A 302 into a broken reader is the failure mode that already bit
this app twice from the couch.

## 3. Mode picker — presets over knobs

The five knobs (`pick_order`, `repeats`, `repeat_scope`, `batch`, `stop_after`) are the right
*model*, but a UI that asks for five enums makes the user memorise combinations. So:

**Named presets are the primary control; the raw knobs live behind an "Advanced" toggle.**

Proposed presets, each one a combination straight out of the mode-knobs ADR:

| Preset | Knobs | Reads as |
| --- | --- | --- |
| **In order** | `in-order` · `batch 1` | "play this queue top to bottom, one at a time" |
| **One each, then stop** | `rotate` · `batch 1` · `stop_after: one-pass` | "one episode of everything tonight, and no more" |
| **Round-robin** | `rotate` · `batch N` | "N of A, then N of B, keep going" — the reading default |
| **Shuffle, no repeats** | `shuffle` · `exhaust-first` · `scope: forever` | "random, but nothing twice until the list is done" |
| **Shuffle, this session** | `shuffle` · `exhaust-first` · `scope: session` | "random, no repeats tonight; fresh tomorrow" |
| **Full shuffle** | `shuffle` · `repeats: allow` | "random, anything any time" |

Rules for the picker:

- **`batch` stays visible even in preset mode** for the presets that use it — it is the knob the
  owner actually asked for by name ("read at least X chapters before switching"), so burying it
  under Advanced would hide the feature that motivated the work.
- **Selecting a preset writes the knobs**, it does not write a preset name. The stored model is
  always the five knobs; presets are a UI affordance only. This keeps `sets.yaml` honest and
  means a hand-edited combination that matches no preset is still valid — the picker shows
  "Custom" and Advanced opens pre-filled.
- **Show the consequence, not the mechanism.** Each preset renders its plain-English line (the
  "reads as" column), because the knob names are precise but not self-explanatory.
- **`repeat_scope: forever` needs persisted state that does not exist yet.** Until it does, that
  preset is either hidden or disabled with a Tooltip saying why — never offered and silently
  degraded to session scope.

## 4. Editor — same function, reached from the deck

The editor is **unchanged in what it does**. What changes:

- It is reached **from** a tile's menu ("Configure ›"), not by being the front door.
- `#/queues` and `#/channels` **collapse into one editor**, because there is now one kind of
  object. The per-view differences (poster drag + ordering for curated entries; filters + pool
  for rule-driven ones) become sections that appear when relevant, not separate routes.
- Everything the existing set/queue decisions settled stays: immutable ids, additive curated
  members, per-entry start episode, the queue flags fieldset, `batch_stops_at`.

## 5. Content Providers / App Connectors

A settings surface modelled on Music Assistant's providers: connect an app, store its base URL
and token, and let a queue choose which provider it draws from.

**Shape:**

- A list of connectors, each showing kind (Plex / Kavita / …), label, base URL, and a live
  **status** — connected, unreachable, or **not configured**.
- "Add connector" → pick a kind → base URL + token → test → save. **The test must be a real
  round-trip** (for Kavita, the `Plugin/authenticate` exchange), not a URL-format check.
- A queue's provider is chosen in the editor from the configured connectors.

**Config split is already settled** in the
[tokens ADR](decisions/2026-08-12-provider-tokens-live-in-a-separate-config-file.md): provider
*definitions* (id, label, kind, base URL, which queues use them) live in plaintext beside
`sets.yaml`; provider *tokens* live in `/config/providers.secrets.yaml`, resolved
`env > file > NOT CONFIGURED`.

Two UI obligations that fall out of it:

1. **The token control is write-only.** You can replace a token; you can never read one back.
   The field renders as "set" or "not set" — never the value, not even masked-but-copyable.
2. **An env-provided token is shown as locked**, with a note that it comes from the deploy
   environment, because env wins over the file and a UI edit would silently do nothing. Making
   that invisible is exactly the class of bug that caused the 2026-08-06 and 2026-08-10 outages.

## 6. Kavita specifics the UI has to respect

From the [feasibility record](kavita-feasibility.md):

- **One reading list per queue**, named for the queue, **rebuilt on launch** — `remove-read` to
  prune, then append the freshly-interleaved lineup with repeated `update-by-chapter`
  (insertion order *is* list order, which avoids the N-call `update-position` reorder).
  Because a Reading List is visible in Kavita's own UI — unlike a Plex `playQueue`, which is
  genuinely ephemeral — the name should make it obvious the app owns it and it will be
  overwritten.
- **Progress by polling** `ReadingList/items` — one call returns the whole queue's completion
  state, so a deck tile's "what's next" line is one request per queue.
- **Keep a queue format-homogeneous** where possible: a mixed manga/EPUB list bounces the reader
  between the manga and book readers mid-queue.
- **Lists are per-user.** If connectors ever grow multi-user support, the list owner must follow
  the *reading* user, not an admin — it fails silently otherwise.

## Open questions

- Does the deck need grouping (by provider? by "TV vs reading"?) or is one flat grid right at
  the current number of queues? Flat until proven otherwise.
- Should the launcher URL be guessable (`/play/anime-night`) or unguessable? It is a
  play-anything trigger reachable by anyone who has the URL; that is fine on the LAN and worth
  a second thought if it is ever exposed publicly.
- Does the kids' always-on wall display need a pinned mode on the deck? The same open question
  the [colour-scheme decision](decisions/2026-08-03-follow-the-os-colour-scheme-via-charcuterie-switcher.md)
  is still waiting on.
