// Boot a server over the Tonight fixtures, in its own temp config directory.
//
// Shared by `tonight-test.ts` (the gate) and `shot-tonight.ts` (the PR's screenshots), so
// the images and the assertions are taken against the SAME data and neither can drift into
// showing something the other never checked.
//
// **Fixture data, never live.** The Tonight surface renders the household's people and its
// queue labels, and both of those ARE the household. Everything here is the repo's own
// anonymized cast — Ada, Grace and Linus
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
// Plex is deliberately unroutable (a closed port), so nothing in a run of this talks to
// anything real. The four non-Plex providers are pointed at `.invalid` hosts, which is
// enough to make them CONFIGURED — which is all the registry needs to report a set's
// `provider_kind`, and therefore all this screen needs.
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { killServer, spawnServer } from './stubs/server-process.mjs';

export interface TonightServer {
  child: ChildProcess;
  dir: string;
  base: string;
}

/** Copy the fixtures into a scratch config directory and start the server over them. */
export async function startTonightServer(port: number): Promise<TonightServer> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'qp-tonight-'));

  await fs.copyFile('e2e/fixtures/tonight.sets.yaml', path.join(dir, 'sets.yaml'));
  await fs.copyFile('e2e/fixtures/tonight.queues.yaml', path.join(dir, 'queues.yaml'));
  // The proposal FILENAME, not a confirmed one: the tool writes this name and confirming is
  // meant to be one edit rather than an edit plus a rename.
  await fs.copyFile(
    'e2e/fixtures/tonight.people.yaml',
    path.join(dir, 'people-mapping-proposal.yaml'),
  );
  await fs.writeFile(path.join(dir, 'groups.yaml'), 'groups: []\n');
  await fs.writeFile(path.join(dir, 'pending.yaml'), 'seen_through: 0\n');

  const child = spawnServer({
    env: {
      ...process.env,
      // Configured is all that matters — none of these is ever called.
      BOARD_GAME_PICKER_URL: 'https://board-games.invalid',
      CACHE_PATH: path.join(dir, 'cache.sqlite'),
      GROUPS_PATH: path.join(dir, 'groups.yaml'),
      HISTORY_PATH: path.join(dir, '.history.json'),
      KAVITA_API_KEY: 'offline-harness-key',
      KAVITA_API_SERVER_URL: 'https://kavita.invalid',
      MISTER_API_SERVER_URL: 'https://mister.invalid',
      MQTT_HOST: '',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      PENDING_PATH: path.join(dir, 'pending.yaml'),
      PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
      PLEX_TOKEN: '',
      PROVIDERS_PATH: path.join(dir, 'providers.yaml'),
      PROVIDERS_SECRETS_PATH: path.join(dir, 'providers.secrets.yaml'),
      QUEUES_PATH: path.join(dir, 'queues.yaml'),
      SETS_PATH: path.join(dir, 'sets.yaml'),
      STEAM_ID: '76500000000000000',
      STORE_BACKEND: 'sqlite',
      WEB_PORT: String(port),
    },
    stdio: 'ignore',
  });

  const base = `http://localhost:${port}`;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const res = await fetch(`${base}/api/sets`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return { base, child, dir };
}

/** Stop the whole process GROUP — `tsx` forks the real server, so killing the wrapper
 * leaves a live server holding the port and the next run asserts against the orphan. */
export const stopTonightServer = (server: TonightServer): void => killServer(server.child);
