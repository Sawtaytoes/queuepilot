// Gate tests for startSession's Plex-profile handling (server/src/session.js).
//
// The gate is the thing standing between "the right show" and "the right show billed to the
// wrong kid", so it gets tests even though the rest of the session does not. Drives the REAL
// startSession against the synthetic corpus with stubbed profile detection / device calls
// (e2e/stubs/session-harness.mjs), then asserts on what got published.
//
// Node port of the retired e2e/profile-gate-test.py (deleted with queue_builder/ on
// 2026-08-12). Same seven scenarios; the log-tail half of that test lives on in
// e2e/profile-gate-test.mjs (waitForProfile / setForProfile against a synthetic PMS log).
//
// Run:  node e2e/session-profile-gate-test.mjs   (from the repo root; non-zero on failure)
process.env.PLAYBACK_FSM = 'false'; // the in-session gate; the FSM's own gate is playback-fsm-test
process.env.RESUME_ON_ADVANCE = 'false';
process.env.ADB_ENABLED = 'false';

import { stubSessionDeps, useFixtures, resetSession, SESSION_CTL } from './stubs/session-harness.mjs';

stubSessionDeps();

// A rotation channel with explicit per-profile bindings (what makes set:"auto" route here),
// and a reel queue that requires the 'Demo' profile. Both resolve against the synthetic corpus.
const SETS = `sets:
  - id: shows_shorts
    label: Shows & Shorts
    source: rotation
    behavior: progress
    sections: [5]
    profiles:
      - plex_user: "Older"
        account_id: 700002
        user_uuid: ok-uuid
        watch_count_accounts: [700002]
        allowed_ratings: [TV-PG, PG]
      - plex_user: "Younger"
        account_id: 700001
        user_uuid: yk-uuid
        watch_count_accounts: [700001]
        allowed_ratings: [TV-Y, TV-Y7, TV-G, G]
  - id: demo
    label: Demo Reel
    source: queue
    reel: true
    sections: [1, 5]
    requires_profile: Demo
`;
const QUEUES = 'demo:\n  - 2001\n';
useFixtures({ sets: SETS, queues: QUEUES });

const session = await import('../server/src/session.js');

// Capture what the session publishes, the way mqttd would.
const STATES = [];
session.setPublishers({
  state: (payload) => STATES.push(payload || {}),
  lastPlayed: () => {},
});

const FAILS = [];
function check(name, cond, detail = '') {
  console.log((cond ? 'ok    ' : 'FAIL  ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

async function run(payload, signedInAs = null) {
  resetSession();
  STATES.length = 0;
  SESSION_CTL.profileTitle = signedInAs;
  const res = await session.startSession(payload);
  return {
    res,
    played: SESSION_CTL.plays.length > 0 || SESSION_CTL.drives.length > 0,
    awaiting: STATES.map((s) => s.awaiting).filter(Boolean),
    lastError: [...STATES].reverse().find((s) => s.error)?.error || null,
  };
}

// 1. A card naming a profile must WAIT for that profile — not just trust the payload.
let c = await run({ set: 'shows_shorts', kind: 'cartoons', profile: 'Younger' });
check('card profile gates: does not play on a silent log', !c.played);
check('card profile gates: announces the wait', c.awaiting.includes('profile:Younger'),
  JSON.stringify(c.awaiting));
check('card profile gates: names the profile in the error',
  Boolean(c.lastError && c.lastError.includes('Younger')), String(c.lastError));

// 2. The WRONG profile signing in must not satisfy it (the mis-attribution case).
c = await run({ set: 'shows_shorts', kind: 'cartoons', profile: 'Younger' }, 'Older');
check('wrong profile does not clear the gate', !c.played, String(c.lastError));

// 3. The right profile signing in clears it and plays.
c = await run({ set: 'shows_shorts', kind: 'cartoons', profile: 'Younger' }, 'Younger');
check('right profile clears the gate and plays', c.played, String(c.lastError));

// 4. No profile on the card => rotation set stays ungated, exactly as before.
c = await run({ set: 'shows_shorts', kind: 'cartoons' });
check('ungated rotation set still plays with no profile', c.played, String(c.lastError));
check('ungated rotation set never announces a wait', c.awaiting.length === 0,
  JSON.stringify(c.awaiting));

// 5. requires_profile still works on its own.
c = await run({ set: 'demo', kind: 'movie' }, 'Demo');
check('requires_profile clears on the required profile', c.played, String(c.lastError));
c = await run({ set: 'demo', kind: 'movie' }, 'Older');
check('requires_profile rejects the wrong profile', !c.played);

// 6. A card contradicting the set's requires_profile errors instead of guessing.
c = await run({ set: 'demo', kind: 'movie', profile: 'Younger' });
check('card/set profile conflict is a clear error',
  Boolean(c.lastError && c.lastError.includes('requires')), String(c.lastError));
check('conflict does not play', !c.played);

// 7. set=auto is unchanged: the first signed-in profile decides the tier.
c = await run({ set: 'auto', kind: 'cartoons' }, 'Older');
check('auto still resolves the tier from the log', c.played, String(c.lastError));

console.log();
if (FAILS.length) {
  console.log(`${FAILS.length} FAILED: ${FAILS.join(', ')}`);
  process.exit(1);
}
console.log('all profile-gate checks passed');
