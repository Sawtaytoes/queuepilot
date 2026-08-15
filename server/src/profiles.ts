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
import { promises as fs } from 'node:fs';
import { statSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { errMessage } from './errors.js';
import type { CancelFlag } from './types.js';
import { PMS_LOG_PATH, PROFILE_WAIT_SECONDS, PROFILE_SET_MAP, SHIELD_IP } from './env.js';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let _lineRe: RegExp | null = null;
function lineRe(): RegExp {
  if (_lineRe === null) {
    const ip = escapeRe(SHIELD_IP);
    _lineRe = new RegExp('\\[' + ip + ':\\d+[^\\]]*\\].*Signed-in Token \\((.+?)\\)');
  }
  return _lineRe;
}

// Test seam: profiles.py rebuilds `_LINE_RE` after tests reassign SHIELD_IP. The env is read
// once at import here, so tests point PMS_LOG_PATH via env before importing; this lets a test
// force a rebuild if it must.
export function _resetLineRe(): void {
  _lineRe = null;
}

// The most recent profile the Shield was seen acting as, updated by every wait below. adb.js's
// switch will use it as a HINT (the picker opens on the current user) — never as anything that
// clears a profile gate; the switcher reads back after pressing.
export const LAST_SEEN: { title: string | null } = { title: null };

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
            LAST_SEEN.title = title;
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
