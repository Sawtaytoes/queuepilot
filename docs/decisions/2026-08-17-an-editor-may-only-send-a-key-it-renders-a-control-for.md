# An editor may only send a key it renders a control for

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** fix / invariant
- **Supersedes:** —
- **Superseded by:** —
- **Builds on:** [the-lineup-knobs-live-in-the-pool-editor](2026-08-17-the-lineup-knobs-live-in-the-pool-editor.md)

## Decision

A form's submit body may contain a key **only** if that form either renders a control for it
or explicitly round-trips the stored value into its draft state. A key the form neither shows
nor reads is **omitted**, never sent as an empty default.

Concretely, in `DynModal` (the ⚙ Configure editor for a filtered pool):

- `blocklist` and `movie_excludes` leave the body entirely. `updateSet` skips absent keys
  (`if (!(k in patch)) continue`) and `createSet` defaults both to `[]`, so one body is correct
  on the create path and the edit path alike.
- Each binding draft carries `movieExcludes` through `toDraft` → `readBinding` untouched,
  because the editor rewrites the whole `profiles[]` array and `bindingWriteObj` writes
  `movie_excludes` only when the caller sends it. For a whole-array replace, forgetting a field
  IS deleting it.

## Context

Reported by the owner, 2026-08-17: *"my excluded entries (Blocked ones) keep getting removed
each time we reload the server. Are we not storing them or something?"*

They were stored. `PATCH /api/sets/:id {blocklist}` writes `sets.yaml` correctly and the value
survives a restart — verified directly against a running server before touching any code. The
loss came from the other direction: `DynModal.onSubmit` built its body with a literal

```js
blocklist: [],
movie_excludes: [],
```

That editor renders no control for either list — Blocked lives in the inline **Pool filters**
panel, and the rewatch excludes sit beside it — so it never read their stored values. On a
CREATE the empty arrays are the right default; on an EDIT they were silent data loss. Every
Save from ⚙ Configure blanked every show the owner had excluded.

The reload was a coincidence of timing, not the cause. What actually changed on 2026-08-17 is
that [the Lineup box](2026-08-17-the-lineup-knobs-live-in-the-pool-editor.md) gave him a reason
to open that editor at all — the knobs had been YAML-only until then, so the wipe had been
sitting there unexercised.

The binding half is the same bug one level down and was found while gating the first: a Save
that races the binding seeding never sends `profiles[]` and looked fine, while a Save a moment
later — what a human does — replaces the array and drops `movie_excludes` with it.

## Why

- **Absence is the only safe encoding for "I have no opinion".** `[]` is an opinion, and on a
  partial-update endpoint it is the destructive one. The server already treats a missing key as
  "leave it alone"; the client just has to say nothing.
- **The rule generalises past these two fields.** The same editor's `length` / `refill` /
  `on_complete` are sent unconditionally and that is *correct*, because it renders controls for
  them and seeds them from the set. "Renders it or round-trips it" is the test, and it is one
  a reviewer can apply to a diff without knowing this history.
- **It is the mirror of a rule the codebase already had.** The Lineup ADR made *equal to the
  default is stored by absence* load-bearing so that opening a pool to rename it would not stamp
  three keys onto it. This is the same instinct pointed at data the editor does not own at all.

## Evidence

- Owner, 2026-08-17 (above), plus the screenshot of a pool whose Blocked panel read
  "Nothing blocked."
- `web/src/components/DynModal.tsx:357,361` before the fix.
- Verified the write side was innocent first: `PATCH` → `sets.yaml` holds the entries → restart
  → `GET /api/sets` still reports them. Only then was the editor suspected.
- Gate: `e2e/pool-editor-keeps-blocked-test.ts` — browser, **no Plex**, its own server and temp
  files. Seeds a pool with 2 blocked entries and a binding-level rewatch exclude, opens
  ⚙ Configure, waits for the binding card (so the `profiles[]` path is genuinely exercised),
  Saves, and asserts both lists survive; plus a create-path assertion that a new pool still
  blocks nothing. It fails **both** halves on the pre-fix code and passes on the fix.
- It runs in CI's **always-on** browser block, not the `PLEX_TOKEN`-gated one. That is
  deliberate: the gated block is skipped on every PR, which is how a regression in this editor
  reached the owner in the first place.
