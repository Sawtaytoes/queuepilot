// "Start over when exhausted": the THIRD completion axis, and the seam the seasonal reset
// plugs into.
//
// `keep_completed` and `reel` both make a queue non-consuming by never marking anything done.
// This one MARKS — nothing repeats while anything is unwatched — and then clears the whole
// queue's watched state the moment the last entry finishes, so a new round starts
// (decision `2026-09-08-completion-behaviour-is-one-picker-not-two-checkboxes`).
//
// ⚠️ THE CLEAR IS A SEAM, NOT AN IMPLEMENTATION. Clearing a queue's watched state is three
// stores — the `done` / `done_at` flags in `queues.yaml`, the `queue_entry_history` rows and
// the `lead_cooldown` rows — and `resetQueueWatchedState(setId)` is being built to own all
// three for the seasonal reset, which clears the same state on a DATE. Two features, one
// clear: a second implementation is the thing this file exists not to be. So the reset is
// INJECTED (`setQueueWatchedStateReset`) and the default below does the one part this branch
// can honestly do — `queues.clearDone`, which already exists and is already how a stale-done
// entry is revived. Wiring `resetQueueWatchedState` in is one call at boot and nothing else in
// this file changes.
//
// Until that wiring lands, an exhausted restart clears the done flags and leaves the ledger
// rows alone: the queue plays again, and a queue on `watch_history: queue` keeps its own
// per-item completions until the rebase.
import * as queues from './queues.js';

/**
 * Clear one queue's watched state so a new round can start.
 *
 * The signature is `resetQueueWatchedState(setId)`'s, on purpose — the wiring is an
 * assignment, not an adapter.
 */
export type QueueWatchedStateReset = (setName: string) => Promise<void>;

/**
 * The part of the clear this branch owns: strip `done` / `done_at` from every entry of the
 * set. It calls `queues.clearDone`, the same writer the stale-done revival uses, rather than
 * re-deriving what "cleared" means.
 */
async function clearDoneFlags(setName: string): Promise<void> {
  const entries = await queues.listSet(setName);
  const doneKeys = entries.filter((entry) => entry.done).map((entry) => entry.key);
  if (!doneKeys.length) return;
  await queues.clearDone(setName, doneKeys);
}

let _reset: QueueWatchedStateReset = clearDoneFlags;

/**
 * Replace the clear. `feat/seasonal-reset-core` hands this
 * `resetQueueWatchedState`, which also drops the `queue_entry_history` and `lead_cooldown`
 * rows; call it ONCE, at boot, beside the other wiring.
 */
export function setQueueWatchedStateReset(reset: QueueWatchedStateReset): void {
  _reset = reset;
}

/**
 * Is every entry of this queue done?
 *
 * Read off the FILE rather than off the resolution that just ran, because "everything is
 * done" is a statement about the queue, and the file is where `markDone` has just written.
 *
 * Two readings are deliberate:
 *
 *  - **An EMPTY queue is not exhausted.** Nothing finished, so nothing may start over —
 *    otherwise a queue somebody emptied by hand would clear itself on every scan and say so
 *    in the log forever.
 *  - **An entry that did not RESOLVE is not done.** It is unmarked in the file, so it holds
 *    the restart back. That is the conservative half: a Plex hiccup makes the queue wait a
 *    scan, where the other reading would wipe the round while an entry was still unwatched.
 */
export async function isExhausted(setName: string): Promise<boolean> {
  const entries = await queues.listSet(setName);
  if (!entries.length) return false;
  return entries.every((entry) => entry.done);
}

/**
 * Start a new round if the last entry has just finished. Returns whether it did.
 *
 * Called from `finished.applyQueueWriteSide`, which is the ONE place a curated queue's
 * completions are persisted — a scan and an end-of-playback reconcile both run it, so the
 * round restarts within seconds of the credits rather than at the next card tap.
 */
export async function restartIfExhausted(
  setName: string,
): Promise<{ restarted: boolean }> {
  if (!await isExhausted(setName)) return { restarted: false };
  await _reset(setName);
  console.log(`[finished] ${setName}: every entry is done — cleared, and a new round starts`);
  return { restarted: true };
}
