// Runtime config for the queuepilot-web queue editor. Mirrors the Python
// queue_builder/config.py env names so ONE TrueNAS app env feeds both processes.
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hostval } from './hostConfig.js';

const rstrip = (s: string | null | undefined): string => (s || '').replace(/\/+$/, '');

export const PLEX_URL = rstrip(hostval('PLEX_API_SERVER_URL', 'plex_api_server_url', 'https://plex.example.com'));
// The OWNER/admin token (same one the Python service uses). PLEX_TOKEN wins, then the
// legacy PLEX_API_KEY name, matching config.py's precedence.
export const PLEX_TOKEN = process.env.PLEX_TOKEN || process.env.PLEX_API_KEY || '';
// Stable client identifier for minting per-account (managed-user) tokens against plex.tv —
// must match config.py's PLEX_CLIENT_IDENTIFIER so the switch→server-scoped-token exchange
// is repeatable (used by plex.js accountToken → per-account ratings, workstream D).
export const PLEX_CLIENT_IDENTIFIER = process.env.PLEX_CLIENT_IDENTIFIER || 'plex-channels-helper';

// The shared curated-queue store — the SAME file the Python prune rewrites. Default matches
// config.py so a single /config mount serves both. Writes from here and the Python prune are
// coordinated by a cross-process lock (see queues.js withLock / queue_builder.queues).
export const QUEUES_PATH = process.env.QUEUES_PATH || '/config/queues.yaml';

/**
 * THE BOOK OF RECORD — sets, queues, entries, groups, pending, lead cooldowns (WP-2).
 *
 * Not `cache.sqlite`, which is the derived Plex cache and is safe to delete; the two are two
 * files and never one
 * (decision 2026-08-23-sqlite-is-the-book-of-record-and-cache-sqlite-stays-derived).
 *
 * ── Why the default is derived and not a constant ────────────────────────────────────────
 *
 * In production this is `/config/queuepilot.sqlite` and nothing else. The derivation exists
 * for the ~59 offline e2e harnesses: each one points its YAML at a scratch file and expects a
 * clean store, and a fixed path would have every one of them read and write the SAME database.
 * That is not hypothetical — `live-client-adapter-test.ts` read a store another suite had
 * seeded, and passed nothing.
 *
 * Derived from the FILE rather than its directory, because a dozen harnesses put their scratch
 * YAML straight in `/tmp` and would otherwise still collide with each other.
 *
 * ── Why it walks a list ──────────────────────────────────────────────────────────────────
 *
 * A harness overrides whichever paths it needs and no more, and it is allowed to point one at
 * a deliberate dead end: `batch-stops-at-test.ts` sets
 * `SETS_PATH=/nonexistent-so-loadSets-is-never-consulted.yaml`, whose directory is `/` and is
 * not writable. So the candidates are tried in order and the first one in an EXISTING
 * directory wins; if none is, the store goes to a hash of them under the temp directory, which
 * is deterministic per harness and always writable.
 */
const STORE_CANDIDATES = [
  process.env.QUEUES_PATH,
  process.env.SETS_PATH,
  process.env.GROUPS_PATH,
  process.env.PENDING_PATH,
].filter((candidate): candidate is string => Boolean(candidate));

const beside = (file: string): string => `${file.replace(/\.ya?ml$/i, '')}.queuepilot.sqlite`;

function defaultStorePath(): string {
  if (STORE_CANDIDATES.length === 0) return '/config/queuepilot.sqlite';

  for (const candidate of STORE_CANDIDATES) {
    try {
      if (statSync(path.dirname(candidate)).isDirectory()) return beside(candidate);
    } catch {
      /* not a directory we can put a database in — try the next one */
    }
  }

  const digest = createHash('sha256').update(STORE_CANDIDATES.join('|')).digest('hex').slice(0, 16);
  return path.join(tmpdir(), `queuepilot-${digest}.sqlite`);
}

export const STORE_PATH = process.env.STORE_PATH || defaultStorePath();

/**
 * Which implementation of the store seam serves reads — `sqlite` (the book of record) or
 * `yaml` (the four files, WP-1's implementation, unchanged).
 *
 * `sqlite` is the default from this release. `STORE_BACKEND=yaml` is the ROLLBACK: one env var
 * on the app, a restart, and the reader is the YAML files again — which is exactly why the
 * SQLite store keeps writing them through this release (see `STORE_YAML_MIRROR`). Take the
 * mirror away and the rollback goes with it.
 */
export const STORE_BACKEND: 'sqlite' | 'yaml' =
  process.env.STORE_BACKEND === 'yaml' ? 'yaml' : 'sqlite';

/**
 * Whether the SQLite store also writes the YAML files on every mutation.
 *
 * ON for one release, as the rollback path. The files it writes are the store's own
 * projection, so they REFORMAT once on the first write after the cutover — block style where
 * the hand-written file used flow, and a comment that belonged to no row is gone. The
 * importer's copy-aside is what keeps the original readable. Set `STORE_YAML_MIRROR=0` to stop
 * writing them; after that YAML is an import bridge and nothing else.
 */
export const STORE_YAML_MIRROR = process.env.STORE_YAML_MIRROR !== '0';

export const WEB_PORT = parseInt(process.env.WEB_PORT || '8768', 10);

// Undo/redo stack mirror (dotfile beside queues.yaml) so history survives a container
// restart. Not user-facing data — the YAML files stay the durable state.
export const HISTORY_PATH =
  process.env.HISTORY_PATH || path.join(path.dirname(QUEUES_PATH), '.history.json');

// Set membership/labels/order now live in the sets.yaml registry (web/src/sets.js) —
// the UI-editable single source of truth shared with queue_builder/config.py.
