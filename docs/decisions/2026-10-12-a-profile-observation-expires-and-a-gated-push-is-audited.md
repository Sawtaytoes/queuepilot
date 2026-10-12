# A profile observation expires, and a gated push is audited afterwards

- **Status:** Accepted
- **Date:** 2026-10-12
- **Type:** Bug fix / playback correctness / diagnostics
- **Supersedes:** the unbounded-lifetime clause of
  [2026-09-07](2026-09-07-a-plex-session-observation-skips-the-profile-picker.md)
  *(branch 3, the idle continuation — the observation itself stays trusted, it just stops
  being trusted forever)*
- **Superseded by:** —
- **Extends:**
  [2026-08-21](2026-08-21-the-profile-gate-verifies-the-account-plex-is-playing-as.md),
  [2026-09-23](2026-09-23-the-screen-outranks-the-observation-and-a-session-proves-the-play.md)

## Decision

**A profile observation is a statement about a moment, so it expires. And every gated push is
logged, so a play the live audit could not judge can still be judged later.**

1. **`profiles.LAST_SEEN` carries `observedAt`, and `onRequired()` rejects a stale
   observation.** The bound is `PROFILE_OBSERVATION_TTL_SECONDS`, default **600 s**. An
   expired observation is still handed to the picker walk as its navigation hint; it simply
   cannot clear the gate. A TTL of 0 or less disables the skip entirely.
2. **An ADB claim carries no time at all.** `profiles.recordProfileClaim()` writes the title,
   clears `isObserved` and clears `observedAt`, so a claim cannot become fresh by being
   recent. The three writers of `LAST_SEEN` now each have their own named function, and the
   invariant lives in `profiles.ts` rather than at the call sites.
3. **Every gated play appends one row to `gated_push`** — the set, the bound account, the
   pushed ratingKeys and the moment. It is written **whatever the post-play audit concluded**,
   including when the audit had no opinion, and it is NOT written when the play failed.
4. **`accountAudit.auditAttribution()` compares that log against Plex's own history** and
   names every item a gated queue pushed that Plex filed under another account. It is reachable
   at `GET /api/account-audit` and on `queuepilot/cmd/queue/account-audit`, it is **evaluated
   on a read**, and there is no timer behind it.
5. **A failed history read is not a clean run.** The report carries `unreadable` separately
   from `findings`, and the MQTT reply's `ok` describes the REQUEST while `findings` describes
   the ANSWER.

## Context

The owner, 2026-10-12:

> "It seems as though QueuePilot somehow put some content for Younger Kids on the Main Kevin
> account. I can only think that happened because the Plex auth server was down. I thought we
> did a safety check and even stopped having to go back to the account view by checking the API
> to verify your account as well?"

Both checks he remembers were there, and both are still in the code. The event he saw was on
**2026-09-12**, and it is reconstructible:

| Local time | What | Source |
| --- | --- | --- |
| 08:04–10:22 | A gated kids' queue plays correctly; the audit records an OBSERVATION | Plex history, child account |
| 10:22–12:27 | The Shield sits idle. Somebody signs it into the owner's profile | *(no signal — this is the hole)* |
| 12:27:11 | `waiting`, set `younger_kids_shows`, `awaiting: profile:Younger Kids` | `sensor.queuepilot_status` |
| 12:27:34 | `playing`, `played: true`, playQueue 15162 — **no picker walk** | same sensor |
| 12:41–13:36 | Three items scrobble to the OWNER | Plex history |
| 13:43:48 | `playing`, set `older_kids_shorts_shows`, playQueue 15164 | same sensor |
| 14:20–15:53 | Five more items scrobble to the OWNER | Plex history |
| 16:15 | A human fixes the profile on the TV; attribution returns to normal | Plex history |

Nine items, three hours, two gated queues, and no error anywhere. The live
`sensor.queuepilot_status` said `played: true` both times.

### Why neither check fired

Both treat **no proof as a pass**, and on an idle Shield neither has proof.

- The **pre-play** check (`driveProfile` → `playback.currentAccount`) only speaks when a
  session is live on the target player. From 10:22 to 12:27 there was none, so it abstained
  and fell through to `profiles.LAST_SEEN` — which held a **correct, matching, two-hour-old**
  observation from the morning block. `onRequired()` read `isObserved` and the title and
  nothing else, so it skipped the walk. Nothing on this deployment reports a profile a person
  picks at the TV, so the memory was the only witness and it was out of date.
- The **post-play** audit abstained. Measured in the live container log on 2026-09-22 at
  21:13:49: `[driver] account audit had no opinion: no active session on the target player`,
  on a play that did start. That specific cause was fixed three days later by
  [2026-09-23](2026-09-23-the-screen-outranks-the-observation-and-a-session-proves-the-play.md),
  which raised the wait from 12 s to 25 s — but abstention remains a pass by design, so the
  class of failure survives it.

The 2026-09-23 record is the near miss here: it was written about an incident whose
observation was **three hours old**, and it bounded the fast path by what was on SCREEN
without bounding it by AGE.

### The Plex outage was not the cause, and the instinct behind it is still right

No evidence of a plex.tv or PMS outage on 2026-09-12 was found, and none is needed to explain
the event. But the reading is directionally correct and worth recording: when Plex is
unreachable, `currentAccount()` abstains *and* `verifyAccount()` abstains, so an outage opens
both holes at once. "Cannot tell" and "fine" being the same answer is the defect; the outage
would only be one way to reach it.

## Why

