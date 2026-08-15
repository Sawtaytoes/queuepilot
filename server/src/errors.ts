/**
 * The narrowing helpers the strict-TypeScript conversion needs.
 *
 * Under `useUnknownInCatchVariables` (part of `strict`) a caught value is `unknown`, and
 * this codebase reads two things off caught values in roughly thirty places: an errno
 * `code` (`if (e.code !== 'ENOENT')` in hostConfig.js, queues.js, sets.js,
 * providers/config.js, engine/routing.js) and a message (`String(e.message || e)`). Each
 * of those is a cast at the call site unless it goes through a guard, so the guards live
 * here once rather than thirty times.
 *
 * Nothing in this module throws or logs. It is pure narrowing.
 */

import type { CancelFlag } from './types.js';

/**
 * True when `e` is an Error carrying Node's errno extras (`code`, `errno`, `path`,
 * `syscall`) — i.e. anything `fs`, `undici` or `net` rejects with.
 *
 * The test is `instanceof Error`, NOT "has a code property": a plain `{code: 'ENOENT'}`
 * from a stub would otherwise narrow to `ErrnoException` and then blow up on `.message`.
 * Callers keep their existing shape:
 *
 *     catch (e) { if (!isNodeError(e) || e.code !== 'ENOENT') throw e; }
 */
export function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error;
}

/**
 * The message to show for a caught value — the typed replacement for the ~30
 * `String(e.message || e)` sites.
 *
 * Deliberately matches that expression's behaviour rather than improving on it: an Error
 * with a blank message falls back to its `String()` form ("Error"), and a thrown non-Error
 * (a string, a number, a rejected `{error}` object) is stringified whole. Changing that
 * would change log lines and, in a few places, the sentence published to the MQTT state
 * topic and read aloud by Home Assistant.
 */
export function errMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (e != null && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (m) return String(m);
  }
  return String(e);
}

/**
 * An Error carrying the HTTP status of a failed Plex/Companion request.
 *
 * `playback.js plexReq()` (~:232-236) attaches `plexStatus` (and mirrors it onto `code`)
 * on any non-2xx, and `playRatingKeys` reads it back (~:624) to report
 * `playMedia HTTP <status>`. That round-trip is the reason this is a real class rather
 * than a bare cast: the property is written in one file and read in another, so the
 * contract needs a name.
 *
 * `code` duplicates `plexStatus` as a NUMBER, which is what the original code did — note
 * that it therefore shares a name with Node's string errno `code`. Keep both: driver.js's
 * connection-refused matching walks the errno side, and narrowing one to the other would
 * make an HTTP 500 look like a syscall failure.
 */
export class PlexError extends Error {
  readonly plexStatus: number;

  readonly code: number;

  constructor(status: number, path: string) {
    super(`plex ${status} for ${path}`);
    this.name = 'PlexError';
    this.plexStatus = status;
    this.code = status;
  }
}

/**
 * True when `e` carries a `plexStatus` — including the errors thrown before `PlexError`
 * existed (a plain `new Error()` with the property bolted on), which is why this is a
 * structural check and not `e instanceof PlexError`. Any of those may still be in flight
 * from a bundled older build or a test fixture.
 */
export function isPlexError(e: unknown): e is Error & { plexStatus: number } {
  return (
    e instanceof Error
    && typeof (e as { plexStatus?: unknown }).plexStatus === 'number'
  );
}

/**
 * Has the in-flight session been cancelled?
 *
 * The flag is duck-typed three ways (see `CancelFlag`): `.isSet()` is the JS spelling and
 * `.is_set()` the `threading.Event` one kept for Python parity. Probe order matches
 * `driver.js isCancelled()` — `isSet` first — so behaviour is unchanged. A null/absent
 * flag is NOT cancelled: most call sites pass one only when the caller owns a cancellation.
 */
export function isCancelled(flag: CancelFlag | null | undefined): boolean {
  if (!flag) return false;
  if (typeof flag.isSet === 'function') return Boolean(flag.isSet());
  if (typeof flag.is_set === 'function') return Boolean(flag.is_set());
  return false;
}
