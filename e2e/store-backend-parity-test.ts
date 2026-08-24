// THE WP-2 GATE — the same YAML, served by both store backends, must produce the same API.
//
// The plan words it as "a fresh container with only the YAML files present comes up with an
// identical `/api/queues` response body, byte for byte, against a recorded fixture". Two
// things about that sentence had to change before it could be a gate, and both are worth
// saying out loud rather than quietly working around:
//
//   1. A RECORDED FIXTURE GOES STALE THE MOMENT IT IS RECORDED. `/config` has a live writer —
//      the app tops a queue up and sweeps completions with nobody at a keyboard — so a
//      response captured at 20:23 does not match the same request at 20:24, for reasons that
//      have nothing to do with the store. So the comparison here is not against a recorded
//      body. It boots the server TWICE over IDENTICAL COPIES of one committed fixture, once
//      per backend, and compares the two live answers. Nothing in it can go stale.
//   2. "BYTE FOR BYTE" IS TOO STRONG FOR SOME FIELDS AND TOO WEAK FOR OTHERS. See MASKED
//      below: three fields legitimately differ between two runs of the SAME backend, so
//      comparing them proves nothing and fails at random. Everything else — every id, every
//      order, every count, every flag — is compared STRICTLY, which is stronger than a byte
//      compare of a body that had to be regenerated to be trusted.
//
// Plex is unreachable on purpose (`PLEX_API_SERVER_URL` points at a closed port), so both
// runs take the degraded path and neither is talking to the household's server.
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';

import { killServer, spawnServer } from './stubs/server-process.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

/**
 * MASKED FIELDS: NONE. That is a measured result, not an oversight.
 *
 * The plan warned that `/api/queues` carries Plex progress and timestamps that move on their
 * own, and against the LIVE server they do. This harness does not talk to a live server:
 * `PLEX_API_SERVER_URL` points at a closed port, so both runs take the degraded path, and the
 * only fields left are the ones that come out of the store. Running the comparison with the
 * mask removed was the check — all four bodies are byte-identical between the two backends
 * with nothing masked at all, so a mask list here would be a list of fields nobody had to
 * excuse.
 *
 * Two candidates were considered and are NOT needed, for the record, because the next agent
 * will wonder:
 *
 *   `generation`  the Plex cache's counter. Each run gets its own scratch `cache.sqlite`, and
 *                 with Plex unreachable neither run ever increments it past its own zero.
 *   the ETag      `store.queues.revision()` + `store.sets.revision()` + the cache generation.
 *                 It is `(mtimeMs, size)` under YAML and `(updated_at_ms, version)` under
 *                 SQLite — two honest answers to "has this changed" that are not comparable to
 *                 each other. It is a RESPONSE HEADER, and this harness compares BODIES, so it
 *                 never enters the comparison. That it changes on a write is gated by
 *                 `api-v2-test.ts`, which is the property that actually matters.
 *
 * If a future change makes a body carry a clock reading, mask that field HERE and say why in
 * this comment. An unexplained mask is how a real regression hides.
 */
let failures = 0;
const ok = (name: string, condition: boolean, extra = ''): void => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!condition) failures += 1;
};

const ROUTES = ['/api/queues', '/api/sets', '/api/groups', '/api/pending'] as const;

async function capture(backend: 'yaml' | 'sqlite', port: number): Promise<Record<string, unknown>> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), `qp-parity-${backend}-`));
  for (const name of ['sets', 'queues', 'groups', 'pending']) {
    await fs.copyFile(path.join(FIXTURES, `store-parity.${name}.yaml`), path.join(dir, `${name}.yaml`));
  }

  const child: ChildProcess = spawnServer({
    env: {
      ...process.env,
      WEB_PORT: String(port),
      STORE_BACKEND: backend,
      QUEUES_PATH: path.join(dir, 'queues.yaml'),
      SETS_PATH: path.join(dir, 'sets.yaml'),
      GROUPS_PATH: path.join(dir, 'groups.yaml'),
      PENDING_PATH: path.join(dir, 'pending.yaml'),
      HISTORY_PATH: path.join(dir, '.history.json'),
      CACHE_PATH: path.join(dir, 'cache.sqlite'),
      PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
      PLEX_TOKEN: '',
      MQTT_HOST: '',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    },
    stdio: 'ignore',
  });

  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        await fetch(`http://localhost:${port}/api/history`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    const bodies: Record<string, unknown> = {};
    for (const route of ROUTES) {
      const response = await fetch(`http://localhost:${port}${route}`);
      bodies[route] = await response.json();
    }
    return bodies;
  } finally {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      killServer(child);
    });
  }
}

// The YAML backend first, so a failure in the OLD path is not blamed on the new one.
const fromYaml = await capture('yaml', 18795);
const fromSqlite = await capture('sqlite', 18796);

for (const route of ROUTES) {
  const left = JSON.stringify(fromYaml[route]);
  const right = JSON.stringify(fromSqlite[route]);
  ok(`${route} is identical under both backends`, left === right);
  if (left !== right) {
    // Print the first divergence rather than two 200 KB blobs.
    let index = 0;
    while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
    console.log(`   yaml   …${left.slice(Math.max(0, index - 120), index + 200)}`);
    console.log(`   sqlite …${right.slice(Math.max(0, index - 120), index + 200)}`);
  }
}

// The wire ids, named rather than counted. A body that matched but had renamed every set
// would pass the compare above and break every NFC card in the house.
const sets = (fromSqlite['/api/sets'] as { sets?: { id: string }[] }).sets ?? [];
const queues = Object.keys((fromSqlite['/api/queues'] as { sets?: Record<string, unknown> }).sets ?? {});
const groups = (fromSqlite['/api/groups'] as { groups?: { id: string }[] }).groups ?? [];

const EXPECTED_SETS = ['bob', 'bob_alice', 'demo', 'carol_reading', 'empty_queue', 'kids'];
const EXPECTED_QUEUES = ['bob', 'bob_alice', 'demo', 'carol_reading', 'empty_queue'];
const EXPECTED_GROUPS = ['bob', 'bob-and-others', 'kids'];

ok(
  `every set wire id survived (${sets.length})`,
  EXPECTED_SETS.every((id) => sets.some((set) => set.id === id)),
  sets.map((set) => set.id).join(','),
);
ok(
  'every queue wire id survived, including the EMPTY one',
  EXPECTED_QUEUES.every((id) => queues.includes(id)),
  queues.join(','),
);
ok(
  `every group wire id survived (${groups.length})`,
  EXPECTED_GROUPS.every((id) => groups.some((group) => group.id === id)),
  groups.map((group) => group.id).join(','),
);

console.log(failures ? `\n${failures} parity assertion(s) failed` : '\nstore backends agree');
process.exit(failures ? 1 : 0);
