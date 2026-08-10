// Runtime config for the plex-channels-web queue editor. Mirrors the Python
// queue_builder/config.py env names so ONE TrueNAS app env feeds both processes.
import path from 'node:path';
import { hostval } from './hostConfig.js';

const rstrip = (s) => (s || '').replace(/\/+$/, '');

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

export const WEB_PORT = parseInt(process.env.WEB_PORT || '8768', 10);

// Undo/redo stack mirror (dotfile beside queues.yaml) so history survives a container
// restart. Not user-facing data — the YAML files stay the durable state.
export const HISTORY_PATH =
  process.env.HISTORY_PATH || path.join(path.dirname(QUEUES_PATH), '.history.json');

// Set membership/labels/order now live in the sets.yaml registry (web/src/sets.js) —
// the UI-editable single source of truth shared with queue_builder/config.py.
