// A real server over a set of committed fixtures, in its own scratch config directory.
//
// Shared by `vrt-capture.ts` (the visual-regression shots) and `smoke/serve.ts` (the
// four-window browser smoke), so the pictures and the layout gate are taken against the SAME
// data and neither can drift into showing something the other never checked.
//
// **Fixture data only.** This repo is public and a PNG is opaque to every grep. Plex is a closed
// port, every other provider is unset, and the MQTT_* values an agent shell carries are blanked
// so nothing here dials the household broker.
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { REPO_ROOT, spawnServer } from './stubs/server-process.mjs';

export interface FixtureFiles {
  groups?: string;
  /** Copied under the proposal FILENAME, which is the one the importer reads. */
  people?: string;
  queues: string;
  sets: string;
}

export interface FixtureServer {
  base: string;
  child: ChildProcess;
  dir: string;
}

/** Poll until the URL answers 2xx — 30 s, then throw rather than hand back a dead server. */
export async function waitReady(url: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`fixture-server: the server never answered ${url}`);
}

/** Committed fixtures in a private config directory, and a server over them. Stop it with
 *  `killServer(server.child)` — `tsx` forks the real server, so the group must go. */
export async function startFixtureServer(port: number, files: FixtureFiles): Promise<FixtureServer> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'qp-fixture-'));
  const fixture = (name: string) => path.join(REPO_ROOT, 'e2e', 'fixtures', name);

  await fs.copyFile(fixture(files.sets), path.join(dir, 'sets.yaml'));
  await fs.copyFile(fixture(files.queues), path.join(dir, 'queues.yaml'));
  if (files.groups) {
    await fs.copyFile(fixture(files.groups), path.join(dir, 'groups.yaml'));
  } else {
    await fs.writeFile(path.join(dir, 'groups.yaml'), 'groups: []\n');
  }
  if (files.people) {
    await fs.copyFile(fixture(files.people), path.join(dir, 'people-mapping-proposal.yaml'));
  }
  await fs.writeFile(path.join(dir, 'pending.yaml'), 'seen_through: 0\n');

  const child = spawnServer({
    env: {
      ...process.env,
      CACHE_PATH: path.join(dir, 'cache.sqlite'),
      GROUPS_PATH: path.join(dir, 'groups.yaml'),
      HISTORY_PATH: path.join(dir, '.history.json'),
      // The agent shell carries real MQTT_* values; a harness that keeps them dials the
      // household broker.
      MQTT_HOST: '',
      MQTT_PASS: '',
      MQTT_PORT: '',
      MQTT_USER: '',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      PENDING_PATH: path.join(dir, 'pending.yaml'),
      PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
      PLEX_TOKEN: '',
      PROVIDERS_PATH: path.join(dir, 'providers.yaml'),
      PROVIDERS_SECRETS_PATH: path.join(dir, 'providers.secrets.yaml'),
      QUEUES_PATH: path.join(dir, 'queues.yaml'),
      SETS_PATH: path.join(dir, 'sets.yaml'),
      STORE_BACKEND: 'sqlite',
      WEB_PORT: String(port),
    },
    stdio: 'ignore',
  });

  const base = `http://localhost:${port}`;
  await waitReady(`${base}/api/people`);
  return { base, child, dir };
}
