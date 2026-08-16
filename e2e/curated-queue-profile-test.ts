// Regression gate: a CURATED QUEUE reads the watched state of the profile it plays under.
//
// THE BUG THIS PINS (live, 2026-08-16, reported from queuepilot.example.com/q/carol_1). A
// curated queue stores `requires_profile` — a display NAME — and nothing else; it has no
// `profiles[]` and no binding fields, so `routing.bindingFor()` handed back an empty binding.
// An empty binding was wrong in two directions at once:
//
//   * `watch_count_accounts: null` fell through to env WATCH_COUNT_ACCOUNTS, which is a UNION
//     starting at the admin — the very cross-account union decision 2026-07-16 reverted;
//   * `user_uuid: null` read every episode's viewCount under the OWNER's token.
//
// It stayed invisible for as long as every curated queue was Bob's own (`requires_profile:
// sawtaytoes`), where the admin answer is right by accident. The first queue gated to a kid —
// "Carol 1" -> Older Kids, with a Dragon Ball collection on it — showed the owner's place in
// the show: "Next: Dragon Ball Z E109", 246 episodes past where Carol actually is.
//
// Run:  server/node_modules/.bin/tsx e2e/curated-queue-profile-test.ts   (from the repo root)
import { registerHooks } from 'node:module';
import { parentIs } from './stubs/module-id.mjs';
import * as select from '../server/src/engine/select.js';
import * as routing from '../server/src/engine/routing.js';
import type { EngineBinding, PlexClient } from '../server/src/types.js';

const FAILS: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

// --------------------------------------------------------------------------- //
// 1. watchedForSet asks Plex for the BINDING's account, and only that one.
// --------------------------------------------------------------------------- //
// The consequence half of the bug: whatever fills the binding, this is where a wrong account
// becomes a wrong episode. A recording client makes the accountID query parameter — the whole
// mechanism — directly assertable.
const HISTORY_CALLS: string[] = [];
const recordingClient: PlexClient = {
  async container(path: string) {
    if (path.startsWith('/status/sessions/history/all')) {
      HISTORY_CALLS.push(path);
      // One watched row per account, keyed BY the account, so a set's watched keys say which
      // history was actually read rather than only which URL was requested.
      const acct = new URL('http://x/' + path).searchParams.get('accountID');
      return { Metadata: [{ ratingKey: `watched-by-${acct}` }], totalSize: 1 };
    }
    throw new Error(`unexpected path ${path}`);
  },
  async accountToken() { return null; },
};
const accountsIn = (calls: readonly string[]): string[] => [
  ...new Set(calls.map((p) => new URL('http://x/' + p).searchParams.get('accountID') ?? '')),
];

// `episodic_sections`/`item_sections` are what routing's `setSections()` reads — the loaded
// shape, not the YAML's `sections:` key, which loadSets renames on the way in.
const CFG = { source: 'queue', episodic_sections: [5] } as unknown as Parameters<typeof select.watchedForSet>[1];
const bindingWith = (accts: number[] | null): EngineBinding => ({
  plex_user: null, account_id: null, user_uuid: null,
  allowed_ratings: null, movie_ratings: null,
  watch_count_accounts: accts, movie_excludes: [],
});

HISTORY_CALLS.length = 0;
let watched = await select.watchedForSet(recordingClient, CFG, bindingWith([700002]));
ok('a bound queue reads ONLY its own profile history',
  accountsIn(HISTORY_CALLS).join(',') === '700002', accountsIn(HISTORY_CALLS).join(','));
ok('…and the watched keys are that profile\'s',
  watched.has('watched-by-700002') && !watched.has('watched-by-1'), [...watched].join(','));

// The pre-fix shape, pinned as the thing the provider must now prevent: no accounts on the
// binding means the env union, which starts at the admin. This assertion is not a wish — it is
// what `carol_1` did in production until profileBinding() filled the account in.
HISTORY_CALLS.length = 0;
watched = await select.watchedForSet(recordingClient, CFG, bindingWith(null));
ok('an UNBOUND queue still falls through to the admin-first env union',
  accountsIn(HISTORY_CALLS).includes('1'), accountsIn(HISTORY_CALLS).join(','));

// --------------------------------------------------------------------------- //
// 2. The Plex provider fills that account in, from `requires_profile`.
// --------------------------------------------------------------------------- //
// plex.js is stubbed at the provider's import so the plex.tv Home-users join is scripted
// rather than live: `sections`/`showEpisodes` are the provider's other imports from it and
// have to exist, or the module fails to load and every check below silently never runs.
const HOME_USERS: Record<string, { name: string; username: string | null; id: number | null; uuid: string | null; admin: boolean }> = {
  'Older Kids': { name: 'Older Kids', username: null, id: 700002, uuid: 'ok-uuid', admin: false },
  sawtaytoes: { name: 'Bob Smith', username: 'sawtaytoes', id: 1, uuid: null, admin: true },
};
const PLEX_STUB = `data:text/javascript,${encodeURIComponent(`
  export async function profileUser(title) { return ${JSON.stringify(HOME_USERS)}[String(title ?? '')] ?? null; }
  export async function sections() { return []; }
  export async function showEpisodes() { return null; }
