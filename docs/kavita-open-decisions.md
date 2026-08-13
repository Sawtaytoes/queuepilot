# Two decisions this build deliberately did NOT make

**Written 2026-08-13, alongside the Kavita provider.** Everything else in the Kavita brief is
built and gated. These two are the owner's, and the code is written so that neither can be
answered by accident.

---

## 1. The provider control in the queue editor

**Status: waiting on the owner. Mocked, not built.**

The queue editor's block now has a provider concept, and the control that picks the provider
is genuinely unresolved. The owner revised the model twice — `Listbox`, then "Combobox with
multiselect", then arrived at the real model and **withdrew the control question himself**:

> "So I think this whole section needs to be able to be added multiple times. I might be wrong
> on the list/combobox thing"

So the unit that repeats is **the whole block** — "Plays under profile" *plus* "Libraries this
queue can search & hold" — not a picker inside it. That part is settled and is what the storage
layer implements. What the *control* is, is not.

This is a "make this look better" task, which has a house procedure: mock it in HTML, serve it,
let him choose, and only then build
([runbook](../../agentic/docs/runbooks/ui-design-previews.md) ·
[decision](../../agentic/docs/decisions/2026-07-25-preview-ui-changes-as-served-html.md)).

**The mockup:** [`previews/2026-08-13-provider-blocks.html`](previews/2026-08-13-provider-blocks.html)
· [render](previews/2026-08-13-provider-blocks.png)

It covers the three states the brief asked for, plus the current state for comparison:

| Panel | What it answers |
| --- | --- |
| **Today** | The block as it ships now — no provider concept, Plex-only help text |
| **A — Listbox** | Matches "Plays under profile" and "Type" exactly; nothing new to learn |
| **B — Segmented** | Every option visible without opening anything; good at 2-3, bad at 10 |
| **C — Combobox** | Overkill at two providers; the only one that survives Jellyfin + Emby + Kodi |
| **Three blocks** | What repetition actually looks like, and add/remove affordances |
| **C1 / C2** | The one-provider case: hide the control, or show it disabled with a reason |

Whatever wins, two constraints are already fixed and are not part of the question: it is **not a
native `<select>`**
([ADR](decisions/2026-08-07-plex-channels-pickers-are-listbox-not-native-select.md)) and it comes
from **Charcuterie**
([ADR](decisions/2026-07-31-frontend-is-react-typescript-vite-tailwind-on-charcuterie-tokens.md)).

### The profile copy has to move with it

Today's help text is Plex-only:

> "Locks this queue to a Plex Home profile — a scan waits (and switches the Shield) until that
> profile is signed in before it plays."

None of that is true for Kavita: there is no Shield to switch and no scan to wait on, and the
equivalent concept is **which Kavita user owns the reading list** — which fails *silently*, with
an empty reader and no error, if it is got wrong (feasibility §6). So the label, the help text
**and** the option list must come from the provider rather than be hardcoded in the modal. The
mockup's three-block panel shows both wordings side by side.

Four profile ADRs are load-bearing for the NFC cards and must be read before this is touched:
[sets-can-require-a-plex-profile](decisions/2026-07-25-sets-can-require-a-plex-profile.md) ·
[cards-name-a-profile-and-the-scan-waits-for-it](decisions/2026-07-26-cards-name-a-profile-and-the-scan-waits-for-it.md) ·
[choose-profile-for-queues](decisions/2026-08-07-choose-profile-for-queues.md) ·
[default-profile-per-channel](decisions/2026-08-07-default-profile-per-channel.md)

---

## 2. What a MIXED queue hands off

**Status: waiting on the owner. Stored, refused at runtime.**

N blocks means one queue can span Plex *and* Kavita. That is a change to the **seam**, not a UI
affordance:

- `buckets()` would run per block and the results merge before `buildRotation` interleaves them.
  That part is mechanical and `buildRotation` is already backend-neutral.
- **`materialize` / `handoff` stop having one answer.** A mixed queue is a playQueue *and* a
  reading list — a push target and a pull URL **at once**. There is no obvious right answer:

  | Candidate | What it means |
  | --- | --- |
  | Push the Plex half, ignore the rest | The reading half silently never happens |
  | Return both, let the UI choose | The NFC card has no UI to choose with |
  | Split by delivery at start time | Two artifacts per scan; what does the card do? |
  | Refuse mixed queues entirely | Simplest, and may be the right answer |

The owner said on 2026-08-13 that mixing is **"something to look into in the future"** while the
UI should already support repeating the block. So this build does exactly that:

- **Storage takes N blocks now**, faithfully, including mixed ones — so supporting mixing later
  is an additive change rather than a migration.
- **Runtime refuses to guess.** `resolveSingle()` in
  [`server/src/providers/blocks.js`](../server/src/providers/blocks.js) *throws* on a mixed set,
  and the launcher answers `501` with a named reason. There is a test whose entire purpose is to
  fail if someone makes it return a provider instead
  (`e2e/provider-seam-test.mjs`, "a mixed set THROWS rather than silently picking a provider").

**Do not "fix" that throw by choosing a winner.** If it starts returning a provider, the
implementation has answered a question that was routed to the owner on purpose.

---

## What IS built and gated

For contrast, so this file is not mistaken for the state of the feature:

- The seam is widened; the Plex provider is a rewrap and every golden-corpus parity gate is
  byte-identical.
- Provider definitions (plaintext) and tokens (`0600`, write-only, outside the undo/backup
  machinery) resolve `env > file > NOT CONFIGURED`, and unset fails loudly by name.
- The Kavita provider does `buckets` / `progressState` / `materialize` / `handoff` for real, and
  was verified read-only against the live instance on 2026-08-13.
- `GET /go/<setId>` 302s a reading queue into the reader deep link.
- Two offline suites, wired into CI, running with no token and no network.
