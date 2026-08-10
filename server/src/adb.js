// Drive the Shield's Plex profile picker over ADB, so a gated card can switch itself.
// A line-for-line port of queue_builder/adb.py (D5).
//
// `requires_profile` (and a card's explicit `profile`) blocks a scan until the Shield is
// signed into the right Plex Home profile. Without ADB the only way to satisfy that gate is a
// human walking to the TV and picking the profile. This module closes the loop: read the
// picker, press D-pad toward the target, commit.
//
// **The ADB press is never proof.** `uiautomator dump` reports what is on SCREEN, not who is
// signed IN — those are different questions, and only the PMS log answers the second (see
// profiles.js). So this module's job ends at "I pressed center on the right tile";
// `profiles.waitForProfile({ match })` remains the sole thing that clears a gate. A failure
// here is therefore never fatal — it just falls back to waiting for a human.
//
// Safety, because this injects key events into whatever is on the family TV:
//
// * Off unless `ADB_ENABLED`.
// * Every press batch is guarded by BOTH the foreground activity being Plex's
//   `PickUserActivity` AND a named selected tile being present in the dump. The picker is
//   transient — it vanishes the moment a profile is chosen — and pressing D-pad after that
//   injects into whatever Plex screen came up.
// * The press loop is hard-bounded (`ADB_MAX_PRESSES`) and bails the moment a press stops
//   moving the selection, which is how a non-wrapping end of the list shows up.
//
// Reading the selection: the dump carries several tiles, but only the selected one exposes
// its NAME, as a `com.plexapp.android:id/title_text` TextView. Roughly a dozen nodes carry
// `selected="true"` (it propagates down the selected tile's subtree), so the title_text
// resource-id is the anchor, not the selected attribute alone. The RecyclerView is
// virtualised, so the full profile list is NOT readable from a dump — hence `profileOrder()`
// derives it from plex.tv instead, always verified by read-back.
//
// Speed: `uiautomator dump` costs ~1.9s here and every other adb call is under 50ms, while
// `input` costs ~700ms per invocation regardless of how many keycodes it carries. So the
// whole design is "batch every press into one `input` call, and dump as rarely as possible".
//
// Implementation notes vs Python:
// * CLI is still the `adb` binary (spawnSync), not pure TCP — same trust/auth path as adb.py.
// * Long waits are `async`/await so a future Node driver can interleave with waitForProfile.
// * Pure helpers (order index/offset, XML selection parse) are exported for offline unit tests.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ADB_BIN,
  ADB_ENABLED,
  ADB_KEY_PATH,
  ADB_MAX_PRESSES,
  ADB_PICKER_WAIT_SECONDS,
  ADB_PLEX_LAUNCH_WAIT_SECONDS,
  ADB_PROFILE_ORDER,
  ADB_PROFILE_ORDER_CACHE,
  ADB_PROFILE_ORDER_TTL,
  ADB_RESTART_TO_PICKER,
  ADB_TARGET,
  ADB_TIMEOUT,
} from './env.js';

const PICKER_ACTIVITY = 'PickUserActivity';
const HOME_ACTIVITY = 'HomeActivityTV';
const MODAL_ACTIVITY = 'ListDualPaneModalActivity';
const PLEX_PKG = 'com.plexapp.android';
export const TITLE_ID = `${PLEX_PKG}:id/title_text`;
const DUMP_PATH = '/sdcard/plex-channels-ui.xml';

// How many BACK presses to spend getting from a player/detail screen to Home.
// Mutable so integration/unit tests can zero them (mirrors adb.py module-level knobs).
export let MAX_BACKS = 3;
// The recycler animates the scroll; read back too fast and you sample mid-flight. Kept short
// because the ~1.9s dump that usually follows is itself far more settling time than the UI needs.
export let SETTLE = 0.35;
// HomeActivityTV goes foreground before its hubs can take a D-pad press. Hold still this long
// before walking the sidebar, or the presses land on a screen that is still rendering.
export let HOME_SETTLE = 2.0;
// How long to let the panel come up after a WAKEUP before re-reading the foreground.
export let WAKE_SETTLE = 1.0;
// Attempts at Plex's own Switch-user route before falling back to a force-stop.
export let MAX_MENU_TRIES = 2;

const sleep = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));

