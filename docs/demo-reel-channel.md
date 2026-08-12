# Theater DEMO reel channel — go-live + card wiring

> **Historical (2026-08-12).** Written against the Python modules, which are deleted. The reel
> behaviour it describes lives in `server/src/engine/resolve.js` (`buildReel`) and
> `server/src/session.js`.

A curated, **ordered** demo reel for showing off the Family Room theater: scan a card (or
trigger `set: "demo"` from the web UI) and a hand-picked run of Dolby/THX/Trinnov trailers +
4K Dolby-Vision/Atmos movie showpieces plays **back-to-back, in order, in full, every time**.

Built 2026-07-21. Curated from the **Demo** Plex Home profile's own most-played clips (1,751
plays across 620 items) — these are the ones that have actually earned their keep in this room.

---

## What it is (design)

A new set **`demo`** of `source: queue` + **`reel: true`**. A *reel* is the one queue variant
that is **not** watched-state-aware:

| | normal curated queue | **reel (`demo`)** |
| --- | --- | --- |
| what plays per scan | the *first* not-finished entry | the **whole list, in file order** |
| watched clips | marked `done`, drop out | **never** — replays forever |
| order | top = next | **file order = play order (a deliberate arc)** |
| engine path | `plex.next_queue` | `plex.build_reel` |

Why a reel and not the existing channel mode (`kind: anime`): that mode shuffles and caps at
`ROTATION_LENGTH` (12). A theater demo wants a *deliberate* arc (lights-down logos → reference
showpieces → crescendo → quiet outro) and the *full* list — so `reel` keeps file order, ignores
watched-state, and has its own 60-item safety cap. See the decision record
`docs/decisions/2026-07-21-demo-reel-channel.md`.

The clips live in the **Demos** (section 2) and **Movie Clips** (section 7) libraries. Entries
are keyed by **ratingKey**, so they resolve even though those libraries are otherwise hidden
from browsing.

---

## Code (this branch: `feat/demo-reel-channel`)

Python-only, additive, isolated in its own worktree so it does **not** collide with the parallel
"fix plex-channels" work in the main tree:

- `queue_builder/plex.py` — new `build_reel(set_name, limit=60)`: resolve entries in file order,
  ignore watched-state, never mark done, same return shape as `next_queue`.
- `queue_builder/config.py` — `_load_sets_yaml` carries a `reel: true` flag onto a queue set.
- `queue_builder/service.py` — `do_start` uses `build_reel` when `cfg["reel"]`, else `next_queue`.
- `queue_builder/cli.py` — `python -m queue_builder.cli reel demo` (read-only dry-run).

Verified read-only against live Plex — 20/20 clips resolve, 0 unresolved, correct order.

---

## Go-live (do these on the app host — the live config is NOT in this repo)

