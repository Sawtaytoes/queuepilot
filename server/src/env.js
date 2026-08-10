// The runtime knobs, in ONE place, mirroring queue_builder/config.py's env names 1:1.
//
// Why this module exists: during the Python → Node port (decision
// 2026-08-03-retiring-python-except-the-cast-sidecar) both halves run in the same container
// off the SAME TrueNAS app env. A default that drifts between the two is a bug you only see
// on the family TV — e.g. Node publishing to `plex-channels/cmd/session/start` while Python
// listens on an overridden T_CMD_START. So every knob is read here, once, with the Python
// default reproduced verbatim, and the ported modules import from here rather than reaching
// into `process.env` themselves.
//
// Not in scope: PLEX_URL / PLEX_TOKEN / PLEX_CLIENT_IDENTIFIER / QUEUES_PATH / WEB_PORT /
// HISTORY_PATH, which `config.js` already owns and the server has always read from there.
// This module is the knobs that had NO Node reader before the port.

const str = (name, fallback) => process.env[name] ?? fallback;
const int = (name, fallback) => {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};
const float = (name, fallback) => {
  const n = parseFloat(process.env[name] ?? '');
  return Number.isFinite(n) ? n : fallback;
};
const bool = (name, fallback) => {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return ['1', 'true', 'yes'].includes(v.toLowerCase());
};
// A JSON-valued env var, with the Python default reproduced as a literal. A malformed value
// falls back rather than crashing boot — config.py would raise here, but this process also
// serves the web UI, and losing the editor because ADB_PROFILE_ORDER has a stray comma is a
// worse failure than ignoring the override.
const json = (name, fallback) => {
  const v = process.env[name];
  if (v == null || v.trim() === '') return fallback;
  try {
    return JSON.parse(v);
  } catch {
    console.log(`[env] ${name} is not valid JSON — using the default`);
    return fallback;
  }
};

// --- library section ids (verified live) ------------------------------------- //
// SEC_SHORTS/SEC_SHOWS/SEC_ANIME are NOT env-configurable on the Python side either; they
// are constants there and stay constants here. SEC_ANIME is deliberately excluded from the
// kid channels (decision 2026-07-08) — kept for reference, do not add it to a set's pool
// without a new decision.
export const SEC_MOVIES = int('PLEX_SEC_MOVIES', 1);
// Documentaries are their own Plex section but count as "Movies" for the curated queues.
export const SEC_DOCS = int('PLEX_SEC_DOCS', 14);
export const SEC_SHORTS = 15;
export const SEC_SHOWS = 5;
export const SEC_ANIME = 11;

// ONLY a default for a set that doesn't name its own `watch_count_accounts`. Every set
// currently does, so nothing uses it: each card reflects its OWN profile's history. Unioning
// across profiles was tried and reverted (2026-07-16) — it let Bob's viewing drive the kids'
// cards. Don't route a new set through this without a reason.
export const WATCH_COUNT_ACCOUNTS = String(str('WATCH_COUNT_ACCOUNTS', '1,11111111,22222222'))
  .split(',')
  .map((a) => parseInt(a.trim(), 10))
  .filter((n) => Number.isFinite(n));

// --- curated queues ---------------------------------------------------------- //
// Episodes queued for a series entry per play, TV-style (it resumes next scan). DEFAULT is 1
// (one episode, like a TV channel); a queue entry may override per-show with `episodes:`.
// QUEUE_SERIES_LENGTH is the hard safety cap so a bad override can't queue a whole series.
export const QUEUE_SERIES_DEFAULT = int('QUEUE_SERIES_DEFAULT', 1);
export const QUEUE_SERIES_LENGTH = int('QUEUE_SERIES_LENGTH', 40);

// Rotation queue length (episodes queued per cartoons session).
export const ROTATION_LENGTH = int('ROTATION_LENGTH', 12);

// --- playback target (the Family Room theater Shield) ------------------------- //
// PLAYBACK_MODE:
//   "cast"   -> Plex Cast to the Shield's Google-Cast receiver AS the set's account token.
//               The deterministic per-account path: the receiver plays under the token it is
//               handed, so the watch records on the RIGHT account no matter which user the
//               Shield's Plex app is signed into. (Needs SHIELD_CAST_NAME.)
//   "client" -> remote-control the Shield's Plex app via playMedia. Simpler, but the watch
//               records under whatever user that app is signed into.
// Note the port keeps cast in the Python sidecar precisely because "client" mode loses
// per-profile attribution and is therefore not an acceptable substitute.
export const PLAYBACK_MODE = str('PLAYBACK_MODE', 'cast');
export const SHIELD_CAST_NAME = str('SHIELD_CAST_NAME', 'Family Room SHIELD');
// Used by "client" mode only.
export const SHIELD_CLIENT_MACHINE_ID = str('SHIELD_CLIENT_MACHINE_ID', '');
export const SHIELD_CLIENT_NAME = str('SHIELD_CLIENT_NAME', 'Family Room SHIELD');
// Direct Plex Companion endpoint of the Shield (http://<ip>:32500). Blank = resolve it from
// plex.tv's device list at runtime, which is the normal path.
export const SHIELD_CLIENT_URI = str('SHIELD_CLIENT_URI', '');
// LAN address of the Plex server, handed to the client in playMedia so it knows where to
// stream from. Must be reachable FROM the Shield, not from this container.
export const PLEX_LOCAL_URL = String(str('PLEX_LOCAL_URL', 'http://192.0.2.10:32400')).replace(/\/+$/, '');