function isCancelled(cancel) {
  if (!cancel) return false;
  // profiles.js uses isSet(); a Python Event (if ever bridged) uses is_set().
  if (typeof cancel.isSet === 'function') return cancel.isSet();
  if (typeof cancel.is_set === 'function') return cancel.is_set();
  return false;
}

// --- adb env / run ------------------------------------------------------------ //

function envForAdb() {
  // Point adb at the key the Shield already trusts.
  //
  // A key adb generates itself would be unauthorized, and accepting it needs an on-TV
  // prompt nobody is there to answer — so the authorized private key is mounted at
  // ADB_KEY_PATH instead.
  //
  // Getting adb to actually READ it takes all three of these. adb 1.0.41 (Debian trixie)
  // ignores ANDROID_USER_HOME and derives its key dir from $HOME — which is unset for the
  // container's 568:568 user, so it tries to mkdir '//.android' and dies before it ever
  // connects. HOME is therefore the load-bearing one; the other two cover newer adb
  // builds and a key kept somewhere other than <HOME>/.android.
  const env = { ...process.env };
  const key = ADB_KEY_PATH;
  if (key && existsSync(key)) {
    const keyDir = path.dirname(key);
    env.HOME = path.dirname(keyDir);
    env.ANDROID_USER_HOME = keyDir;
    env.ADB_VENDOR_KEYS = key;
  }
  return env;
}

/** Run an adb command. Returns stdout on success, null on any failure. */
export function run(args, timeoutSec = null) {
  const timeoutMs = (timeoutSec == null ? ADB_TIMEOUT : timeoutSec) * 1000;
  try {
    const p = spawnSync(ADB_BIN, ['-s', ADB_TARGET, ...args], {
      encoding: 'utf8',
      env: envForAdb(),
      timeout: timeoutMs,
      // maxBuffer: uiautomator dumps can be a few hundred KB.
      maxBuffer: 8 * 1024 * 1024,
    });
    if (p.error) {
      // spawnSync puts TimeoutExpired-style failures on .error (ETIMEDOUT) or signal.
      console.log(`[adb] ${args.join(' ')}: ${p.error.message}`);
      return null;
    }
    if (p.status !== 0) {
      const err = String(p.stderr || '')
        .trim()
        .slice(0, 200);
      console.log(`[adb] ${args.join(' ')}: rc=${p.status} ${err}`);
      return null;
    }
    return p.stdout ?? '';
  } catch (e) {
    console.log(`[adb] ${args.join(' ')}: ${e.message}`);
    return null;
  }
}

/** Idempotent — 'already connected' is success. Returns true if the device is up. */
export function connect() {
  try {
    spawnSync(ADB_BIN, ['connect', ADB_TARGET], {
      encoding: 'utf8',
      env: envForAdb(),
      timeout: ADB_TIMEOUT * 1000,
    });
  } catch (e) {
    console.log(`[adb] connect ${ADB_TARGET}: ${e.message}`);
    return false;
  }
  const out = run(['get-state']);
  return Boolean(out && out.trim() === 'device');
}

/** The focused window's component, e.g. 'com.plexapp.android/...PickUserActivity'. */
export function foregroundActivity() {
  // No `grep -m1`: closing the pipe early makes dumpsys fail with a broken pipe, which
  // would surface as a command failure. Let it finish and take the first match here.
  const out = run(['shell', 'dumpsys window | grep mCurrentFocus']);
  if (!out) return null;
  const m = out.match(/(\S+\/\S+)\}/);
  return m ? m[1] : null;
}

/**
 * True if the Shield's display is awake, false if dozing/asleep, null if unreadable.
 *
 * Reads `dumpsys power` wakefulness (Awake / Dozing / Asleep / Dreaming) so ensurePlexOpen
 * can decide whether a WAKEUP must precede the Plex launch. A null (unreadable) is treated by
 * the caller as "not known-awake", i.e. wake to be safe.
 */
export function isAwake() {
  const out = run(['shell', 'dumpsys power | grep mWakefulness']);
  if (!out) return null;
  const m = out.match(/mWakefulness=(\w+)/);
  if (!m) return null;
  return m[1].trim().toLowerCase() === 'awake';
}

