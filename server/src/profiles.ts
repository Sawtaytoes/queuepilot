// Detect which Plex Home profile the Shield's app is signed into, from the PMS log.
// A line-for-line port of queue_builder/profiles.py (D1).
//
// There is no API for "which profile is the Android TV app on right now": plex.tv's per-device
// lastSeenAt only updates on playback (verified hours stale), and the Companion endpoint
// doesn't expose the signed-in user. The one real-time signal is the Plex server's own DEBUG
// log, which stamps every request it serves with the token's profile:
//
//     ... Request: [192.0.2.30:43248 (...)] GET /photo/... Signed-in Token (Younger Kids)
//
// So: seek to the end of the log when the card is scanned, then watch for the first such line
// from the Shield's IP. While the profile picker is on screen nothing is signed in and no such
// line appears; the first one after launch IS the pick. If the app is already open on a profile
// (no picker), foregrounding it refreshes the home hubs and produces lines for the current
// profile — equally correct, since attribution follows sign-in state.
//
// Fragility, accepted knowingly (carried across from the Python): the profile stamp only exists
// on DEBUG-level PMS log lines, and this needs the Plex app's log volume mounted read-only into
// the container. If Plex's debug logging is off, waits time out and the caller says so.
import { deviceHost, deviceKey, deviceOperationCancelled } from './deviceScope.js';
import { promises as fs } from 'node:fs';
import { statSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { errMessage } from './errors.js';
import type { CancelFlag } from './types.js';
import {
  PMS_LOG_PATH,
  PROFILE_OBSERVATION_TTL_SECONDS,
  PROFILE_WAIT_SECONDS,
  PROFILE_SET_MAP,
} from './env.js';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const lineRes = new Map<string, RegExp>();
function lineRe(): RegExp {
  const host = deviceHost();
  if (!host) return /$a/;
  let re = lineRes.get(host);
  if (!re) {
    re = new RegExp('\\[' + escapeRe(host) + ':\\d+[^\\]]*\\].*Signed-in Token \\((.+?)\\)');
    lineRes.set(host, re);
  }
  return re;
}
export function _resetLineRe(): void { lineRes.clear(); }

// The most recent profile the Shield was seen acting as, updated by every wait below. adb.js's
// switch will use it as a HINT (the picker opens on the current user) — never as anything that
// clears a profile gate; the switcher reads back after pressing.
//
// `isObserved` is that rule made enforceable. Three different things write this field and
// they are NOT interchangeable:
//
//   * `waitForProfile()` below records an OBSERVATION — it matched a real PMS log line, so the
//     Shield demonstrably acted as that profile. `isObserved: true`.
//   * `driver.driveToPlaying()` records an OBSERVATION after `/status/sessions` names the
//     account on this player. That is stronger than the log because Plex itself says which
//     account owns the live session. `isObserved: true`.
//   * `driver.driveProfile()` writes a CLAIM after an ADB switch reports success — but that
//     report is only "CENTER was pressed on the right tile", never "Plex signed in". It has
//     been wrong on the TV. `isObserved: false`.
//
// Reading the claim back as if it were an observation is a cache that confirms whatever it was
// last told, and that is exactly how a Younger Kids pool played under the owner's account on
// 2026-08-18 (docs/decisions/2026-08-21-the-profile-gate-verifies-the-account-plex-is-playing-as.md).
// Only an observation may satisfy a gate; a claim is a hint for the picker walk and nothing more.
//
// `observedAt` is the SECOND half of that rule, and it exists because `isObserved` alone still
// let a gated queue play as the wrong account on 2026-09-12. An observation is a statement
// about a moment, not a standing fact: nothing tells QueuePilot that a person picked a
// different profile on the TV after the last proof, so an unexpiring one is a cache confirming
// something that stopped being true hours ago. `PROFILE_OBSERVATION_TTL_SECONDS` bounds it.
// (docs/decisions/2026-10-12-a-profile-observation-expires-and-a-gated-push-is-audited.md)
interface ProfileObservation {
  title: string | null;
  isObserved: boolean;
  observedAt: number | null;
}
const observations = new Map<string, ProfileObservation>();
function observation(): ProfileObservation {
  const key = deviceKey();
  let value = observations.get(key);
  if (!value) {
    value = { title: null, isObserved: false, observedAt: null };
    observations.set(key, value);
  }
  return value;
}
// Keep the existing API while isolating observations across asynchronous device scopes.
export const LAST_SEEN: ProfileObservation = new Proxy({} as ProfileObservation, {
  get: (_target, key) => Reflect.get(observation(), key),
  ownKeys: () => Reflect.ownKeys(observation()),
  getOwnPropertyDescriptor: (_target, key) => Object.getOwnPropertyDescriptor(observation(), key),
  set: (_target, key, value: unknown) => Reflect.set(observation(), key, value),
});

// Test seam. The TTL is the one rule here that a test cannot exercise without controlling the
// clock, and `vi.useFakeTimers()` would also freeze the poll loops in `waitForProfile`.
let now: () => number = () => Date.now();

/** Point the module's clock somewhere else. Pass nothing to restore `Date.now`. */
export function _setNow(clock?: () => number): void {
  now = clock ?? (() => Date.now());
}

/** Record a profile that Plex itself identified, never one inferred from an ADB keypress. */
export function recordObservedProfile(title: string): void {
  if (deviceOperationCancelled()) return;
  LAST_SEEN.title = title;
  LAST_SEEN.isObserved = true;
  LAST_SEEN.observedAt = now();
}

/**
 * Record a title an ADB switch CLAIMED. Keeps it as the picker's navigation hint and strips
 * every trace of authority, so a later gate cannot read the claim back as proof.
 */
export function recordProfileClaim(title: string): void {
  if (deviceOperationCancelled()) return;
  LAST_SEEN.title = title;
  LAST_SEEN.isObserved = false;
  LAST_SEEN.observedAt = null;
}

/** Keep a title as a picker hint, but prevent stale evidence from clearing a profile gate. */
export function invalidateObservedProfile(): void {
  if (deviceOperationCancelled()) return;
  LAST_SEEN.isObserved = false;
  LAST_SEEN.observedAt = null;
}

/**
 * Is the current observation recent enough to clear a profile gate?
 *
 * False when there is no observation at all, and false once it is older than
 * `PROFILE_OBSERVATION_TTL_SECONDS`. A TTL of 0 or less disables the fast path outright,
 * which is the setting for a deployment that would rather spend the picker walk every time.
 */
export function isObservationFresh(): boolean {
  if (!LAST_SEEN.isObserved || LAST_SEEN.observedAt == null) return false;
  if (PROFILE_OBSERVATION_TTL_SECONDS <= 0) return false;
  return now() - LAST_SEEN.observedAt <= PROFILE_OBSERVATION_TTL_SECONDS * 1000;
}

/** How old the current observation is, in seconds, or null when there is none. */
export function observationAgeSeconds(): number | null {
  if (LAST_SEEN.observedAt == null) return null;
  return Math.max(0, Math.round((now() - LAST_SEEN.observedAt) / 1000));
}

// Map a Plex Home profile title to a set name, or null if unmapped. (config.set_for_profile)
export function setForProfile(title: string): string | null {
  return PROFILE_SET_MAP[title] ?? null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Options for `waitForProfile`. `poll` is in SECONDS (not ms) and `timeout` is too — both
 * carried across from the Python, where they were `float` seconds; the multiplications by
 * 1000 below are the only place that is visible.
 */
export interface WaitForProfileOptions {
  /** null = fall back to the deploy-time `PROFILE_WAIT_SECONDS`. */
  timeout?: number | null;
  cancel?: CancelFlag | null;
  poll?: number;
  match?: string | null;
}

// Block until the Shield makes a PMS request under a signed-in profile.
//
// Tails PMS_LOG_PATH from its CURRENT end (only lines newer than the call, so a scan never
// matches yesterday's viewing). Survives log rotation by reopening when the file's inode
// changes, and truncation by seeking back to 0. Returns the profile title, or null on
// timeout / cancel / unreadable log.
//
// With `match` set (a set's requires_profile), profiles OTHER than that one are skipped rather
// than returned, so the wait spans the on-screen profile switch. Without it, the FIRST
// signed-in profile wins (the `auto` cards, where whoever is signed in IS the answer).
//
// `cancel` is any object with a `.isSet()` method (mirrors the Python threading.Event); poll
// is the seconds between reads (default 0.5, matching the Python).
export async function waitForProfile(
  { timeout = null, cancel = null, poll = 0.5, match = null }: WaitForProfileOptions = {},
): Promise<string | null> {
  const timeoutS = timeout == null ? PROFILE_WAIT_SECONDS : timeout;
  const deadline = Date.now() + timeoutS * 1000;
  const path = PMS_LOG_PATH;

  let fh: FileHandle;
  try {
    fh = await fs.open(path, 'r');
  } catch (e) {
    console.log(`[profiles] cannot open ${path}: ${errMessage(e)}`);
    return null;
  }

  try {
    // Seek to end: track the byte offset we have consumed, plus the inode for rotation
    // detection, exactly like the Python's f.seek(0, SEEK_END) + fstat().st_ino.
    const st = await fh.stat();
    let pos = st.size;
    let ino = st.ino;
    let carry = ''; // a partial trailing line held until its newline arrives

    while (Date.now() < deadline) {
      if (cancel && cancel.isSet && cancel.isSet()) return null;

      const cur = await fh.stat();
      if (cur.size > pos) {
        const len = cur.size - pos;
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, pos);
        pos += bytesRead;
        const text = carry + buf.toString('utf8', 0, bytesRead);
        const lines = text.split('\n');
        carry = lines.pop() ?? ''; // last element is a partial line (no trailing \n)
        for (const line of lines) {
          // Group 1 is mandatory in the pattern, so `!== undefined` here is exactly the
          // old `if (m)` — it is only spelled this way because the match array is
          // index-checked under noUncheckedIndexedAccess.
          const title = lineRe().exec(line)?.[1];
          if (title !== undefined) {
            // An OBSERVATION: the Shield served a request under this profile. The other
            // trusted observation is `/status/sessions`; both go through the same writer.
            recordObservedProfile(title);
            if (match === null || title === match) return title;
            // Signed in, but as the wrong profile: keep waiting for the switch.
            console.log(`[profiles] saw '${title}', holding out for '${match}'`);
          }
        }
        continue; // there may be more buffered — loop again before sleeping
      }

      // No new data: check for rotation/truncation before sleeping (mirrors the Python).
      try {
        const check = statSync(path);
        if (check.ino !== ino) {
          // Rotated: the new file's whole content is fresh — reopen and read from 0.
          await fh.close();
          fh = await fs.open(path, 'r');
          const ns = await fh.stat();
          ino = ns.ino;
          pos = 0;
          carry = '';
          continue;
        }
        if (check.size < pos) {
          pos = 0; // truncated in place
          carry = '';
        }
      } catch {
        /* stat failed transiently — keep going */
      }
      await sleep(poll * 1000);
    }
    return null;
  } finally {
    await fh.close();
  }
}
