# An `unauthorized` adb record is dropped and re-handshaken, not retried

- **Status:** Accepted
- **Date:** 2026-08-22
- **Type:** Bug fix / reliability
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [2026-08-21-the-profile-gate-verifies-the-account-plex-is-playing-as](2026-08-21-the-profile-gate-verifies-the-account-plex-is-playing-as.md)

## Decision

`adb.connect()` no longer treats `get-state` as a yes/no answer. It reads the actual state
word, and when that word is **`unauthorized`** or **`offline`** it runs `adb disconnect` and
connects again, once. Anything else is reported as before.

Two supporting changes make that possible:

- **`deviceState()`** reads `get-state`'s stdout *and* stderr. `run()` cannot be used here —
  it maps a non-zero exit to `null`, and both `unauthorized` and `offline` exit non-zero, so
  every wedged state looked identical to "the Shield is off".
- **`disconnect()`** is private and is called from exactly one place. It must not be used to
  tidy up after a command: the next call would pay a full handshake, and a disconnect during
  a picker walk would strand it.

## Context

Every profile-gated play failed for hours on 2026-08-22, with the same spoken error:

> `'<queue>' needs the '<profile>' Plex profile, and the Shield did not switch to it. Pick it
> on the TV.`

The container log held **49** consecutive `[adb] get-state: rc=1 error: device unauthorized`
lines and, after each pair, `[driver] switch attempt 1/2 … failed: cannot reach … over adb`.

The key was not the problem. `adbkey` was untouched since the day ADB was enabled, and the
Shield still trusted it — a single `adb disconnect` followed by `adb connect` returned
`device` immediately, with no on-TV prompt.

The problem was the adb **server's** connection record. When the Shield reboots, or its adbd
restarts, the server keeps an entry for the target in `unauthorized` (or `offline`).
`adb connect` is idempotent *against that entry*: it sees a record, reports "already
connected", and never re-handshakes. `connect()` then asked `get-state`, got a non-zero exit,
and returned `false`.

So the wedge was permanent. It survived every retry, every later play and every card scan for
the remaining life of the container. The two-attempt retry in `driver.ts` could not help,
because both attempts re-entered the same idempotent no-op. Only a container restart — or a
human running `adb disconnect` — cleared it.

## Why

- **The failure is silent where it matters.** The user sees "Pick it on the TV", walks over,
  and finds the profile already correct. Nothing in that message suggests adb.
- **Idempotence is the trap.** `adb connect` being safe to call repeatedly is exactly why
  calling it repeatedly fixes nothing. The recovery has to invalidate the record first.
- **One retry, not a loop.** If the key is genuinely untrusted, the second attempt returns
  `unauthorized` too, the state is logged by name, and the caller fails as it always did. The
  cost of being wrong is one extra round trip per play.
- **`offline` gets the same treatment** because it wedges the same way, for the same reason.

## Evidence

- Container log, 2026-08-22: 49 x `device unauthorized`; `[driver] switch attempt 1/2` and
  `2/2` after each; `[mqttd] session/start` for four separate plays, all failing the gate.
- `adb disconnect <target>` then `adb connect <target>` → `connected`, and `get-state` →
  `device`, with **no** on-TV authorization prompt. That is what proves the key was fine and
  the record was stale.
- `adbkey` / `adbkey.pub` mtimes unchanged since ADB was first enabled.

## Notes

- The recovery cannot help when the Shield has genuinely revoked the key. That still needs
  someone to accept the on-TV prompt, and the log now says `unauthorized` by name twice
  rather than once.
- Nothing about the gate's semantics changes. `waitForProfile()` is still the only thing that
  clears a gate, and an unreachable Shield still fails the play rather than passing it.