- **An observation is evidence about an instant.** `isObserved` fixed the *provenance* problem
  in 2026-08-21 — where the knowledge came from — and left the *recency* problem untouched. A
  fact with no timestamp is indistinguishable from a standing truth, and this one is not a
  standing truth: the TV has a profile picker that a person can use at any time, silently.
- **600 s keeps the thing the fast path was built for and drops the rest.** The latency
  complaint behind [2026-09-07](2026-09-07-a-plex-session-observation-skips-the-profile-picker.md)
  was queue-to-queue starts — *"it always backs out and changes profiles again, and that's
  pretty slow"* — and those are minutes apart, with a live session that the preflight reads
  directly anyway. The remembered observation is only load-bearing for an idle continuation,
  which is exactly the case that went wrong. Ten minutes covers a pause-and-restart and spends
  ~16 s of picker walk after a long gap.
- **The post-play audit cannot be made to never abstain, so something else has to cover it.**
  Making abstention terminal was considered and rejected again: it would fail plays that are
  probably fine, on a device whose session can take 25 s to appear, and a card scan that
  errors because Plex was slow is a worse household outcome than a mis-filed watch row. The
  honest answer is to keep abstention permissive **and stop relying on it as the last line**.
- **The audit matches on RATING KEYS, never on libraries.** This is the design decision that
  decides whether the check survives contact. Several queues legitimately draw from one
  library on different accounts — a family queue bound to the owner and a kids' queue bound to
  a child both play Shows — so "a Shows row on another account" is a normal evening. A
  library-scoped check would have fired on its first run, and a check that cries wolf gets
  switched off, after which the real failure goes unseen again. Only an item *this push put in
  the play queue* counts.
- **Evaluated on a read, with no timer.** A `setInterval` that stops firing is invisible until
  the answer is wrong — the same reasoning as
  [the seasonal reset](2026-09-08-a-queue-can-clear-its-own-watched-state-on-a-date-each-year.md).
  And no Home Assistant automation ships here, for
  [the reason already settled](2026-09-08-the-reset-is-exposed-on-the-api-and-mqtt-without-a-home-assistant-automation.md):
  this repo is public and most people who clone it do not run Home Assistant.
- **The push row is written on the no-opinion path on purpose.** That is the only path the
  audit exists to cover. Skipping the row when the live check shrugged would blind the net to
  precisely the plays that need it.

## Evidence

- Owner report, 2026-10-12 (quoted above).
- Plex `/status/sessions/history/all` for 2026-09-12: nine section-5 items under the owner's
  account between 12:41 and 15:53, the child accounts recording nothing in that window, and
  normal attribution resuming at 16:15.
- `sensor.queuepilot_status` history, 2026-09-12 12:27:11 → 13:43:48 — the two gated starts
  above, both reporting `played: true`.
- **The audit reproduces the event end to end against live Plex.** Seeded with the two real
  pushes and pointed at the real history, `auditAttribution()` returns `unreadable: null`,
  2 pushes checked, 8 items matched and **8 findings**, each naming the set, the expected
  account and the account Plex actually used. (The ninth item, at 13:43, falls a second before
  the second push and is correctly outside both windows.)
- `server/src/accountAudit.test.ts` — 9 cases: the wrong-account finding; a correct play
  reporting nothing; **an item the push never pushed being ignored**, which is the
  false-positive case above; rows before the push and past the window; per-queue attribution
  across two consecutive gated pushes; an unstamped history row never becoming an invented
  finding; an unreadable read reported as such rather than as a clean run; and no pushes
  spending no request.
- `server/src/profiles.test.ts` — 7 cases against the REAL module, including the boundary
  being inclusive, the two-hour shape above, a claim that can never be fresh, a re-record
  restarting the window, and a backwards clock reading as age zero rather than as a future
  observation that never expires. It exists separately because
  `e2e/stubs/profiles.stub.mjs` MIRRORS this logic instead of importing it — the driver's
  resolve hooks swap the module out — and a mirror that drifts is the silent false pass
  `e2e/stubs/module-id.mjs` documents.
- `server/src/routes/accountAuditRoutes.test.ts` — 200 with findings (a mis-filed item is the
  answer, not an error), `unreadable` distinct from a clean run, and a junk `lookbackSeconds`
  falling back rather than throwing.
- `e2e/fsm-wake-and-skip-test.ts` `(bug3f)`–`(bug3f4)` — a two-hour-old matching observation
  walks the picker and still supplies the hint; a one-minute-old one still skips; `ttl 0`
  disables the skip; an ADB claim records no observation time.
- `e2e/account-audit-test.ts` `(c)`, `(c2)`, `(c3)` — the push is logged on the abstain path
  with the set, bound account and keys; logged on a confirmed-correct play; and **not** logged
  when the play failed.
- `server/src/store/schema.test.ts` kept `gated_push` honest: its ban on
  `INTEGER PRIMARY KEY AUTOINCREMENT` is about wire ids, and the column became a plain rowid
  alias rather than the gate being relaxed.

## Follow-up (not in this change)

- **The nine 2026-09-12 rows are still filed under the owner.** Re-attributing them
  (unscrobble, then scrobble under the child accounts) is a separate, destructive operation on
  the owner's library and is his call, as the eight rows from 2026-08 were.
- **Nothing publishes on the audit topic.** That is deliberate here, but it means the audit
  runs when somebody asks. A household scheduler belongs in Home Assistant, outside this repo.
- **The `set: "auto"` path is still blind**, unchanged since 2026-08-21: it resolves through
  `waitForProfile({match: null})`, the PMS-log detector that cannot match on this deployment.
  Tracked as *Repair or retire QueuePilot set:auto profile detection*.
