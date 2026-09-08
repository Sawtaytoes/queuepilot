// "Start over when exhausted": the THIRD completion axis, and the seam the seasonal reset
// plugs into.
//
// `keep_completed` and `reel` both make a queue non-consuming by never marking anything done.
// This one MARKS — nothing repeats while anything is unwatched — and then clears the whole
// queue's watched state the moment the last entry finishes, so a new round starts
// (decision `2026-09-08-completion-behaviour-is-one-picker-not-two-checkboxes`).
//
// ⚠️ THE CLEAR IS A SEAM, NOT AN IMPLEMENTATION, AND THE SEAM IS NOW FILLED. Clearing a
// queue's watched state is three stores — the `done` / `done_at` flags in `queues.yaml`, the
// `queue_entry_history` rows and the `lead_cooldown` rows — and
// `watchedReset.resetQueueWatchedState(setId)` owns all three for the seasonal reset, which
// clears the same state on a DATE (decision
// `2026-09-08-a-queue-can-clear-its-own-watched-state-on-a-date-each-year`). Two features, one
// clear: a second implementation is the thing this file exists not to be.
//
// This file wrote a weaker one while that function was on another branch — `queues.clearDone`
// alone, which left the ledger rows behind, so a queue on `watch_history: queue` restarted a
// round it was still recorded as having watched. That default is DELETED.
//
// ⚠️ THE DEFAULT IS THE REAL RESET, not a boot-time injection, and the difference is not a
// preference. `finished.applyQueueWriteSide` runs inside `session.startSession`, and every
// offline session harness (`e2e/keep-completed-test.ts`, `e2e/seasonal-reset-test.ts`, and any
// written after them) imports `session.js` directly and never reaches `index.ts`. A wiring
// call at boot would therefore be live in production and absent from every gate — which is a
// second implementation again, wearing a different hat. `setQueueWatchedStateReset` stays, and
// its one caller is `e2e/completion-mode-test.ts`, which replaces the clear with a recorder to
// prove the exhaustion rule decides WHEN and nothing else.
import * as queues from './queues.js';
import { resetQueueWatchedState } from './watchedReset.js';

/**
 * Clear one queue's watched state so a new round can start.
 *
 * The signature is `resetQueueWatchedState(setId)`'s first parameter, so a substitute a gate
 * supplies needs to know nothing about reasons or counts.
 */
export type QueueWatchedStateReset = (setName: string) => Promise<void>;

/**
 * The real clear, adapted to this seam's shape rather than the other way round.
 *
 * The adapter exists for the REASON, not for the signature: `resetQueueWatchedState` settles
 * `queue_watched_reset` with why it ran, and an exhausted round is neither the Actions menu
 * (`manual`) nor a date (`MM-DD`). It is `exhausted`, and the log and the API say so.
 *
 * ⚠️ It DOES settle the seasonal clock, and that is correct rather than a coupling accident.
 * `settled_at` means *no occurrence at or before this moment owes this queue a reset* — and
 * after a restart the queue's watched state is empty, so every past occurrence has nothing
 * left to clear. Settling here stops a seasonal reset firing seconds later to clear nothing.
 * It cannot swallow a reset that was owed: `applySeasonalReset` runs in `session.startSession`
 * BEFORE `provider.buckets()`, and `restartIfExhausted` runs in the write side AFTER it, so
 * within one play the seasonal reset always goes first.
 */
const resetForExhaustion: QueueWatchedStateReset = async (setName) => {
  await resetQueueWatchedState(setName, { reason: 'exhausted' });
};

let _reset: QueueWatchedStateReset = resetForExhaustion;

/**
 * Replace the clear.
 *
 * Not the production wiring — the default above already is that. This exists so a gate can
 * prove the exhaustion rule decides WHEN independently of what the clear does;
 * `e2e/completion-mode-test.ts` is its one caller.
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
