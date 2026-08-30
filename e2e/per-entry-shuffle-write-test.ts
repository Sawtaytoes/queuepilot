// API and YAML write side for a Picks entry's inner item order.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.env.WEB_PORT || '18992', 10);
const BASE = `http://localhost:${PORT}`;
const scratch = '/tmp/queuepilot-per-entry-shuffle-write';
const queuesPath = `${scratch}/queues.yaml`;
const setsPath = `${scratch}/sets.yaml`;

await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, queuesPath);
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, setsPath);

const server = spawnServer({
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

async function waitReady(): Promise<void> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${BASE}/api/shelves`)).ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('QueuePilot did not start');
}

type ShelfItem = { key: string; item_order?: string | null };
async function firstItem(): Promise<ShelfItem> {
  const body = await fetch(`${BASE}/api/shelves`).then((response) => response.json()) as {
    sets: Record<string, { items: ShelfItem[] }>;
  };
  const item = body.sets.bob?.items[0];
  assert.ok(item, 'fixture must have a bob entry');
  return item;
}

async function patchOrder(key: string, itemOrder: unknown): Promise<void> {
  const response = await fetch(
    `${BASE}/api/queues/bob/items/${encodeURIComponent(key)}/item-order`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item_order: itemOrder }),
    },
  );
  assert.equal(response.status, 200, await response.text());
}

try {
  await waitReady();
  const original = await firstItem();
  assert.equal(original.item_order, null);

  await patchOrder(original.key, 'shuffle');
  assert.equal((await firstItem()).item_order, 'shuffle');
  assert.match(await fs.readFile(queuesPath, 'utf8'), /item_order:\s*shuffle/);

  await patchOrder(original.key, 'not-a-mode');
  assert.equal((await firstItem()).item_order, null);
  assert.doesNotMatch(await fs.readFile(queuesPath, 'utf8'), /item_order:/);

  console.log('per-entry-shuffle-write-test: ok');
} finally {
  await killServer(server);
  await fs.rm(scratch, { recursive: true, force: true });
}
