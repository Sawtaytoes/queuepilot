// Parity test for the Node port of profiles.py's profile detection (D1).
//
// The Python `e2e/profile-gate-test.py` drives the whole service `_do_start`, which is D6 —
// not portable in isolation. This tests the ISOLABLE unit the port replaces first: the PMS-log
// tail (`waitForProfile`) and the profile→set map (`setForProfile`), against a synthetic log
// that grows the same way the real PMS log does. It asserts the same behaviours the Python's
// `wait_for_profile` has: first-signed-in wins; a `match` skips the wrong profile until the
// switch; timeout returns null; log truncation is survived.
import { mkdtempSync, writeFileSync, appendFileSync, truncateSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'profiles-'));
const LOG = path.join(dir, 'pms.log');
writeFileSync(LOG, 'startup line\n');

// env BEFORE importing the module (it reads env at import).
process.env.PMS_LOG_PATH = LOG;
process.env.SHIELD_IP = '192.0.2.30';
process.env.PROFILE_WAIT_SECONDS = '3';
process.env.PROFILE_SET_MAP = JSON.stringify({ 'Younger Kids': 'younger', 'Older Kids': 'older' });

const profiles = await import('../server/src/profiles.js');

let failures = 0;
const ok = (name: string, cond: boolean, extra = ''): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};

const signInLine = (profile: string): string =>
  `DEBUG - Request: [192.0.2.30:44100 (...)] GET /photo/x Signed-in Token (${profile})\n`;

// Append `profile`'s sign-in line to the log after `afterMs`, like the Shield making a request.
function signInAfter(profile: string, afterMs: number): void {
  setTimeout(() => appendFileSync(LOG, signInLine(profile)), afterMs);
}

// 1. setForProfile mirrors config.PROFILE_SET_MAP.
ok('setForProfile maps a known profile', profiles.setForProfile('Younger Kids') === 'younger');
ok('setForProfile returns null for an unmapped profile', profiles.setForProfile('Nobody') === null);

// 2. First signed-in profile wins (the `auto` card path — no match).
signInAfter('Younger Kids', 300);
const first = await profiles.waitForProfile({ poll: 0.1 });
ok('waitForProfile returns the first signed-in profile', first === 'Younger Kids', String(first));
ok('LAST_SEEN updated', profiles.LAST_SEEN.title === 'Younger Kids');

// 3. `match` skips the wrong profile and waits for the switch to the required one.
appendFileSync(LOG, signInLine('Younger Kids')); // the "wrong" profile is already there
signInAfter('Older Kids', 400); // the switch lands shortly after
const matched = await profiles.waitForProfile({ poll: 0.1, match: 'Older Kids' });
ok('waitForProfile skips the wrong profile, returns the matched one', matched === 'Older Kids', String(matched));

// 4. Timeout returns null when no profile ever signs in.
const t0 = Date.now();
const timedOut = await profiles.waitForProfile({ poll: 0.1, timeout: 0.6 });
ok('waitForProfile times out to null', timedOut === null);
ok('timeout respected (~0.6s, not the 3s default)', Date.now() - t0 < 2000, `${Date.now() - t0}ms`);

// 5. Truncation in place is survived (the tail resets to 0 and keeps matching).
truncateSync(LOG, 0);
signInAfter('Older Kids', 300);
const afterTrunc = await profiles.waitForProfile({ poll: 0.1 });
ok('waitForProfile survives truncation', afterTrunc === 'Older Kids', String(afterTrunc));

// 6. A line from a DIFFERENT IP is ignored (only the Shield's IP matches).
truncateSync(LOG, 0);
setTimeout(() => {
  appendFileSync(LOG, 'DEBUG - Request: [192.0.2.9:5000 (...)] GET /x Signed-in Token (Younger Kids)\n');
}, 200);
signInAfter('Older Kids', 500);
const rightIp = await profiles.waitForProfile({ poll: 0.1 });
ok('waitForProfile ignores other IPs, matches only the Shield', rightIp === 'Older Kids', String(rightIp));

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} profile assertion(s) failed` : '\nall profile assertions passed');
process.exit(failures ? 1 : 0);
