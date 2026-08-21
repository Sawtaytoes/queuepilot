// The post-play ACCOUNT AUDIT (server/src/driver.js driveToPlaying). No Plex, no ADB, no
// network — adb / playback / profiles are swapped for e2e/stubs/* via module resolve hooks.
//
// WHY THIS EXISTS
//
// Every other check in the playback FSM verifies an INTENTION. `adb.switchTo` verifies that
// the right tile was highlighted when CENTER was pressed; `driveProfile` verifies that
// switchTo said ok; `drivePlay` verifies that Companion answered 200. Not one of them can see
// which Plex Home profile the Shield actually signed into — non-root ADB cannot read Plex's
// app data, and the picker is gone the moment the question matters.
//
// So the promise "a card can never play under the wrong account" (the sets.yaml header) was
// never enforced anywhere. On 2026-08-18 it failed in the open: the Younger Kids Shorts pool
// published `profile: Younger Kids, played: true` to HA at 15:59:01, and Plex recorded all
// three shorts under the OWNER's account. Nothing errored, because nothing looked.
//
// `/status/sessions` is the one direct answer: it stamps every live session with the `User`
// whose token owns it, which IS the account Plex will scrobble to. It needs a session to
// exist, so this is an audit AFTER play rather than a gate before it.
//
// The scenarios:
//   (a) wrong account       -> playback STOPPED, spoken error, never reported as played
//   (b) right account       -> the play result passes through untouched
//   (c) audit has no opinion-> the play result passes through (abstain, never fail)
//   (d) no bound account    -> the audit does not run at all
//   (e) play never started  -> nothing to audit, nothing stopped
//
// Run:  server/node_modules/.bin/tsx e2e/account-audit-test.ts   (from the repo root)
// See:  docs/decisions/2026-08-21-the-profile-gate-verifies-the-account-plex-is-playing-as.md

// env.js reads process.env at module-eval, so these must precede the driver import.
process.env.PLAYBACK_MODE = 'client';
process.env.ADB_ENABLED = 'true';
process.env.SHIELD_IP = '192.0.2.30';
process.env.COMPANION_PORT = '32500';
process.env.SHIELD_CLIENT_URI = '';
process.env.PLAYBACK_FSM_PLAY_ATTEMPTS = '1';
process.env.PLAYBACK_FSM_SWITCH_ATTEMPTS = '1';
process.env.PLAYBACK_FSM_RETRY_BACKOFF = '0';

import { stubDriverDeps } from './stubs/hooks.mjs';
import type { Device } from '../server/src/types.js';

stubDriverDeps();
const { CTL: RAW_CTL, reset, nCalls } = await import('./stubs/control.mjs');
const driver = await import('../server/src/driver.js');

/** What `playback.verifyAccount()` answers — see `AccountVerdict` in server/src/playback.ts. */
interface Verdict {
  isMismatch: boolean;
  accountId: number | null;
  title: string | null;
  reason?: string;
}

/** The stubs' shared control surface, typed (see the note in playback-fsm-test.ts). */
interface DriverCtl {
  calls: unknown[][];
  foreground: string;
  companionUp: boolean;
  switchResult: [boolean, string];
  same: Map<string, boolean>;
  playResults: { queued?: number; played?: boolean; error?: string }[];
  lastSeen: { title: string | null; isObserved: boolean };
  awake: boolean;
  onSwitch: (() => void) | null;
  accountVerdict: Verdict | null;
}
const CTL = RAW_CTL as unknown as DriverCtl;

const FAILS: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

const asDevice = (mode: string): Device =>
  ({ name: 'Family Room SHIELD', machineIdentifier: 'shield-1', mode } as unknown as Device);

// The bound account vs. who the Shield was really signed in as. Placeholder ids: real Plex
// account numbers never go in this repo (2026-08-17-the-repo-is-public-so-people-hosts-and-ips
// -are-placeholders), and nothing here depends on their value — only on them differing.
const YOUNGER_KIDS = 22222222;
const OWNER = 1;