Live config lives on the app's config volume, **not** in git:
`/mnt/TrueNAS-Apps/App-Configs/plex-channels/` (SMB `\\nas.example.com\App-Configs\plex-channels\`).

### 1. Deploy the code
Rebuild + redeploy the `plex-channels` image so `build_reel` ships (see `DEPLOY.md`). The two
config edits below are read live on the next scan (`config.reload_sets()` runs each command), so
no restart is needed once the new image is running.

### 2. Add the set to `sets.yaml`
Append this entry to the `sets:` list (shelf order = file order; put it wherever you want the
shelf to appear):

```yaml
  - id: demo
    label: Theater Demo Reel
    kind: demo
    source: queue
    reel: true
    sections: [2, 7]        # Demos + Movie Clips
```

> `id` is immutable (HA/MQTT reference it). Rename `label` freely.

### 3. Add the lineup to `queues.yaml`
Append the `demo:` block from [`demo-reel.queues.yaml`](./demo-reel.queues.yaml) (in this repo,
next to this doc) to `queues.yaml`. It's 20 `{ratingKey, title}` entries in the intended order —
rearrange or trim to taste; the `title:` is just a human label, the `ratingKey` is what plays.

### 4. Try it (no card needed)
`set: "demo"` is playable **immediately** — no NFC card required:
- **Web UI** (`plex-channels.example.com`) → the Demo shelf → **Play on ▾ → Family Room SHIELD**, or
- **MQTT**: publish `{"set":"demo"}` to `plex-channels/cmd/session/start`, or
- **HA**: `script.control_plex` with `{plex_action: play, kind: movie, set: demo}`.

Wake the theater first: `select.family_room_remote_family_room_theater = "Movies & Media"`
(~30 s), then trigger. Watch `media_player.family_room_shield_6` flip to `playing`.

---

## Card wiring: DONE 2026-07-25

The card is **`Plex: Demo Reel`**, tag_id **`04-D3-BF-72-22-02-89`** (card 9 in
`CARD-REGISTRATION.md` §3). Both HA edits are live:

- **Tag named:** `04-D3-BF-72-22-02-89` → `Plex: Demo Reel`.
- **Wired:** `tag_command_map` in `automation.plex_nfc_scanner` (id `1783594676353`) now carries:

  ```jsonc
  "04-D3-BF-72-22-02-89": { "plex_action": "play", "kind": "movie", "set": "demo" }
  ```

  (`kind` is informational for a queue/reel; the set decides what plays. It's `movie` because
  `script.control_plex`'s `kind` selector only accepts `cartoons|movie|anime`.)

**Verified on TV 2026-07-25:** a Family Room scan played the reel on the Shield and auto-advanced
through the lineup (Dolby Universe → Amaze → Leaf → Ready Player One → ...).

### The card only works on the Demo profile

The clips live in **Demos (2)** and **Movie Clips (7)**, which are shared with the **`Demo`**
profile only. Checked against live Plex: `Older Kids` sees sections 1, 5, 11, 14, 15 and
`Younger Kids` sees 1, 3, 5, 11, 14, 15 - **neither can see 2 or 7**. On a kid profile the reel
cannot play at all, and it fails silently: the playQueue builds under the owner token and
Companion answers the play command with HTTP 200 regardless.

So the set carries **`requires_profile: Demo`** (added 2026-07-25). A scan now blocks until the
Shield is signed into `Demo`, skipping any other profile it sees along the way, so you can scan
the card first and pick the profile on screen afterwards, in either order. If it never switches,
the state publishes a named error after `PROFILE_WAIT_SECONDS` (120s) instead of doing nothing.
Design + evidence: [`docs/decisions/2026-07-25-sets-can-require-a-plex-profile.md`](./decisions/2026-07-25-sets-can-require-a-plex-profile.md).

> Optional: to also fire it from a UC3 remote screen button, add the same intent under a new key
> in `button_command_map` and give it a trigger. Not needed for the card.

---

## Follow-ups (deferred on purpose)

- **`sets.js` `DEFAULT_YAML` + `normalize()`**: not touched, to avoid colliding with the in-flight
  `sets.js` rewrite in the main tree. Consequence: (a) a *fresh* install won't seed the demo set
  (irrelevant — the live file already exists and is hand-edited per step 2); (b) the web UI's JSON
  view drops the `reel` flag, so the Demo shelf renders as an ordinary queue. Playback is
  unaffected (pure Python). Once the `sets.js` work settles, add `reel` to `normalize()` and the
  demo entry to `DEFAULT_YAML` for parity.

  **Same gap now applies to `requires_profile`** (2026-07-25), and it is worth more than `reel`
  because 8 sets carry it. Checked while adding it: this is a *visibility* gap only, NOT data
  loss. `updateSet`/`deleteSet`/`reorderSets` all patch the existing ruamel node against an
  allowlist rather than rewriting it from `normalize()`, so a web-UI edit leaves untouched keys
  intact. Editing a gated queue in the UI will not silently drop its gate. Add both fields to
  `normalize()` when convenient so the UI can show and edit them.
