// Offline unit test for D3 follow-on #4: the live-client surface + async engine + preview
// formatter. Uses the corpus replay client (same surface as live, sync values) so CI needs
// no Plex. Proves: (1) engine functions accept awaitable clients, (2) formatBuckets matches
// the Python do_preview shape, (3) signature helpers are stable.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(REPO, 'e2e', 'fixtures');
const CORPUS = path.join(FIX, 'engine-corpus');
const SETS = path.join(FIX, 'engine.sets.yaml');

execFileSync('python3', ['e2e/gen-synthetic-corpus.py', CORPUS], { cwd: REPO, stdio: 'inherit' });
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

// liveClient factory exists and exposes the contract (don't call Plex — no token in CI).
const { liveClient } = await import('../server/src/engine/plex-live.js');
const live = liveClient();
ok('liveClient has container + accountToken', typeof live.container === 'function' && typeof live.accountToken === 'function');

console.log(failures ? `\nFAILED: ${failures}` : '\nOK: live-client adapter offline checks pass');
process.exit(failures ? 1 : 0);
