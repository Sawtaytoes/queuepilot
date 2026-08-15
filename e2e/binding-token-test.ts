// Regression gate: playback runs as the ACTIVE BINDING's account, not the set's default one.
//
// THE BUG THIS PINS (live, 2026-08-14). `routing.loadSets` mirrors `profiles[0]` — the DEFAULT
// binding — onto a set's top-level fields, `user_uuid` included. Selection correctly used
// `bindingFor(cfg, profileTitle)`, but `playback.playToken` read the top-level mirror, so on a
// multi-profile channel EVERY playQueue was built as profiles[0]. On the live `movies` channel
// (Younger Kids first, Older Kids second) an Older Kids scan picked a PG movie out of Older
// Kids' own history and then built the playQueue as YOUNGER Kids, whose account cannot see PG.
// Plex answered 200 with an EMPTY queue (size 0), Companion answered 200, `played: true` was
// published, and the Shield sat on the home screen. Nothing anywhere said "error".
//
// Two assertions, and both matter: the binding's uuid must reach playback (the cause), and an
// empty playQueue must be a hard failure (the reason it was invisible).
//
// Run:  server/node_modules/.bin/tsx e2e/binding-token-test.ts   (from the repo root; non-zero on failure)
process.env.RESUME_ON_ADVANCE = 'false';
process.env.ADB_ENABLED = 'false';

import { registerHooks } from 'node:module';
import { parentIs } from './stubs/module-id.mjs';
import {
  stubSessionDeps, useFixtures, resetSession, SESSION_CTL as RAW_SESSION_CTL,
} from './stubs/session-harness.mjs';
import type { Device } from '../server/src/types.js';

/** One recorded outbound Plex request. The undici stub is a DATA-URL module — a separate
 * module instance — so it can only reach this array through `globalThis`. */
interface PlexCall {
  url: string;
  headers: Record<string, string>;
}

declare global {
  var __PLEX_CALLS: PlexCall[];
  var __PQ_SIZE: () => number;
}

/**
 * The harness control surface, typed.
 *
 * `stubs/session-harness.mjs` stays hand-written JavaScript — it is `registerHooks` machinery
 * that has to run before anything is transpiled — so under `allowJs`/`checkJs: false` its
 * `SESSION_CTL` is INFERRED from an initializer of nulls and empty arrays: `drives`/`plays`
 * come out `never[]` and `profileTitle` as the type `null`. This declares the two recorded
 * call lists the way the stubs actually fill them; it is a view of the same object, not a copy.
 */
interface SessionCtl {
  drives: { userUuid?: string | null }[];
  plays: { userUuid?: string | null }[];
  profileTitle: string | null;
}
const SESSION_CTL = RAW_SESSION_CTL as unknown as SessionCtl;