/**
 * Foreground the Shield's Plex app via its `plex://` deep link if it isn't already up.
 *
 * Unlike restartToPicker() this NEVER force-stops: if Plex is already foreground (playing
 * or on Home) it is left untouched, so a running movie is never interrupted. Best-effort —
 * returns true if Plex is (now) foreground, false if ADB is unreachable or Plex didn't come
 * up in time (the caller still tries; HA may have launched it).
 */
export async function ensurePlexOpen(wait = null) {
  if (!connect()) return false;
  let act = foregroundActivity() || '';
  if (act.includes(PLEX_PKG)) return true;
  // device_on transition: a dozing / screen-off Shield reports a null or screensaver
  // foreground, and `am start plex://` on a SLEEPING device does not bring Plex forward —
  // the launch queues behind the dream. WAKEUP is safe to send blind (it cannot select or
  // dismiss anything) and restores whatever was up behind the screensaver, so wake FIRST when
  // the device isn't already awake, then re-read (the wake alone may have brought Plex back).
  if (isAwake() !== true || !act) {
    console.log(`[adb] Shield not awake (foreground '${act || 'unknown'}'); sending WAKEUP`);
    await press('KEYCODE_WAKEUP');
    await sleep(WAKE_SETTLE);
    act = foregroundActivity() || '';
    if (act.includes(PLEX_PKG)) {
      console.log('[adb] Plex is foreground after waking the Shield');
      return true;
    }
  }
  console.log(`[adb] Plex not foreground (on '${act || 'unknown'}'); launching via plex://`);
  if (
    run(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'plex://']) === null
  ) {
    return false;
  }
  const waitS = wait == null ? ADB_PLEX_LAUNCH_WAIT_SECONDS : wait;
  const deadline = Date.now() + waitS * 1000;
  while (Date.now() < deadline) {
    if ((foregroundActivity() || '').includes(PLEX_PKG)) {
      console.log('[adb] Plex is foreground');
      return true;
    }
    await sleep(0.5);
  }
  console.log('[adb] Plex did not reach the foreground in time');
  return false;
}

// --- UI dump / selection ------------------------------------------------------ //

/**
 * Parse attribute bags out of every `<node ...>` in a uiautomator dump.
 * No external XML dependency — the dump is a flat attribute soup we only need attrs from.
 */
export function parseUiNodes(xml) {
  if (!xml) return [];
  const cleaned = String(xml).replace(/\r/g, '').trim();
  const nodes = [];
  const re = /<node\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const attrs = {};
    const attrRe = /([\w:.-]+)="([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(m[1])) !== null) {
      attrs[am[1]] = am[2];
    }
    nodes.push(attrs);
  }
  return nodes;
}

/**
 * The NAME on the currently-highlighted picker tile from a dump string, or null.
 * Exported so unit tests can feed recorded fixtures without a device.
 */
export function selectedProfileFromXml(xml) {
  for (const node of parseUiNodes(xml)) {
    if (
      node['resource-id'] === TITLE_ID &&
      node.selected === 'true' &&
      (node.text || '').trim()
    ) {
      return node.text.trim();
    }
  }
  return null;
}

function dumpXml() {
  // Dump and cat are one shell invocation to save a round trip; `--compressed` is not
  // faster and drops the title_text nodes we need, so don't reach for it.
  return run(['shell', `uiautomator dump ${DUMP_PATH} >/dev/null && cat ${DUMP_PATH}`]);
}

/** The NAME on the currently-highlighted picker tile, or null if not on the picker. */
export function selectedProfile() {
  const xml = dumpXml();
  if (!xml) return null;
  try {
    return selectedProfileFromXml(xml);
  } catch (e) {
    console.log(`[adb] unparseable uiautomator dump: ${e.message}`);
    return null;
  }
}

/**
 * (isReady, selectedName). Both conditions must hold before ANY press.
 *
 * `known` skips the ~1.9s dump by trusting a caller-supplied guess at the selection
 * (see profiles.LAST_SEEN). Safe only because every caller reads back after pressing.
 */
export function pickerReady(known = null) {
  const act = foregroundActivity();
  if (!act || !act.includes(PLEX_PKG) || !act.includes(PICKER_ACTIVITY)) {
    return [false, null];
  }
  if (known) return [true, known];
  const name = selectedProfile();
  return [name != null, name];
}