// --- profile-driven set selection (set="auto") -------------------------------- //
// The signed-in Plex Home profile on the Shield decides the tier; cards carry only the KIND
// (cartoons/movie). Detection tails the PMS DEBUG log (profiles.py → profiles.js), so the log
// volume must be mounted read-only at PMS_LOG_PATH's parent.
export const PMS_LOG_PATH = str('PMS_LOG_PATH', '/pms-logs/Plex Media Server.log');
export const SHIELD_IP = str('SHIELD_IP', '192.0.2.30');
export const PROFILE_WAIT_SECONDS = int('PROFILE_WAIT_SECONDS', 120);
// Plex Home profile title -> set name. Titles must match plex.tv exactly.
export const PROFILE_SET_MAP = json('PROFILE_SET_MAP', {
  'Younger Kids': 'younger',
  'Older Kids': 'older',
});

// --- ADB profile switching (adb.py → adb.js) ---------------------------------- //
// Closes the loop on a profile gate: instead of only waiting for a human to pick the profile
// on screen, drive the Shield's picker with D-pad events. OFF by default — it injects key
// events into whatever is on the family TV, so it must be opted into explicitly.
export const ADB_ENABLED = bool('ADB_ENABLED', false);
export const ADB_BIN = str('ADB_BIN', 'adb');
export const ADB_TARGET = str('ADB_TARGET', `${SHIELD_IP}:5555`);
// The Shield only trusts adb keys it has been shown once, via an on-TV prompt. A fresh
// container generates a NEW key and would sit unauthorized with no way to accept it, so this
// points at the already-authorized private key (mounted, NOT baked into the image).
export const ADB_KEY_PATH = str('ADB_KEY_PATH', '/config/.android/adbkey');
// Picker order. DERIVED from plex.tv /api/v2/home/users, whose order matches the on-screen
// picker (confirmed 2026-07-26) — not hand-maintained, so adding or removing a Home user
// can't silently leave it stale. Cached to disk so a plex.tv outage doesn't cost the ability
// to switch. Set the env var only as a manual override; empty = derive.
export const ADB_PROFILE_ORDER = json('ADB_PROFILE_ORDER', []);
export const ADB_PROFILE_ORDER_CACHE = str('ADB_PROFILE_ORDER_CACHE', '/config/profile-order.json');
export const ADB_PROFILE_ORDER_TTL = int('ADB_PROFILE_ORDER_TTL', 3600);
// Hard bound on D-pad presses before giving up — never spin on a UI that changed.
export const ADB_MAX_PRESSES = int('ADB_MAX_PRESSES', 12);
// How long to keep looking for the picker to appear (the HA script foregrounds Plex AFTER
// publishing the start command, so the picker lags the scan by a few seconds).
export const ADB_PICKER_WAIT_SECONDS = int('ADB_PICKER_WAIT_SECONDS', 45);
// Once Plex is signed in there is NO picker to drive — foregrounding the app lands on
// HomeActivityTV (verified 2026-07-26), so a wrong-profile card could never self-switch. A
// force-stop + relaunch cold-starts the app straight back to the picker. Only ever done when
// a switch is actually needed and the grace period found no picker; it does kill whatever
// Plex was playing, which is why it is a knob.
export const ADB_RESTART_TO_PICKER = bool('ADB_RESTART_TO_PICKER', true);
export const ADB_TIMEOUT = int('ADB_TIMEOUT', 15);
// How long to wait for Plex to reach the foreground after we launch it over ADB. Companion
// playback (:32500) and the picker both need Plex running, so a scan blocks on this.
export const ADB_PLEX_LAUNCH_WAIT_SECONDS = int('ADB_PLEX_LAUNCH_WAIT_SECONDS', 20);