const drive = (kw: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  driver.driveToPlaying({
    ratingKeys: ['1001', '1002'],
    requiredProfile: 'Younger Kids',
    device: asDevice('client'),
    setName: 'shorts',
    setLabel: 'Shorts',
    accountId: YOUNGER_KIDS,
    cancel: null,
    ...kw,
  }) as unknown as Promise<Record<string, unknown>>;

// --------------------------------------------------------------------------- //
// (a) THE 2026-08-18 FAILURE. Play succeeds, but Plex is playing as the OWNER.
// --------------------------------------------------------------------------- //
reset();
CTL.lastSeen.title = 'Younger Kids';
CTL.lastSeen.isObserved = true; // the gate is satisfied — and still lands on the wrong account
CTL.accountVerdict = { isMismatch: true, accountId: OWNER, title: 'sawtaytoes' };
let res = await drive();
ok('(a) wrong account: the audit ran', nCalls('verify_account') === 1);
ok('(a) wrong account: playback is STOPPED', nCalls('stop_playback') === 1);
ok('(a) wrong account: does NOT report played', res.played !== true, JSON.stringify(res));
ok('(a) wrong account: returns an error', typeof res.error === 'string', JSON.stringify(res));
// The sentence is read aloud by automation.plex_channels_status_announcements, so it stays a
// sentence a person would say — and it must NAME the account it actually played as, because
// "it played as the wrong profile" does not tell anyone which one to go fix on the TV.
const spoken = String(res.error || '');
ok('(a) wrong account: the error names the SET', spoken.includes('Shorts'), spoken);
ok('(a) wrong account: the error names the WANTED profile', spoken.includes('Younger Kids'), spoken);
ok('(a) wrong account: the error names the ACTUAL profile', spoken.includes('sawtaytoes'), spoken);
ok('(a) wrong account: the error says it was stopped', /stopped/i.test(spoken), spoken);
ok('(a) wrong account: it is a SENTENCE, no diagnostics',
  !/\b(accountID|sessions|null|undefined)\b/.test(spoken), spoken);

// --------------------------------------------------------------------------- //
// (b) The account matches -> the play result passes through, nothing is stopped.
// --------------------------------------------------------------------------- //
reset();
CTL.lastSeen.title = 'Younger Kids';
CTL.lastSeen.isObserved = true;
CTL.accountVerdict = { isMismatch: false, accountId: YOUNGER_KIDS, title: 'Younger Kids' };
res = await drive();
ok('(b) right account: the audit ran', nCalls('verify_account') === 1);
ok('(b) right account: reports played', res.played === true, JSON.stringify(res));
ok('(b) right account: no error', !res.error, JSON.stringify(res));
ok('(b) right account: playback is NOT stopped', nCalls('stop_playback') === 0);

// --------------------------------------------------------------------------- //
// (c) The audit ABSTAINS (no session surfaced in time / Plex unreachable).
//
// This must NOT fail the play. A transcode can take longer to register a session than we are
// willing to block a card scan for, and killing a play that is probably fine is a worse
// failure than an audit that occasionally has no opinion. Only a POSITIVE mismatch is
// terminal — the difference between "it is wrong" and "I could not tell".
// --------------------------------------------------------------------------- //
reset();
CTL.lastSeen.title = 'Younger Kids';
CTL.lastSeen.isObserved = true;
CTL.accountVerdict = {
  isMismatch: false, accountId: null, title: null, reason: 'no session appeared',
};
res = await drive();
ok('(c) abstain: reports played anyway', res.played === true, JSON.stringify(res));
ok('(c) abstain: no error', !res.error, JSON.stringify(res));
ok('(c) abstain: playback is NOT stopped', nCalls('stop_playback') === 0);

// --------------------------------------------------------------------------- //
// (d) No bound account (an ungated curated queue, or a set with no account_id) -> no audit.
//     There is nothing to compare against, so asking would only cost a round trip.
// --------------------------------------------------------------------------- //
reset();
CTL.lastSeen.title = 'Younger Kids';
CTL.lastSeen.isObserved = true;
CTL.accountVerdict = { isMismatch: true, accountId: OWNER, title: 'sawtaytoes' };
res = await drive({ accountId: null });
ok('(d) no bound account: the audit does NOT run', nCalls('verify_account') === 0);
ok('(d) no bound account: plays normally', res.played === true, JSON.stringify(res));
ok('(d) no bound account: nothing is stopped', nCalls('stop_playback') === 0);

// --------------------------------------------------------------------------- //
// (e) Play never started -> there is no session to audit, and nothing to stop. The play
//     error must survive unchanged rather than being masked by an audit failure.
// --------------------------------------------------------------------------- //
reset();
CTL.lastSeen.title = 'Younger Kids';
CTL.lastSeen.isObserved = true;
CTL.playResults = [{ queued: 2, played: false, error: 'playMedia HTTP 500' }];
CTL.accountVerdict = { isMismatch: true, accountId: OWNER, title: 'sawtaytoes' };
res = await drive();
ok('(e) play failed: the audit does NOT run', nCalls('verify_account') === 0);
ok('(e) play failed: nothing is stopped', nCalls('stop_playback') === 0);
ok('(e) play failed: the ORIGINAL play error survives',
  String(res.error || '').includes('HTTP 500'), JSON.stringify(res));

console.log(FAILS.length ? `\nFAILURES: ${FAILS.length}` : '\ndone');
process.exit(FAILS.length ? 1 : 0);