/**
 * Send key events in ONE `input` call. Pass `[code, n]` to repeat a code n times.
 *
 * `settle` is only needed when the NEXT thing done is another press that depends on the
 * UI having caught up. When a ~1.9s dump follows, that is already far more settling than
 * the UI needs, so the default is not to sleep at all.
 */
export async function press(...keycodes) {
  // Optional trailing options object: press('X', { settle: 0.35 }) or press(['X', 2], { settle }).
  let settle = 0;
  let codes = keycodes;
  if (
    keycodes.length &&
    typeof keycodes[keycodes.length - 1] === 'object' &&
    !Array.isArray(keycodes[keycodes.length - 1])
  ) {
    const opts = keycodes[keycodes.length - 1] || {};
    settle = opts.settle || 0;
    codes = keycodes.slice(0, -1);
  }
  const keys = [];
  for (const k of codes) {
    if (Array.isArray(k)) {
      const [code, n] = k;
      for (let i = 0; i < n; i++) keys.push(code);
    } else {
      keys.push(k);
    }
  }
  if (!keys.length) return true;
  if (run(['shell', 'input', 'keyevent', ...keys]) === null) return false;
  if (settle) await sleep(settle);
  return true;
}

// --- profile order (alias groups) -------------------------------------------- //

const ORDER = { titles: null, at: 0 };

/** Test seam: drop the in-memory order cache (env override still wins). */
export function _resetOrderCache() {
  ORDER.titles = null;
  ORDER.at = 0;
}

/**
 * Normalise an order to alias GROUPS, accepting the old flat list of names.
 *
 * A cache written before aliases existed (or a hand-set ADB_PROFILE_ORDER env) is a
 * flat ["Bob Smith", ...]; both forms have to keep working.
 */
export function asGroups(order) {
  return (order || []).map((g) => (typeof g === 'string' ? [g] : [...g]));
}

/** Position of the picker slot `name` refers to, by any alias, or null. */
export function indexOfName(order, name) {
  for (let i = 0; i < order.length; i++) {
    if (order[i].includes(name)) return i;
  }
  return null;
}

/**
 * Signed press count from current to target given an order, or null if either is unknown.
 * Pure — used by unit tests and by `_offset` after `profileOrder()` resolves.
 */
export function offsetBetween(order, current, target) {
  const iCur = indexOfName(order, current);
  const iTgt = indexOfName(order, target);
  if (iCur == null || iTgt == null) return null;
  return iTgt - iCur;
}

/**
 * Do two names refer to the same picker slot under `order`? Falls back to string equality.
 * Pure helper for offline tests (no network / cache).
 */
export function sameProfileInOrder(order, a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ia = indexOfName(order, a);
  const ib = indexOfName(order, b);
  return ia != null && ia === ib;
}

async function fetchHomeUserNames() {
  // Local import: adb must stay importable without a Plex reachable (mirrors adb.py).
  const plex = await import('./plex.js');
  if (typeof plex.homeUserNames === 'function') {
    return await plex.homeUserNames();
  }
  // Derive alias groups from the UI-facing homeUsers() shape. plex.tv title / friendlyName /
  // username all land as aliases so the owner ('sawtaytoes' vs display title) matches.
  if (typeof plex.homeUsers !== 'function') {
    throw new Error('plex.homeUsers / homeUserNames unavailable');
  }
  const users = await plex.homeUsers();
  const out = [];
  for (const u of users || []) {
    const names = [];
    for (const n of [u.name, u.title, u.friendlyName, u.username]) {
      if (n && !names.includes(n)) names.push(n);
    }
    if (names.length) out.push(names);
  }
  return out;
}

/**
 * Picker order, newest-first by source: manual override > plex.tv > disk cache.
 *
 * Returns a list of ALIAS GROUPS — one group per picker slot, in picker order — because the
 * picker and plex.tv disagree on what to call the owner. Match with `indexOfName`, never `in`.
 *
 * Returns [] if every source fails — callers must treat that as "cannot compute a direction"
 * rather than guessing.
 */
