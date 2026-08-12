// Offline unit test for the live-client surface + async engine + preview formatter. Uses the
// committed synthetic corpus's replay client (same surface as live, sync values) so CI needs
// no Plex. Proves: (1) engine functions accept awaitable clients, (2) formatBuckets keeps the
// preview payload shape the web UI reads, (3) signature helpers are stable.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(REPO, 'e2e', 'fixtures');
const CORPUS = path.join(FIX, 'engine-corpus');
const SETS = path.join(FIX, 'engine.sets.yaml');

process.env.SETS_PATH = SETS;

const routing = await import('../server/src/engine/routing.js');
const rotation = await import('../server/src/engine/rotation.js');
const { replayClient } = await import('../server/src/engine/plex-replay.js');
const preview = await import('../server/src/engine/preview.js');

// A client that returns Promises (like undici live) even though the data is corpus-local.
function asyncReplayClient(dir) {
  const base = replayClient(dir);
  return {
    container: async (p, t) => base.container(p, t),
    accountToken: async (u) => base.accountToken(u),
  };
}

let failures = 0;
function ok(label, cond, detail = '') {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const client = asyncReplayClient(CORPUS);
const reg = routing.loadSets(SETS);
const cfg = reg.sets.kidsplus;
const binding = routing.bindingFor(cfg, 'Younger');

console.log('=== live-client adapter (async surface over corpus) ===');
const buckets = await rotation.channelBuckets(client, cfg, binding);
ok('channelBuckets returns rows', Array.isArray(buckets) && buckets.length > 0, `got ${buckets?.length}`);
ok('member Alpha wins (dedup)', buckets.some((b) => b.show === 'Alpha' && b.episodes.length === 2));

const formatted = preview.formatBuckets(buckets);
ok('formatBuckets has unwatched + next', formatted.every((b) => 'unwatched' in b && 'next' in b));
ok('signature is stable', preview.bucketsSignature(formatted) === preview.bucketsSignature(formatted));
ok('signature changes if emptied', preview.bucketsSignature(formatted) !== preview.bucketsSignature([]));

// Library buckets: next is non-deterministic at preview time; item set is the signal.
{
  const a = [{ show: 'Shorts', ratingKey: 'section-15', unwatched: 2,
    next: { ratingKey: '1', title: 'A', season: null, episode: null },
    items: [{ ratingKey: '1', title: 'A' }, { ratingKey: '2', title: 'B' }] }];
  const b = [{ show: 'Shorts', ratingKey: 'section-15', unwatched: 2,
    next: { ratingKey: '2', title: 'B', season: null, episode: null },
    items: [{ ratingKey: '2', title: 'B' }, { ratingKey: '1', title: 'A' }] }];
  ok('library bucket ignores next for signature', preview.bucketsSignature(a) === preview.bucketsSignature(b));
  const c = [{ show: 'Shorts', ratingKey: 'section-15', unwatched: 1,
    next: { ratingKey: '1', title: 'A', season: null, episode: null },
    items: [{ ratingKey: '1', title: 'A' }] }];
  ok('library bucket still sees item-set change', preview.bucketsSignature(a) !== preview.bucketsSignature(c));
}

// liveClient factory exists and exposes the contract (don't call Plex — no token in CI).
const { liveClient } = await import('../server/src/engine/plex-live.js');
const live = liveClient();
ok('liveClient has container + accountToken', typeof live.container === 'function' && typeof live.accountToken === 'function');

console.log(failures ? `\nFAILED: ${failures}` : '\nOK: live-client adapter offline checks pass');
process.exit(failures ? 1 : 0);