`)}`;
const fromPlexProvider = parentIs('/server/src/providers/plex');
registerHooks({
  resolve(spec, ctx, next) {
    if (fromPlexProvider(ctx) && spec === '../plex.js') return { url: PLEX_STUB, shortCircuit: true };
    return next(spec, ctx);
  },
});

const { plexProvider } = await import('../server/src/providers/plex.js');
const provider = plexProvider({ client: recordingClient });
// Non-null: this suite exists because the method is what fixes the bug — an absent one is a
// failure to report, not a case to tolerate.
const fill = (b: EngineBinding, profile: string | null) => provider.profileBinding!(b, profile);

const older = await fill(bindingWith(null), 'Older Kids');
ok('a queue gated to a kid binds THAT kid\'s account',
  older.account_id === 700002 && older.user_uuid === 'ok-uuid', JSON.stringify(older));
ok('…as a single account, never a union',
  JSON.stringify(older.watch_count_accounts) === '[700002]', JSON.stringify(older.watch_count_accounts));

// The no-regression case, and the reason this went a month unnoticed: every queue that already
// existed is the owner's, and the owner IS the admin token (uuid null) on account 1.
const owner = await fill(bindingWith(null), 'sawtaytoes');
ok('the owner still plays as the admin token',
  owner.user_uuid === null && owner.account_id === 1, JSON.stringify(owner));
ok('…on the admin account alone',
  JSON.stringify(owner.watch_count_accounts) === '[1]', JSON.stringify(owner.watch_count_accounts));

// An ungated queue keeps the empty binding it has always had — this must not invent a profile.
const ungated = await fill(bindingWith(null), null);
ok('an ungated queue is left alone',
  ungated.account_id === null && ungated.user_uuid === null && ungated.watch_count_accounts === null,
  JSON.stringify(ungated));

// A profile Plex does not know (hand-typed, or plex.tv unreachable) degrades to the old
// behaviour rather than throwing mid-scan.
const unknown = await fill(bindingWith(null), 'Nobody');
ok('an unknown profile degrades instead of throwing',
  unknown.account_id === null && unknown.user_uuid === null, JSON.stringify(unknown));

// --------------------------------------------------------------------------- //
// 3. A rotation channel's EXPLICIT binding is authoritative and untouched.
// --------------------------------------------------------------------------- //
// profiles[] already names the account, and `bindingFor` already picked the right entry for
// the signed-in profile. Second-guessing it here would re-open the 2026-08-14 silent-no-play
// bug from the other end.
const explicit: EngineBinding = {
  ...bindingWith([700001]), plex_user: 'Younger Kids', account_id: 700001, user_uuid: 'yk-uuid',
};
const kept = await fill(explicit, 'Older Kids');
ok('an explicit rotation binding is never overwritten',
  kept.user_uuid === 'yk-uuid' && kept.account_id === 700001
    && JSON.stringify(kept.watch_count_accounts) === '[700001]', JSON.stringify(kept));

// …and `bindingFor` is still what produces it, so the two halves compose the way session.ts
// chains them: a rotation set resolves its own binding and profileBinding is a no-op on it.
// `profiles[]` is the ONLY field bindingFor reads on this path (it casts to exactly that
// shape internally), so the fixture carries it and nothing else rather than a whole
// RoutingSetCfg of filler that no assertion here looks at.
const rotationCfg = {
  profiles: [
    { ...bindingWith([700001]), plex_user: 'Younger Kids', account_id: 700001, user_uuid: 'yk-uuid' },
    { ...bindingWith([700002]), plex_user: 'Older Kids', account_id: 700002, user_uuid: 'ok-uuid' },
  ],
} as unknown as Parameters<typeof routing.bindingFor>[0];
const chained = await fill(routing.bindingFor(rotationCfg, 'Older Kids'), 'Older Kids');
ok('bindingFor -> profileBinding leaves a picked rotation binding intact',
  chained.user_uuid === 'ok-uuid' && chained.account_id === 700002, JSON.stringify(chained));

console.log();
if (FAILS.length) {
  console.log(`${FAILS.length} FAILED: ${FAILS.join(', ')}`);
  process.exit(1);
}
console.log('all curated-queue profile checks passed');
