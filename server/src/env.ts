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

import { hostval } from './hostConfig.js';

const str = (name: string, fallback: string): string => process.env[name] ?? fallback;
const int = (name: string, fallback: number): number => {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};
const float = (name: string, fallback: number): number => {
  const n = parseFloat(process.env[name] ?? '');
  return Number.isFinite(n) ? n : fallback;
};
const bool = (name: string, fallback: boolean): boolean => {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return ['1', 'true', 'yes'].includes(v.toLowerCase());
};
// A JSON-valued env var, with the Python default reproduced as a literal. A malformed value
// falls back rather than crashing boot — config.py would raise here, but this process also
// serves the web UI, and losing the editor because ADB_PROFILE_ORDER has a stray comma is a
// worse failure than ignoring the override.
//
// Generic in the FALLBACK's type, not in the parsed value's: `JSON.parse` returns `any`, and
// the override is asserted to the default's shape. That assertion is unchecked on purpose —
// validating it would mean rejecting a malformed override at boot, which is exactly the
// crash this function exists to avoid. The consumers of the two JSON knobs
// (PROFILE_SET_MAP, ADB_PROFILE_ORDER) already tolerate junk values.
const json = <T,>(name: string, fallback: T): T => {
  const v = process.env[name];
  if (v == null || v.trim() === '') return fallback;
  try {
    return JSON.parse(v) as T;
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
// WHERE a multi-episode batch may stop — the count cap above says how many, this says where it
// may end. "none" (default) fills across anything; "member" forbids spanning two collection
// members; "season" also forbids spanning a season boundary, including inside one show (so
// `episodes: 2` at a finale queues the finale alone, not finale + next premiere). Set per-set
// in sets.yaml, overridable per entry in queues.yaml. Mirrors config.BATCH_STOPS_AT.
export const BATCH_STOPS_AT = str('BATCH_STOPS_AT', 'none');

// Rotation queue length (episodes queued per cartoons session) — the DEFAULT only. A set
// overrides it with `length:`, because 12 is four hours of Shows and half an hour of Shorts.
export const ROTATION_LENGTH = int('ROTATION_LENGTH', 12);
// The hard safety cap on a set's `length:`, so a typo can't schedule a thousand Plex round
// trips at scan time. Same role QUEUE_SERIES_LENGTH plays for a per-entry `episodes:`.
export const ROTATION_LENGTH_MAX = int('ROTATION_LENGTH_MAX', 200);

// --- top-up (a `refill: true` channel) ---------------------------------------- //
// How few items may remain AFTER the playing one before a top-up tick actually extends the
// lineup. A tick that finds more than this left does nothing, so HA can publish on a dumb
// interval and the app stays the one deciding — the tick is a WAKE-UP, not a command to grow.
//
// 3 and not 1: the extend is a Plex round trip plus a lineup build, so waking with one item
// left races the viewer finishing it. It is also why top-up's "Play Next" insert position is
// harmless in practice — at 3 remaining there is almost no tail left to jump.
export const TOPUP_AT = int('TOPUP_AT', 3);
// How long after a top-up before another may run, so a stuck HA automation (or two publishing
// automations) cannot walk the lineup up to ROTATION_LENGTH_MAX one tick at a time. Belt for
// the TOPUP_AT braces: that guard is a READ of live state and this one needs no read at all.
export const TOPUP_COOLDOWN_SECONDS = int('TOPUP_COOLDOWN_SECONDS', 60);

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
export const SHIELD_CAST_NAME = hostval('SHIELD_CAST_NAME', 'shield_cast_name', 'Family Room SHIELD');
// Used by "client" mode only.
export const SHIELD_CLIENT_MACHINE_ID = hostval('SHIELD_CLIENT_MACHINE_ID', 'shield_client_machine_id', '');
export const SHIELD_CLIENT_NAME = hostval('SHIELD_CLIENT_NAME', 'shield_client_name', 'Family Room SHIELD');
// Direct Plex Companion endpoint of the Shield (http://<ip>:32500). Blank = resolve it from
// plex.tv's device list at runtime, which is the normal path.
export const SHIELD_CLIENT_URI = hostval('SHIELD_CLIENT_URI', 'shield_client_uri', '');
// LAN address of the Plex server, handed to the client in playMedia so it knows where to
// stream from. Must be reachable FROM the Shield, not from this container.
export const PLEX_LOCAL_URL = String(hostval('PLEX_LOCAL_URL', 'plex_local_url', 'http://192.0.2.10:32400')).replace(/\/+$/, '');

// --- resume-on-advance (resume.js) -------------------------------------------- //
// A Plex playQueue has no per-item resume point and playMedia's `offset` only applies to the
// item it starts on, so episodes 2..N restart at 0:00. resume.js seeks them to their own
// marker after the player advances. RESUME_ON_ADVANCE=0 turns the whole thing off.
export const RESUME_ON_ADVANCE = bool('RESUME_ON_ADVANCE', true);
// Below this, a marker means "never really started" — don't seek (default 30s).
export const RESUME_MIN_MS = int('RESUME_MIN_MS', 30_000);
// Past this fraction of the runtime the episode is effectively over; restarting is right.
export const RESUME_MAX_FRACTION = Number(str('RESUME_MAX_FRACTION', '0.95')) || 0.95;
// Only seek an episode still near its start; past this we missed the transition (or the viewer
// scrubbed there deliberately) and yanking them backwards is worse than doing nothing.
export const RESUME_START_WINDOW_MS = int('RESUME_START_WINDOW_MS', 120_000);
// How often to ask the SERVER what is playing. /status/sessions is the trigger because the
// now-playing topic's HA source reports a playing state with a null ratingKey on this setup.
export const RESUME_POLL_MS = int('RESUME_POLL_MS', 5_000);

// --- profile-driven set selection (set="auto") -------------------------------- //
// The signed-in Plex Home profile on the Shield decides the tier; cards carry only the KIND
// (cartoons/movie). Detection tails the PMS DEBUG log (profiles.py → profiles.js), so the log
// volume must be mounted read-only at PMS_LOG_PATH's parent.
export const PMS_LOG_PATH = str('PMS_LOG_PATH', '/pms-logs/Plex Media Server.log');
export const SHIELD_IP = hostval('SHIELD_IP', 'shield_ip', '192.0.2.30');
export const PROFILE_WAIT_SECONDS = int('PROFILE_WAIT_SECONDS', 120);
// Plex Home profile title -> set name. Titles must match plex.tv exactly.
export const PROFILE_SET_MAP = json<Record<string, string>>('PROFILE_SET_MAP', {
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
export const ADB_PROFILE_ORDER = json<string[]>('ADB_PROFILE_ORDER', []);
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

// --- the rename cutover (2026-08-12 → 2026-08-15, complete) ------------------- //
// `plex-channels` became `queuepilot`, so every topic below moved prefix. The old prefix was
// kept live as an alias by MQTT_LEGACY_PREFIX, so nothing outside this container had to change
// on the deploy that renamed things; HA finished migrating on 2026-08-12, the bridge went off
// on 2026-08-15, and the alias helpers were deleted afterwards. The record of what was done
// and what proved it unused is docs/queuepilot-mqtt-cutover.md.
//
// MQTT_PREFIX is the canonical prefix. Nothing reads it now that the alias helpers are gone —
// the T_* defaults below are LITERALS under `queuepilot/` rather than composed from it, so
// overriding this alone moves nothing. It stays as the declared name of the prefix the topics
// sit under, which is what the doc and the app env both refer to.
export const MQTT_PREFIX = str('MQTT_PREFIX', 'queuepilot');

export const T_CMD_START = str('T_CMD_START', 'queuepilot/cmd/session/start');
export const T_CMD_ADVANCE = str('T_CMD_ADVANCE', 'queuepilot/cmd/session/advance');
export const T_CMD_SOUNDTRACK = str('T_CMD_SOUNDTRACK', 'queuepilot/cmd/soundtrack/resolve');
// Top-up tick for a `refill: true` channel. Published by an HA automation on a dumb interval
// while something is playing — HA owns the schedule (workspace rule), and this app owns every
// judgement about whether the lineup is actually low. The tick carries NO arguments: a payload
// saying "add 12" would move that judgement to the automation, where it cannot see the queue.
export const T_CMD_TOPUP = str('T_CMD_TOPUP', 'queuepilot/cmd/session/topup');
// What the tick did, so the automation (and a human reading the broker) can see a no-op as a
// no-op rather than as silence. Not retained: it describes one tick, not a current state.
export const T_RESP_TOPUP = str('T_RESP_TOPUP', 'queuepilot/resp/topup');
// A SITTING finished — the playback length was reached, or the lineup genuinely ran out.
// Carries `power_off`, which is the set asking the house to shut the room down.
//
// The app ANNOUNCES; it does not switch anything off. "The whole system" is a TV, a receiver
// and a Shield, and HA is what owns things with power cables (workspace rule: services talk
// over MQTT, HA owns the physical world). A `power_off: true` here is a request an automation
// may honour, ignore, or gate on who is in the room — none of which this app should decide.
// Not retained: it describes one moment, not a current state.
export const T_RESP_FINISHED = str('T_RESP_FINISHED', 'queuepilot/resp/finished');
// Cast sidecar command topic (decision 2026-08-03). The sidecar has always read this from
// env (cast_sidecar/service.py:18); the publisher used to hardcode it in playback.js, so the
// two halves could be re-pointed independently and silently diverge — the sidecar sitting on
// a topic nobody publishes to. Both halves now read the SAME env name with the SAME default.
export const T_CMD_CAST_PLAY = str('T_CMD_CAST_PLAY', 'queuepilot/cmd/cast/play');
// Rotation-channel preview: the request carries a `reply` topic under T_RESP_PREVIEW_BASE and
// the computed pool is published there (request/response). Deleted at D6 — the preview
// endpoint calls the engine in-process — but the topic names stay until then.
export const T_CMD_PREVIEW = str('T_CMD_PREVIEW', 'queuepilot/cmd/generic/preview');
export const T_RESP_PREVIEW_BASE = str('T_RESP_PREVIEW_BASE', 'queuepilot/resp/preview');
export const T_RESP_LAST_PLAYED = str('T_RESP_LAST_PLAYED', 'queuepilot/resp/last-played');
export const T_RESP_SOUNDTRACK = str('T_RESP_SOUNDTRACK', 'queuepilot/resp/soundtrack');
export const T_STATE = str('T_STATE', 'queuepilot/state');
// LIVE playback, bridged onto MQTT by the HA automation "Plex Channels Now Playing" from the
// Plex integration's media_player (already push-fed by the PMS websocket, so nothing polls).
// T_STATE only says what a session STARTED with; this says what is on screen NOW.
export const T_NOW_PLAYING = str('T_NOW_PLAYING', 'queuepilot/now-playing');
// MQTT discovery: HA creates sensor.queuepilot_status from T_STATE on its own. This object_id
// IS the entity_id, so changing it creates a NEW entity rather than renaming the old one —
// which is why the rename left `sensor.plex_channels_status` alive alongside it, off its own
// retained discovery config. That entity was retired on 2026-08-15 by clearing that config
// (docs/queuepilot-mqtt-cutover.md), so there is only one sensor now.
export const T_DISCOVERY_BASE = str('T_DISCOVERY_BASE', 'homeassistant');
export const DISCOVERY_OBJECT_ID = str('DISCOVERY_OBJECT_ID', 'queuepilot_status');

// --- device registry (the web UI's "Play on <device>" dropdown) --------------- //
// Castable targets are announced as RETAINED queuepilot/devices/<id> messages: the
// env-default Shield plus every plex.tv device advertising as a player. A start command may
// then carry {"target": "<id>"} to override the default Shield.
export const T_DEVICES_BASE = str('T_DEVICES_BASE', 'queuepilot/devices');
export const DEVICE_ANNOUNCE_SECONDS = int('DEVICE_ANNOUNCE_SECONDS', 300);

// --- soundtrack resolver (Living-Room-reader easter egg) ---------------------- //
export const MA_URL = str('MA_URL', '');
export const MA_TOKEN = str('MA_TOKEN', '');
export const OLLAMA_URL = str('OLLAMA_URL', '');
export const OLLAMA_MODEL = str('OLLAMA_MODEL', 'gemma3:4b');

// --- the derived Plex cache (decision 2026-08-03-sqlite-is-a-derived-plex-cache) //
// Deletable, gitignored, never backed up. `rm` it and the app rebuilds it.
export const CACHE_PATH = str('CACHE_PATH', '/config/cache.sqlite');

// --- providers (decision 2026-08-12-backends-are-providers-behind-a-media-neutral-seam) //
// Definitions are plaintext and live beside sets.yaml / queues.yaml. TOKENS DO NOT: they get
// their own 0600 file, holding nothing but id -> token, excluded from the YAML-editing,
// undo-history and .bak machinery (decision
// 2026-08-12-provider-tokens-live-in-a-separate-config-file). Read providers/config.js
// before touching either path.
export const PROVIDERS_PATH = str('PROVIDERS_PATH', '/config/providers.yaml');
export const PROVIDERS_SECRETS_PATH = str('PROVIDERS_SECRETS_PATH', '/config/providers.secrets.yaml');

// QueuePilot GROUPS — who is watching, and which provider accounts each of them IS.
// Plaintext and hand-editable like providers.yaml, and for the same reason: it holds names,
// never credentials. `groups.ts`, deliberately NOT `profiles.ts` — that one is Plex's, and
// the whole reason this concept is called a group is that PROFILE was already taken.
export const GROUPS_PATH = str('GROUPS_PATH', '/config/groups.yaml');

// Kavita's deploy-time base URL. Named to match the root .env the rest of the fleet already
// uses (KAVITA_API_SERVER_URL / KAVITA_API_KEY) so one variable feeds every consumer. The
// KEY is deliberately absent from this module — secrets resolve through providers/config.js,
// which is the only place allowed to read a token.
export const KAVITA_URL = str('KAVITA_API_SERVER_URL', '').replace(/\/+$/, '');
// How long a Plugin/authenticate JWT is reused before re-minting. Kavita's tokens are
// long-lived; this is a refresh floor, not the token's real lifetime.
export const KAVITA_JWT_TTL_SECONDS = int('KAVITA_JWT_TTL_SECONDS', 3600);
// Chapters queued per series per rotation round on the reading side — the "read at least X
// chapters before switching series" knob from the feasibility record's opening ask.
export const KAVITA_BATCH_DEFAULT = int('KAVITA_BATCH_DEFAULT', 1);

// Board Game Picker's base URL. Named for the product, matching the live host
// (board-game-picker.example.com) rather than the repo folder. Its API token is OPTIONAL —
// the picker only demands one when BOARD_GAME_PICKER_API_TOKEN is set on ITS side — so
// unlike Kavita, having this URL is what "configured" means. The token, if any, still
// resolves through providers/config.js like every other secret.
export const BOARD_GAME_PICKER_URL = str('BOARD_GAME_PICKER_URL', '').replace(/\/+$/, '');