// --- playback FSM (driver.js; mirrors queue_builder/config.py) ---------------- //
// When on, session start hands launch + profile gate + play to driver.driveToPlaying,
// which SAMPLES real state and drives VERIFIED, RETRIED, NON-DESTRUCTIVE transitions
// (unreachable -> device_on -> plex_foreground -> signed_in(required) -> playing).
// Flip with PLAYBACK_FSM=true once verified on-Shield. See docs/playback-state-machine-design.md.
export const PLAYBACK_FSM = bool('PLAYBACK_FSM', false);
// The Plex Companion TCP port on the client (playMedia lands here). The FSM probes this
// immediately before firing play so a closed / mid-nav Plex surfaces as "not ready, re-open
// + retry" instead of an Errno 111 that kills the scan.
export const COMPANION_PORT = int('COMPANION_PORT', 32500);
// Bounded retries for the FSM's two fragile transitions. `play` re-opens Plex between
// connection-refused attempts; `switch` re-summons the picker between failed switches.
export const PLAYBACK_FSM_PLAY_ATTEMPTS = int('PLAYBACK_FSM_PLAY_ATTEMPTS', 3);
export const PLAYBACK_FSM_SWITCH_ATTEMPTS = int('PLAYBACK_FSM_SWITCH_ATTEMPTS', 2);
// Seconds to wait on the Companion TCP connect probe, and the short pause between retries.
export const PLAYBACK_FSM_COMPANION_TIMEOUT = float('PLAYBACK_FSM_COMPANION_TIMEOUT', 1.5);
export const PLAYBACK_FSM_RETRY_BACKOFF = float('PLAYBACK_FSM_RETRY_BACKOFF', 1.0);

// --- MQTT (Mosquitto HA add-on) ----------------------------------------------- //
// MQTT survives the port: HA's automations, the retained device registry and the discovery
// sensor are real external consumers. What goes away is the INTERNAL round trip between the
// two halves of this container.
export const MQTT_HOST = str('MQTT_HOST', '');
export const MQTT_PORT = int('MQTT_PORT', 1883);
export const MQTT_USER = process.env.MQTT_USER || undefined;
export const MQTT_PASS = process.env.MQTT_PASS || undefined;

export const T_CMD_START = str('T_CMD_START', 'plex-channels/cmd/session/start');
export const T_CMD_ADVANCE = str('T_CMD_ADVANCE', 'plex-channels/cmd/session/advance');
export const T_CMD_SOUNDTRACK = str('T_CMD_SOUNDTRACK', 'plex-channels/cmd/soundtrack/resolve');
// Rotation-channel preview: the request carries a `reply` topic under T_RESP_PREVIEW_BASE and
// the computed pool is published there (request/response). Deleted at D6 — the preview
// endpoint calls the engine in-process — but the topic names stay until then.
export const T_CMD_PREVIEW = str('T_CMD_PREVIEW', 'plex-channels/cmd/generic/preview');
export const T_RESP_PREVIEW_BASE = str('T_RESP_PREVIEW_BASE', 'plex-channels/resp/preview');
export const T_RESP_LAST_PLAYED = str('T_RESP_LAST_PLAYED', 'plex-channels/resp/last-played');
export const T_RESP_SOUNDTRACK = str('T_RESP_SOUNDTRACK', 'plex-channels/resp/soundtrack');
export const T_STATE = str('T_STATE', 'plex-channels/state');
// LIVE playback, bridged onto MQTT by the HA automation "Plex Channels Now Playing" from the
// Plex integration's media_player (already push-fed by the PMS websocket, so nothing polls).
// T_STATE only says what a session STARTED with; this says what is on screen NOW.
export const T_NOW_PLAYING = str('T_NOW_PLAYING', 'plex-channels/now-playing');
// MQTT discovery: HA creates sensor.plex_channels_status from T_STATE on its own.
export const T_DISCOVERY_BASE = str('T_DISCOVERY_BASE', 'homeassistant');
export const DISCOVERY_OBJECT_ID = str('DISCOVERY_OBJECT_ID', 'plex_channels_status');

// --- device registry (the web UI's "Play on <device>" dropdown) --------------- //
// Castable targets are announced as RETAINED plex-channels/devices/<id> messages: the
// env-default Shield plus every plex.tv device advertising as a player. A start command may
// then carry {"target": "<id>"} to override the default Shield.
export const T_DEVICES_BASE = str('T_DEVICES_BASE', 'plex-channels/devices');
export const DEVICE_ANNOUNCE_SECONDS = int('DEVICE_ANNOUNCE_SECONDS', 300);

// --- soundtrack resolver (Living-Room-reader easter egg) ---------------------- //
export const MA_URL = str('MA_URL', '');
export const MA_TOKEN = str('MA_TOKEN', '');
export const OLLAMA_URL = str('OLLAMA_URL', '');
export const OLLAMA_MODEL = str('OLLAMA_MODEL', 'gemma3:4b');

// --- the port's own switches -------------------------------------------------- //
// Each ported phase ships behind one of these, defaulting to the PYTHON path until its soak
// passes (decision 2026-08-03-retiring-python-except-the-cast-sidecar).
//   ENGINE=node|python           — the selection engine (D3)
//   PLAYBACK_ENGINE=node|python  — session start / PlayQueue building (D7)
export const ENGINE = str('ENGINE', 'python');
export const PLAYBACK_ENGINE = str('PLAYBACK_ENGINE', 'python');

// --- the derived Plex cache (decision 2026-08-03-sqlite-is-a-derived-plex-cache) //
// Deletable, gitignored, never backed up. `rm` it and the app rebuilds it.
export const CACHE_PATH = str('CACHE_PATH', '/config/cache.sqlite');