export async function profileOrder() {
  if (ADB_PROFILE_ORDER && ADB_PROFILE_ORDER.length) {
    return asGroups(ADB_PROFILE_ORDER);
  }
  const now = Date.now() / 1000;
  if (ORDER.titles && now - ORDER.at < ADB_PROFILE_ORDER_TTL) {
    return ORDER.titles;
  }
  let names = [];
  try {
    names = await fetchHomeUserNames();
  } catch (e) {
    console.log(`[adb] plex.tv home users unavailable (${e.message}); using cached order`);
    names = [];
  }
  if (names && names.length) {
    ORDER.titles = names;
    ORDER.at = now;
    try {
      writeFileSync(ADB_PROFILE_ORDER_CACHE, JSON.stringify(names));
    } catch (e) {
      console.log(`[adb] could not cache the picker order: ${e.message}`);
    }
    return names;
  }
  if (ORDER.titles) return ORDER.titles;
  try {
    const cached = asGroups(JSON.parse(readFileSync(ADB_PROFILE_ORDER_CACHE, 'utf8')));
    if (cached.length) {
      ORDER.titles = cached;
      return cached;
    }
  } catch {
    /* missing / corrupt cache */
  }
  return [];
}

/**
 * Do two names refer to the same picker slot? Falls back to string equality.
 *
 * The gate's `requires_profile` is the PMS log's string and the dump reads the picker
 * tile's; for the owner those differ ('sawtaytoes' vs 'Bob Smith'), so comparing them
 * with === would leave switchTo pressing forever, never satisfied.
 */
export async function sameProfile(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const order = await profileOrder();
  return sameProfileInOrder(order, a, b);
}

async function offset(current, target) {
  // Fast path only. The list is NOT assumed to wrap — a shorter wrap-around route is never
  // taken, because whether the picker wraps at the ends is unverified.
  const order = await profileOrder();
  return offsetBetween(order, current, target);
}

async function waitActivity(fragment, timeout = 8.0, poll = 0.2) {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const act = foregroundActivity() || '';
    if (act.includes(fragment)) return true;
    await sleep(poll);
  }
  return false;
}

/**
 * Walk Plex's own "Switch user" path back to the picker. Returns true on success.
 *
 * Verified 2026-07-26: LEFT (open sidebar) -> UP to the pinned user -> CENTER ->
 * ListDualPaneModalActivity -> CENTER on "Switch user" -> PickUserActivity.
 */
export async function pickerViaMenu(attempt = 1) {
  console.log(
    `[adb] signed in with no picker; trying Plex's own Switch-user path ` +
      `(attempt ${attempt}/${MAX_MENU_TRIES})`,
  );
  // A previous attempt may have left the sidebar half-open or focus somewhere odd, and
  // this walk assumes it starts on the hubs. BACK returns to a known state; on a clean
  // first attempt there is nothing to undo, so only retries pay for it.
  if (attempt > 1 && !(await press('KEYCODE_BACK', { settle: SETTLE }))) return false;
  // Sidebar open + walk to the pinned user entry, in one `input` call. Extra LEFTs are
  // harmless (focus stops at the sidebar) and UP saturates at the top entry.
  if (!(await press(['KEYCODE_DPAD_LEFT', 2], ['KEYCODE_DPAD_UP', 10], { settle: SETTLE }))) {
    return false;
  }
  if (!(await press('KEYCODE_DPAD_CENTER'))) return false;
  if (!(await waitActivity(MODAL_ACTIVITY))) {
    console.log('[adb] the user modal did not open');
    return false;
  }
  // "Switch user" is the modal's first and focused entry. Deliberately NOT verified by
  // text: that costs a ~1.9s dump, and landing on the picker below proves it anyway.
  if (!(await press('KEYCODE_DPAD_CENTER'))) return false;
  return waitActivity(PICKER_ACTIVITY);
}

/**
 * Last resort: cold-start Plex so the picker comes back. Returns true if issued.
 *
 * This is the ONE place ADB launches Plex after a force-stop. Only reached when the in-app
 * route above failed, because a force-stop kills whatever Plex was playing.
 */
export async function restartToPicker() {
  console.log('[adb] falling back to force-stopping Plex to get the picker back');
  if (run(['shell', 'am', 'force-stop', PLEX_PKG]) === null) return false;
  await sleep(1.0);
  if (
    run(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'plex://']) === null
  ) {
    return false;
  }
  return true;
}

