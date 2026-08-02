# Per-channel "Max per scan" cap (max_items)

Date: 2026-07-22
Status: backend done (see below); web-UI wiring is the remaining handoff.

## Problem

Bob wants a per-channel watch cap. On his named movie channels ("… — Movies"), a
single card scan should play **one** movie and then STOP until the card is scanned again.
On the anime channels, no cap — they keep rolling as today.

Two distinct causes were in play (he wasn't sure which he was hitting), so we fix both:

1. **Too many items queued.** A curated movie queue already casts just the first
   not-finished entry, so a *single-movie* entry is already one item — but a **Collection**
   entry (plays the whole trilogy in order), a **series** entry, or a **rotation** channel
   casts several. A cap trims the lineup.
2. **Client auto-roll.** The client playback path hard-coded `continuous: 1`, so after the
   queue ended the Plex client auto-advanced into related "Up Next" content. A capped
   channel now sends `continuous: 0` so it stops. (The cast path — the default — already
   stops at queue end.)

## Decision

Add one per-channel integer field, `max_items`:

- **Semantics:** play at most `max_items` items per card scan, then stop. Because every scan
  is a fresh `do_start`, this is naturally *per-scan* — "watch N, then nothing more until you
  scan again." No persistent counter; the scan is the reset.
- **Blank / absent / ≤ 0 => no cap** (unlimited — the anime default).
- Applies to **every** source/mode (curated queue AND rotation) — it just trims the
  already-built lineup, and couples to `continuous` on the client path.
- A finite cap also means "don't auto-roll into related content" (client path
  `continuous: 0`).

Bob's intended values: every `… — Movies` channel → `1`; every `… — Anime` channel →
blank (no limit). He'll set these in the channel editor once the UI field ships.

## Backend — DONE

- `queue_builder/config.py` `_load_sets_yaml`: parse `max_items` → `int > 0` else `None`,
  passthrough for both rotation and queue sets (alongside the `mode`/`audio_language` v2
  passthrough).
- `queue_builder/service.py` `do_start`: after `SESSION.queue` is built (all branches),
  `SESSION.queue = SESSION.queue[:cap]` when `cap` is a positive int — one choke point just
  before `play_rating_keys`.
- `queue_builder/playback.py`: `create_play_queue(..., continuous=True)` now parametrized
  (`continuous: 1 if continuous else 0`); `play_rating_keys` sends `continuous=not capped`
  on the client path, where `capped = isinstance(cfg.get("max_items"), int) and > 0`. Cast
  path unchanged (already stops at queue end; the trim alone bounds it).
- `server/src/sets.js`: `toPosIntOrNull` helper; `normalize()` returns
  `max_items: toPosIntOrNull(ent.max_items)`; `updateSet` allows `max_items` (curated +
  rotation) and **deletes the key when cleared** (keeps YAML tidy — no `max_items: null`
  litter); both create paths (`rotationCreateObj` + curated) write it when > 0.

The API therefore already accepts/returns `max_items` and the Python engine already honors
it. You can set it today by hand-editing `sets.yaml` (e.g. `max_items: 1` under a movie
channel) or by `PATCH /api/sets/:id {"max_items": 1}` — no UI required for it to work.

## Web UI — REMAINING (handoff)

> NOTE: a parallel session was editing `web/index.html` / `web/app.js` (the "profile
> dropdown" feature) at the time this was written, which is why the UI field was left
> undone. Apply these on top of that work; the anchors below are approximate.

Add a "Max per scan" number input to **both** channel editors and wire it through. It maps
1:1 to the `max_items` field the server already accepts — no server change needed.

### 1. `web/index.html`

Curated modal `#setmodal` — after the `#set-libs` `<fieldset>`, before `<p id="set-idnote">`:

```html
<label class="field">Max per scan
  <input id="set-maxitems" type="number" min="1" step="1" inputmode="numeric" placeholder="blank = no limit" />
  <small class="subhint">Play at most this many items per card scan, then stop until you scan again. Blank = no limit (e.g. anime).</small>
</label>
```

Dynamic modal `#dynmodal` — after the "Audio language" `<label class="field">`, before
`<p id="dyn-idnote">`:

```html
<label class="field">Max per scan
  <input id="dyn-maxitems" type="number" min="1" step="1" inputmode="numeric" placeholder="blank = no limit" />
</label>
```

(Use `class="subhint"` for the hint — that class already exists in `web/style.css`; `hint`
does not.)

### 2. `web/app.js`

**`openSetModal(setId, presetKind)`** — after the `$('set-kind').value = …` line:

```js
$('set-maxitems').value = editing && editing.max_items != null ? String(editing.max_items) : '';
```

**`$('setform')` submit handler** — where it reads `label`/`kind`/`sections` and builds the
PATCH/POST body, add:

```js
const maxRaw = $('set-maxitems').value.trim();
const max_items = maxRaw === '' ? null : Number(maxRaw);
// …then include `max_items` in BOTH the PATCH and POST bodies:
//   await api('PATCH', `/api/sets/${modalSetId}`, { label, kind, sections, max_items });
//   await api('POST', '/api/sets', { label, kind, sections, max_items });
```

**`openDynModal(setId)`** — after the other `$('dyn-…').value = …` populates:

```js
$('dyn-maxitems').value = editing && editing.max_items != null ? String(editing.max_items) : '';
```

**`$('dynform')` submit handler** — add to the `body` object it PATCH/POSTs:

```js
max_items: $('dyn-maxitems').value.trim() === '' ? null : Number($('dyn-maxitems').value.trim()),
```

### 3. Verify

- Create/edit a curated movie channel, set Max per scan = 1, Save → confirm `sets.yaml` gets
  `max_items: 1` under that set; clear it and Save → confirm the key is removed.
- Scan the card (or POST the start): a movie channel with `max_items: 1` casts exactly one
  item and the client does not auto-roll; an anime channel (no cap) rolls as before.
</content>
</invoke>