const FAILS: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  console.log((cond ? 'ok    ' : 'FAIL  ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

// --------------------------------------------------------------------------- //
// 1. Wiring: session -> provider.materialize -> driver -> playback carries the
//    RESOLVED binding, not the set default.
// --------------------------------------------------------------------------- //
stubSessionDeps();

// Ordered Younger-FIRST, mirroring the live sets.yaml: `profiles[0]` is what the top-level
// mirror carries, so an Older scan is precisely the case that used to break.
useFixtures({
  sets: `sets:
  - id: shows_shorts
    label: Shows & Shorts
    source: rotation
    behavior: progress
    sections: [5]
    profiles:
      - plex_user: "Younger"
        account_id: 700001
        user_uuid: yk-uuid
        watch_count_accounts: [700001]
        allowed_ratings: [TV-Y, TV-Y7, TV-G, G]
      - plex_user: "Older"
        account_id: 700002
        user_uuid: ok-uuid
        watch_count_accounts: [700002]
        allowed_ratings: [TV-PG, PG]
`,
  queues: 'demo:\n  - 2001\n',
});

const session = await import('../server/src/session.js');
session.setPublishers({ state: () => {}, lastPlayed: () => {} });

// The uuid that reached playback for a scan on `profile`, via whichever path is live.
async function uuidFor(profile: string) {
  resetSession();
  SESSION_CTL.profileTitle = profile;
  await session.startSession({ set: 'shows_shorts', kind: 'cartoons', profile });
  const call = SESSION_CTL.drives[0] || SESSION_CTL.plays[0];
  return call ? call.userUuid : undefined;
}

const older = await uuidFor('Older');
check('non-default binding plays as its OWN account', older === 'ok-uuid', String(older));
check('non-default binding is not the profiles[0] mirror', older !== 'yk-uuid', String(older));

// The default binding keeps working — this is what masked the bug for a month: the Younger Kids
// channels played fine, because profiles[0] happened to be the right account for them.
const younger = await uuidFor('Younger');
check('default binding still plays as its own account', younger === 'yk-uuid', String(younger));

// --------------------------------------------------------------------------- //
// 2. Effect: the playQueue POST actually goes out as that account's token.
// --------------------------------------------------------------------------- //
// Wiring alone is not the guarantee — what Plex sees is. undici / plex.js / sets.js are stubbed
// for playback.js only, so the rest of playback.js runs for real and the POST is recorded.
const CALLS: PlexCall[] = [];
globalThis.__PLEX_CALLS = CALLS;
let PQ_SIZE = 1;
globalThis.__PQ_SIZE = () => PQ_SIZE;

const stub = (src: string): string => `data:text/javascript,${encodeURIComponent(src)}`;
const UNDICI = stub(`
  export const Agent = class { constructor() {} };
  export async function request(url, opts = {}) {
    globalThis.__PLEX_CALLS.push({ url: String(url), headers: (opts && opts.headers) || {} });
    const body = String(url).includes('/playQueues')
      ? JSON.stringify({ MediaContainer: { playQueueID: 77, size: globalThis.__PQ_SIZE() } })
      : JSON.stringify({ MediaContainer: { machineIdentifier: 'server-mid' } });
    return { statusCode: 200, body: { text: async () => body } };
  }
`);
// The set's TOP-LEVEL user_uuid is the default-binding mirror — the value the bug used.
const PLEX_STUB = stub(`
  export async function accountToken(uuid) { return uuid ? 'tok-' + uuid : null; }
  export async function plexGet() { return { MediaContainer: { machineIdentifier: 'server-mid' } }; }
`);
const SETS_STUB = stub("export async function getSet() { return { user_uuid: 'yk-uuid' }; }");

// Extension-blind parent match (see e2e/stubs/module-id.mjs): pinned to a literal
// `playback.js` this hook stopped firing the moment the module became playback.ts, and the
// test then made REAL requests to the configured Plex server instead of failing.
const fromPlayback = parentIs('/server/src/playback');

registerHooks({
  resolve(spec, ctx, next) {
    if (fromPlayback(ctx)) {
      if (spec === 'undici') return { url: UNDICI, shortCircuit: true };
      if (spec === './plex.js') return { url: PLEX_STUB, shortCircuit: true };
      if (spec === './sets.js') return { url: SETS_STUB, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const playback = await import('../server/src/playback.js');
// Only `mode` and `uri` are read on this path, so the harness hands playback a deliberately
// partial device rather than inventing an id/name/machineIdentifier no assertion looks at.
const SHIELD = { mode: 'client', uri: 'http://shield.invalid:32500' } as unknown as Device;
const playQueuePost = (): { headers: Record<string, string | undefined> } =>
  CALLS.find((c) => c.url.includes('/playQueues')) || { headers: {} };

CALLS.length = 0;
let res = await playback.playRatingKeys(['174376'], {
  setName: 'movies', device: SHIELD, offset: 0, userUuid: 'ok-uuid',
});
check('the playQueue POST is made as the binding account',
  playQueuePost().headers['X-Plex-Token'] === 'tok-ok-uuid',
  String(playQueuePost().headers['X-Plex-Token']));
check('the binding account plays', res.played === true, JSON.stringify(res));

// Back-compat: a single-binding (legacy) set passes no userUuid and must still use the set's
// own account — the fallback order is binding, then set default, then admin.
CALLS.length = 0;
await playback.playRatingKeys(['174376'], { setName: 'movies', device: SHIELD, offset: 0 });
check('no binding given still falls back to the set default',
  playQueuePost().headers['X-Plex-Token'] === 'tok-yk-uuid',
  String(playQueuePost().headers['X-Plex-Token']));

// --------------------------------------------------------------------------- //
// 3. An EMPTY playQueue is an error, never a successful play.
// --------------------------------------------------------------------------- //
// Plex returns 200 + size 0 for ratingKeys the token cannot see, and Companion returns 200 for
// pushing it. Reporting `played: true` there is what put a silent failure on the TV.
PQ_SIZE = 0;
CALLS.length = 0;
res = await playback.playRatingKeys(['174376'], {
  setName: 'movies', device: SHIELD, offset: 0, userUuid: 'ok-uuid',
});
check('an empty playQueue does not report a play', res.played === false, JSON.stringify(res));
check('an empty playQueue reports WHY', /EMPTY/.test(res.error || ''), String(res.error));
check('an empty playQueue is never pushed at the client',
  !CALLS.some((c) => c.url.includes('playMedia')), CALLS.map((c) => c.url).join(' '));
PQ_SIZE = 1;

console.log();
if (FAILS.length) {
  console.log(`${FAILS.length} FAILED: ${FAILS.join(', ')}`);
  process.exit(1);
}
console.log('all binding-token checks passed');
