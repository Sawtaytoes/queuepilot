// Changing `add_as` changes where NEW entries land. It must not bulk-move the entries that
// already inherit the old default (decision 2026-08-30-changing-a-queue-default-preserves-existing-lanes).
//
// API-level and offline: this is a write-order contract between sets.yaml and queues.yaml.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.env.WEB_PORT || '18991', 10);
const BASE = `http://localhost:${PORT}`;
const scratch = '/tmp/queuepilot-default-lane-change';
const queuesPath = `${scratch}/queues.yaml`;
const setsPath = `${scratch}/sets.yaml`;

await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, queuesPath);
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, setsPath);

const srv = spawnServer({
  env: {
    ...process.env,
    CACHE_PATH: `${scratch}/cache.sqlite`,
    HISTORY_PATH: `${scratch}/.history.json`,
    MQTT_HOST: '',
    QUEUES_PATH: queuesPath,
    SETS_PATH: setsPath,
    STORE_PATH: `${scratch}/queuepilot.sqlite`,
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

const waitReady = async () => {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${BASE}/api/history`)).ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('QueuePilot did not start');
};

const patchDefault = async (id: string, addAs: 'priority' | 'random') => {
  const response = await fetch(`${BASE}/api/sets/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ add_as: addAs }),
  });
  assert.equal(response.status, 200, await response.text());
};

const readQueue = async (id: string): Promise<{ placement: string | null }[]> => {
  const shelves = await fetch(`${BASE}/api/shelves`).then((response) => response.json()) as {
    sets: Record<string, { items: { placement: string | null }[] }>;
  };
  return shelves.sets[id]?.items ?? [];
};

try {
  await waitReady();

  // Legacy Movies inherits Priority. Preserve every existing sparse entry before making
  // Random the default for later additions.
  const orderedBefore = await readQueue('bob');
  assert.ok(orderedBefore.every((entry) => entry.placement == null));
  await patchDefault('bob', 'random');
  const orderedAfter = await readQueue('bob');
  assert.equal(orderedAfter.length, orderedBefore.length);
  assert.ok(orderedAfter.every((entry) => entry.placement === 'priority'));

  // Legacy Anime inherits Random. The reverse change must preserve that pool too.
  const randomBefore = await readQueue('bob_anime');
  assert.ok(randomBefore.every((entry) => entry.placement == null));
  await patchDefault('bob_anime', 'priority');
  const randomAfter = await readQueue('bob_anime');
  assert.equal(randomAfter.length, randomBefore.length);
  assert.ok(randomAfter.every((entry) => entry.placement === 'random'));

  const registry = await fetch(`${BASE}/api/sets`).then((response) => response.json()) as {
    sets: { id: string; add_as?: string }[];
  };
  assert.equal(registry.sets.find((set) => set.id === 'bob')?.add_as, 'random');
  assert.equal(registry.sets.find((set) => set.id === 'bob_anime')?.add_as, 'priority');

  console.log('default-lane-change-test: ok');
} finally {
  await killServer(srv);
  await fs.rm(scratch, { recursive: true, force: true });
}
