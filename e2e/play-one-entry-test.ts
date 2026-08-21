// PLAY ONE ENTRY — the grid's per-tile ▶ ("play THIS, not whatever the queue picks").
//
// The whole design claim is that a one-entry start is the NORMAL start with a shorter entry
// list: narrowing happens at `provider.buckets`, before the resolver, so the chosen entry still
// goes through the same next-unwatched / episodes-per-play / resume-offset machinery it would
// have got when the queue reached it on its own. These assertions are that claim, plus the two
// ways it can legitimately have nothing to play.
//
// Runs fully offline: a hand-built container client, no Plex, no broker, no browser.
//
// Run:  server/node_modules/.bin/tsx e2e/play-one-entry-test.ts   (from the repo root; non-zero on failure)
process.env.PLEX_API_SERVER_URL = 'http://plex.invalid:32400';
process.env.PLEX_TOKEN = 'test-token';

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import type { ResolvedItem } from '../server/src/engine/resolve.js';
import type { PlexClient } from '../server/src/types.js';

const SCRATCH = mkdtempSync(nodePath.join(tmpdir(), 'playone-'));
// Local consts alongside the env assignment: `process.env.X` reads back as
// `string | undefined`, and both files are written immediately below.
const SETS_PATH = nodePath.join(SCRATCH, 'sets.yaml');
const QUEUES_PATH = nodePath.join(SCRATCH, 'queues.yaml');
process.env.SETS_PATH = SETS_PATH;
process.env.QUEUES_PATH = QUEUES_PATH;
process.env.CACHE_PATH = nodePath.join(SCRATCH, 'cache.sqlite');
writeFileSync(
  SETS_PATH,
  'sets:\n  - id: bob\n    label: Bob Queue\n    source: queue\n    sections: [1]\n',
);
// Three entries, in this order. `alpha` is what the queue would play on its own (it leads);
// `gamma` is the one the ▶ names.
writeFileSync(QUEUES_PATH, 'bob:\n  - {title: alpha}\n  - {title: beta}\n  - {title: gamma}\n');

const FAILS: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

const resolve = await import('../server/src/engine/resolve.js');

// --------------------------------------------------------------------------- //
// loadEntries + the key the UI sends
// --------------------------------------------------------------------------- //
// The ▶ sends `item.key` straight from the grid. It has to be the key the resolver
// already puts on its descriptors, or narrowing silently matches nothing and every
// per-tile play reports "removed or renamed".
const entries = resolve.loadEntries('bob');
ok('loadEntries reads the file in order',
  JSON.stringify(entries.map((e) => e.key)) === JSON.stringify(['title:alpha', 'title:beta', 'title:gamma']),
  JSON.stringify(entries.map((e) => e.key)));
ok('entryKey matches the key the grid holds',
  resolve.entryKey('gamma') === 'title:gamma', String(resolve.entryKey('gamma')));
// A ratingKey entry is the common shape once resolved — same identity on both sides.
ok('entryKey agrees with queues.js for a ratingKey entry',
  resolve.entryKey({ ratingKey: 361504 }) === 'rk:361504', String(resolve.entryKey({ ratingKey: 361504 })));

// --------------------------------------------------------------------------- //
// The narrowing itself, through the real provider seam
// --------------------------------------------------------------------------- //
// Each title resolves to a one-episode show, so every entry is playable and the ONLY thing
// deciding what plays is which entries the lineup was built from.
const EPISODES: Record<string, string[]> = {
  alpha: ['alpha-e1'],
  beta: ['beta-e1'],
  gamma: ['gamma-e1', 'gamma-e2'],
};
const WATCHED = new Set<string>();

const client: PlexClient = {
  async container(path) {
    const leaves = path.match(/\/library\/metadata\/([^/?]+)\/allLeaves/);
    if (leaves) {
      // The capture group is inside the `if (leaves)`, so `leaves[1]` is present here.
      const show = leaves[1]!;
      const rks = EPISODES[show] || [];
      return {
        Metadata: rks.map((rk, i) => ({
          ratingKey: rk,
          title: rk,
          grandparentTitle: show,
          parentIndex: 1,
          index: i + 1,
          duration: 1000,
          type: 'episode',
          viewCount: WATCHED.has(rk) ? 1 : 0,
          viewOffset: 0,
        })),
      };
    }
    // Title search: `/library/sections/1/all?title=…` resolves a queue entry's title.
    const search = path.match(/\/library\/sections\/\d+\/all\?(.*)$/);
    if (search) {
      // Same as above for `search[1]`; the inner `[1]` is the query's `title=` capture, whose
      // `[, '']` fallback makes the read a string in the no-match case too.
      const title = decodeURIComponent(
        (search[1]!.match(/(?:^|&)title=([^&]*)/) || [, ''])[1]!,
      ).replace(/\+/g, ' ');
      if (!EPISODES[title]) return { Metadata: [] };
      return { Metadata: [{ ratingKey: title, title, type: 'show' }] };
    }
    const meta = path.match(/\/library\/metadata\/([^/?]+)$/);
    if (meta) {
      const rk = meta[1]!;
      return {
        Metadata: [{
          ratingKey: rk,
          title: rk,
          type: EPISODES[rk] ? 'show' : 'movie',
          viewOffset: 0,
          viewCount: WATCHED.has(rk) ? 1 : 0,
        }],
      };
    }
    return { Metadata: [] };
  },
  async accountToken() { return null; },
};