/**
 * Get the picker on screen. Returns [selectedName, verified], or [null, false].
 *
 * `verified` is false when the name is the caller's `knownCurrent` hint rather than a
 * real dump. switchTo MUST NOT commit on an unverified name — see the guard there.
 *
 * **This does not launch Plex** — that stays the HA script's `plex://` app link. Escalates
 * gently: picker already up > wake a dozing Shield > Plex's own Switch-user menu once it is
 * on Home > force-stop and relaunch.
 */
export async function summonPicker(cancel = null, knownCurrent = null) {
  const deadline = Date.now() + ADB_PICKER_WAIT_SECONDS * 1000;
  let woken = false;
  let menuTries = 0;
  let homeSince = null;
  let backs = 0;
  let otherSince = Date.now();
  while (Date.now() < deadline) {
    if (isCancelled(cancel)) return [null, false];
    const [ready, name] = pickerReady(knownCurrent);
    if (ready) return [name, knownCurrent == null];
    const act = foregroundActivity() || '';
    if (!act.includes(PLEX_PKG)) {
      // A dozing Shield reports the screensaver, not Plex. WAKEUP is not a navigation
      // press — it cannot select or dismiss anything — so it is safe to send blind.
      if (!woken) {
        console.log(`[adb] not on Plex (on '${act}'); waking the Shield`);
        await press('KEYCODE_WAKEUP');
        woken = true;
      }
      await sleep(0.4);
      continue;
    }
    if (act.includes(HOME_ACTIVITY)) {
      otherSince = Date.now();
      if (homeSince == null) homeSince = Date.now();
      // Signed in already: no picker will ever appear on its own. Drive Plex's own
      // Switch-user route — and give it more than one shot before force-stopping.
      if (menuTries < MAX_MENU_TRIES && Date.now() - homeSince >= HOME_SETTLE * 1000) {
        menuTries += 1;
        if (await pickerViaMenu(menuTries)) {
          // Trust the hint here rather than paying a dump: this is the moment the picker
          // has just animated open, which is exactly when uiautomator blocks longest
          // waiting for an idle window (~3.9s).
          if (knownCurrent) {
            console.log(
              `[adb] assuming picker opened on '${knownCurrent}' (will verify by read-back)`,
            );
            return [knownCurrent, false];
          }
          return [selectedProfile(), true];
        }
      } else if (menuTries < MAX_MENU_TRIES) {
        await sleep(0.4); // still settling — come back for the next attempt
        continue;
      } else if (ADB_RESTART_TO_PICKER) {
        if (await restartToPicker()) {
          return [await waitForPicker(deadline, cancel), true];
        }
        return [null, false];
      } else {
        return [null, false];
      }
    }
    // On Plex but on neither the picker nor Home: a splash still loading, a detail page,
    // or — the case that actually bites — a PLAYER. Give a splash a moment to resolve on
    // its own, then back out toward Home, which is where the Switch-user route starts.
    if (Date.now() - otherSince > 3000 && backs < MAX_BACKS) {
      backs += 1;
      const short = act.includes('.') ? act.split('.').pop() : act;
      console.log(`[adb] on '${short}'; backing out toward Home (${backs}/${MAX_BACKS})`);
      await press('KEYCODE_BACK', { settle: 1.2 });
      otherSince = Date.now();
      continue;
    }
    await sleep(0.4);
  }
  console.log(`[adb] gave up waiting for the picker after ${ADB_PICKER_WAIT_SECONDS}s`);
  return [null, false];
}

/**
 * Poll until the picker is up. Returns the selected name, or null.
 *
 * `deadline` is an absolute ms timestamp (Date.now()-based), matching the Python's monotonic
 * deadline object identity — callers pass the same budget they already started.
 */
export async function waitForPicker(deadline, cancel = null, knownCurrent = null) {
  while (Date.now() < deadline) {
    if (isCancelled(cancel)) return null;
    const [ready, name] = pickerReady(knownCurrent);
    if (ready) return name;
    await sleep(0.4);
  }
  return null;
}

/**
 * Best-effort: drive the picker to `target` and commit. Returns [ok, detail].
 *
 * ok=true means "pressed center on a tile reading `target`" — NOT that the Shield is signed
 * in as them. The caller must still confirm via the PMS log.
 */