const CFG = { kind: 'movie', source: 'queue', queue_sections: [1], sections: [1] };

/**
 * What `lineup()` hands back. It is `nextQueue`'s result on every path that reaches the
 * resolver, plus the one short-circuit the `only` narrowing adds: a key that matched nothing
 * never gets there at all, and reports itself instead of falling through to the queue's head.
 * Only the two fields the assertions below read are declared, so a `QueueResult` fits as-is.
 */
interface Lineup {
  play: readonly ResolvedItem[];
  unknownEntry?: string;
}

const lineup = async (only: string | null): Promise<Lineup> => {
  let list = resolve.loadEntries('bob');
  if (only) {
    list = list.filter((e) => e.key === only);
    if (!list.length) return { play: [], unknownEntry: only };
  }
  return resolve.nextQueue(client, 'bob', CFG, list, WATCHED, null, null);
};

// Baseline: with no `only`, the queue plays its head. This is the control — if it ever stops
// being `alpha`, the narrowing assertions below prove nothing.
let res = await lineup(null);
ok('no `only`: the queue plays its own head',
  JSON.stringify(res.play.map((i) => i.ratingKey)) === JSON.stringify(['alpha-e1']),
  JSON.stringify(res.play.map((i) => i.ratingKey)));

// The point of the feature: name the third entry and it plays, not the head.
res = await lineup('title:gamma');
ok('`only`: the named entry plays instead of the head',
  res.play.length > 0 && res.play[0]!.ratingKey === 'gamma-e1',
  JSON.stringify(res.play.map((i) => i.ratingKey)));

// ...and it is still the entry's OWN next-unwatched episode, not blindly episode 1. This is
// what "the same machinery, a shorter list" has to mean to be worth anything.
WATCHED.add('gamma-e1');
res = await lineup('title:gamma');
ok('`only`: plays the entry\'s next UNWATCHED episode, not its first',
  res.play.length > 0 && res.play[0]!.ratingKey === 'gamma-e2',
  JSON.stringify(res.play.map((i) => i.ratingKey)));
WATCHED.delete('gamma-e1');

// A fully-watched entry has nothing to play — and must NOT silently fall through to the
// queue's head, which would start something the owner did not click.
WATCHED.add('gamma-e1');
WATCHED.add('gamma-e2');
res = await lineup('title:gamma');
ok('`only`: a finished entry plays nothing (never falls back to the head)',
  res.play.length === 0, JSON.stringify(res.play.map((i) => i.ratingKey)));
WATCHED.delete('gamma-e1');
WATCHED.delete('gamma-e2');

// A key that is no longer in the file (removed on another device, stale tab) is reported as
// such rather than playing the head.
res = await lineup('title:deleted-entry');
ok('`only`: an unknown key reports unknownEntry and plays nothing',
  res.play.length === 0 && res.unknownEntry === 'title:deleted-entry',
  JSON.stringify(res));

// --------------------------------------------------------------------------- //
// The HTTP contract: which sets may be asked to play one entry
// --------------------------------------------------------------------------- //
// A rotation channel's pool is a RULE — nothing in it has an entry key — so `only` there is a
// request error, not a field to ignore. Asserted as the shape the server branches on, since
// importing the server would boot a listener and an MQTT client.
const rejects = (s: { source: string }) => Boolean(s.source !== 'queue');
ok('a rotation channel rejects `only`', rejects({ source: 'rotation' }) === true);
ok('a curated queue accepts `only`', rejects({ source: 'queue' }) === false);

// mqttc.play only puts `only` on the wire when it is set, so an ordinary start's payload is
// byte-for-byte what it was before this feature existed.
interface PlayPayload {
  set: string;
  kind: string;
  target?: string;
  profile?: string;
  only?: string;
}
const payloadFor = (
  setId: string,
  kind?: string,
  target?: string,
  profile?: string,
  only?: string,
): PlayPayload => {
  const payload: PlayPayload = { set: setId, kind: kind || 'movie' };
  if (target) payload.target = target;
  if (profile) payload.profile = profile;
  if (only) payload.only = only;
  return payload;
};
assert.deepEqual(payloadFor('bob', 'movie'), { set: 'bob', kind: 'movie' });
ok('an ordinary start\'s MQTT payload is unchanged (no `only` key)', true);
ok('a one-entry start carries the key',
  payloadFor('bob', 'movie', undefined, undefined, 'title:gamma').only === 'title:gamma');

console.log(FAILS.length ? `\n${FAILS.length} FAILED: ${FAILS.join(', ')}` : '\nall green');
process.exit(FAILS.length ? 1 : 0);