export async function switchTo(target, cancel = null, knownCurrent = null) {
  if (!ADB_ENABLED) return [false, 'ADB_ENABLED is off'];
  if (!connect()) return [false, `cannot reach ${ADB_TARGET} over adb`];

  const deadline = Date.now() + ADB_PICKER_WAIT_SECONDS * 1000;

  async function resummon(why) {
    // Losing the picker mid-switch is usually transient — go get it again.
    if (Date.now() >= deadline) return [null, false];
    console.log(`[adb] ${why}; re-summoning the picker`);
    return summonPicker(cancel); // no hint: re-read for real
  }

  let [current, verified] = await summonPicker(cancel, knownCurrent);
  if (current == null) {
    return [
      false,
      'could not get the Plex profile picker on screen ' +
        '(not signed in and no picker, or the Plex UI changed)',
    ];
  }
  console.log(`[adb] picker is up, on '${current}', want '${target}'`);

  let presses = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() >= deadline) {
      return [
        false,
        `ran out of time after ${presses} presses, last on '${current}' wanting '${target}'`,
      ];
    }
    if (await sameProfile(current, target)) {
      if (verified) break;
      // The hint said we are already there, so the press loop below — and with it every
      // read-back — would be skipped entirely, and CENTER would commit whoever is REALLY
      // highlighted. That is how a stale LAST_SEEN signed the Shield into the wrong profile
      // while this reported "ok". One dump is the price of the fast path being allowed to
      // be wrong.
      const live = selectedProfile();
      if (live == null) {
        [current, verified] = await resummon(
          'the picker went before the selection was confirmed',
        );
        if (current == null) {
          return [
            false,
            'the picker went away before the selection could be confirmed, and did not come back',
          ];
        }
        continue;
      }
      if (live !== current) {
        console.log(`[adb] hint said '${current}', picker is really on '${live}'`);
      }
      current = live;
      verified = true;
      continue;
    }
    if (isCancelled(cancel)) return [false, 'cancelled by a newer scan'];
    if (presses >= ADB_MAX_PRESSES) {
      return [
        false,
        `gave up after ${presses} presses, stuck on '${current}' ` +
          `(is '${target}' still a Plex Home user?)`,
      ];
    }

    const step = await offset(current, target);
    if (step == null) {
      const order = await profileOrder();
      if (!order.length) {
        return [
          false,
          'no picker order available - plex.tv is unreachable and ' +
            `nothing is cached at ${ADB_PROFILE_ORDER_CACHE}`,
        ];
      }
      return [
        false,
        `'${current}' or '${target}' is not in the picker order ` +
          '(a Home user was added or removed?)',
      ];
    }

    // Re-guard immediately before pressing: the picker may have been dismissed by a human
    // between the read-back and now.
    const [ready, live] = pickerReady();
    if (!ready) {
      [current, verified] = await resummon('the picker went away mid-switch');
      if (current == null) {
        return [false, 'the picker went away mid-switch and did not come back'];
      }
      continue;
    }
    if (live !== current) {
      current = live;
      verified = true;
      continue;
    }

    const n = Math.min(Math.abs(step), ADB_MAX_PRESSES - presses);
    const keycode = step > 0 ? 'KEYCODE_DPAD_RIGHT' : 'KEYCODE_DPAD_LEFT';
    if (!(await press([keycode, n]))) return [false, 'a D-pad press failed'];
    presses += n;

    const moved = selectedProfile();
    if (moved == null) {
      // Presses already landed, so where the selection ended up is now unknown — re-read
      // rather than assume, and let the loop re-derive the offset.
      [current, verified] = await resummon('the picker went away after pressing');
      if (current == null) {
        return [false, 'the picker went away mid-switch and did not come back'];
      }
      continue;
    }
    if (moved === current) {
      // Pressed, nothing moved: an end of a non-wrapping list, or a changed UI.
      return [
        false,
        `'${current}' did not move after ${n} x ${keycode} ` +
          '(end of the list, or the Plex UI changed)',
      ];
    }
    console.log(`[adb] ${n} x ${keycode}: '${current}' -> '${moved}'`);
    current = moved;
    verified = true;
  }

  // Commit straight away. The loop only exits on a VERIFIED read-back showing `target`,
  // moments ago — re-verifying would cost another ~1.9s dump to learn what we just learned.
  if (!(await press('KEYCODE_DPAD_CENTER'))) return [false, 'the commit press failed'];
  console.log(`[adb] committed '${current}' after ${presses} presses`);
  return [true, `selected '${current}' on the picker`];
}
