// Playback: build a Plex playQueue and tell the Family Room Shield to play it.
//
// CLIENT mode is the live path
// (PLAYBACK_MODE=client permanent for this process half). CAST mode is delegated to the
// Python cast_sidecar via MQTT `queuepilot/cmd/cast/play` (decision
// 2026-08-03-retiring-python-except-the-cast-sidecar) — never reimplemented here.
//
// Playback runs under the set's own managed-user account (Younger Kids / Older Kids) via
// the server-scoped access token (`plex.accountToken`) — NOT admin. So watched-state
// records under that kid/older account and the owner's history stays separate. If the
// account token can't be minted it falls back to admin (degraded — attribution wrong).
//
// Everything here needs the Shield's Plex app foregrounded (advertising as a client);
// until then `playRatingKeys` degrades gracefully and reports that no client was
// reachable — the selection + last-played publish still succeed.
//
// Companion returns body "Failure: 200 OK" on success — only the HTTP status matters.

import net from 'node:net';
import { Agent, request } from 'undici';
import { PLEX_URL, PLEX_TOKEN, PLEX_CLIENT_IDENTIFIER } from './config.js';
import {
  PLAYBACK_MODE,
  SHIELD_CAST_NAME,
  SHIELD_CLIENT_MACHINE_ID,
  SHIELD_CLIENT_NAME,
  SHIELD_CLIENT_URI,
  SHIELD_IP,
  COMPANION_PORT,
  PLAYBACK_FSM_COMPANION_TIMEOUT,
  PLEX_LOCAL_URL,
  MQTT_HOST,
  MQTT_PORT,
  MQTT_USER,
  MQTT_PASS,
  T_CMD_CAST_PLAY,
} from './env.js';
import { accountToken, plexGet } from './plex.js';
import { getSet } from './sets.js';
import type { Device, PushResult } from './types.js';
import { PlexError, errMessage, isNodeError, isPlexError } from './errors.js';

const CLIENT_ID = PLEX_CLIENT_IDENTIFIER;

// --- local shapes ------------------------------------------------------------- //
//
// Everything below is declared HERE rather than in types.ts because it is either (a) a
// Plex wire subset only this file reads, or (b) an extra field types.ts's `PushResult`
// does not carry. Nothing here is a second spelling of an existing shared type.

/**
 * What a play attempt actually returns.
 *
 * `PushResult` is the shared contract, but the two paths in this file each bolt on fields it
 * does not declare: the cast path adds `delegated` + `topic` (the handoff to cast_sidecar is
 * explicit in the logged state), and the client path adds `playQueueID`. Widening `PushResult`
 * itself would claim every push provider emits them, so they live here as an extension.
 */
export type PlaybackResult = PushResult & {
  /** Cast only: the play was handed to cast_sidecar, which owns played/scrobble from here. */
  delegated?: boolean;
  /** Cast only: the MQTT topic the handoff went out on. */
  topic?: string;
  /** Client only: the playQueue we built, even when the Companion push then failed. */
  playQueueID?: number | string | null;
};

/** `seekTo()`'s result. Deliberately not a `PushResult` — nothing published reads it. */
export interface SeekResult {
  seeked: boolean;
  error?: string;
  offset?: number;
}

/** What `currentSession()` reports — resume.js's trigger shape. */
export interface CurrentSession {
  ratingKey: string;
  viewOffset: number;
}

/**
 * The verdict of `verifyAccount()` — who Plex is ACTUALLY playing as on our client.
 *
 * Three outcomes, and the caller must treat them differently:
 *   * `isMismatch: true`  — a session exists and it belongs to somebody else. Terminal.
 *   * `isMismatch: false` with an `accountId` — confirmed correct.
 *   * `isMismatch: false` with `accountId: null` — could not tell (no session yet, Plex
 *     unreachable, or nothing to compare against). NOT a failure: a transcode can take
 *     longer to surface a session than we are willing to block a card scan for, and failing
 *     a play that is probably fine is worse than the audit occasionally abstaining.
 */
export interface AccountVerdict {
  isMismatch: boolean;
  accountId: number | null;
  title: string | null;
  /** Why we could not tell, when `accountId` is null. Log-only. */
  reason?: string;
}

/**
 * A player as plex.tv's `/api/v2/devices` describes it, flattened by `playerDevices()`.
 *
 * NOT `Device` from types.ts: every field here is nullable, because plex.tv omits `name` on
 * some rows and a player advertising no connection has no `uri` at all. `Device` declares
 * `name`/`machineIdentifier` as plain strings — see the note in devices.ts.
 */
export interface PlayerDevice {
  name: string | null;
  machineIdentifier: string | null;
  uri: string | null;
}

/** The resolved Companion target a command is sent to (`findClient()`). */
export interface ClientTarget {
  name: string | null;
  machineIdentifier: string | null;
  /** The player's DIRECT Companion endpoint, or null to relay via the Plex server. */
  uri: string | null;
}

/** One plex.tv device row, before `playerDevices()` flattens it. */
interface PlexTvDeviceRow {
  name?: string | null;
  clientIdentifier?: string | null;
  provides?: string | null;
  connections?: { uri?: string | null }[] | null;
}

/** One audio/video stream on a Part. `streamType` is 2 for audio, and Plex has shipped it
 * both as a number and as a string, which is why the runtime check tests for both. */
interface PlexStream {
  id?: number | string;
  streamType?: number | string;
  language?: string;
  languageCode?: string;
}

interface PlexPart {
  id?: number | string | null;
  Stream?: PlexStream[];
}

/** The Metadata fields the playback + resume paths read. A superset of no shared type:
 * `PlexMetadata` in types.ts is the ENGINE's view and carries neither `Player` nor `Media`. */
interface PlaybackMetadata {
  ratingKey?: string | number;
  viewOffset?: number;
  Player?: { machineIdentifier?: string; title?: string };
  Media?: { Part?: PlexPart[] }[];
}

/** The `MediaContainer` fields this file reads, across all four of its endpoints. */
interface PlaybackContainer {
  size?: number;
  playQueueID?: number | string;
  /** Where the viewer is IN the queue — the index of the selected item. Top-up measures
   *  what is left from here, never from the queue's length alone. */
  playQueueSelectedItemOffset?: number;
  Metadata?: PlaybackMetadata[];
  /** `/clients` answers with one or the other depending on server version. */
  Server?: { name?: string; machineIdentifier?: string }[];
  Device?: { name?: string; machineIdentifier?: string }[];
}

/** `plexReq()`'s return: parsed JSON, or `{_raw}` when the body was not JSON. */
interface PlexReqJson {
  MediaContainer?: PlaybackContainer;
  _raw?: string;
}

/**
 * `e.name` for a caught value, matching the original `e && e.name ? e.name : 'Error'`
 * exactly — including for a thrown non-Error object that happens to carry a `name`.
 */
function errName(e: unknown): string {
  if (e != null && typeof e === 'object') {
    const n = (e as { name?: unknown }).name;
    if (n) return String(n);
  }
  return 'Error';
}

// Dedicated undici agent for Companion + playQueue POSTs. Companion is on the Shield
// (often plain HTTP, sometimes self-signed TLS if proxied); the Plex server cert is
// self-signed. Same rejectUnauthorized:false rule as plex.js.
const agent = new Agent({
  keepAliveTimeout: 30_000,
  connections: 8,
  connect: { rejectUnauthorized: false },
});

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

// --- Companion readiness ----------------------------------------------------- //

// Is the Plex Companion endpoint (host:32500) accepting a TCP connection right now?
// playMedia lands on the client's Companion server; when Plex is closed or mid-navigation
// that port isn't listening and the GET fails with ECONNREFUSED, which used to kill the
// scan with nothing playing. The FSM (driver.js) probes this immediately before firing
// play so it can re-open Plex and retry instead. A cheap connect-and-drop — proves the
// port is up without sending a request.
export async function companionReady(
  host: string | null = null,
  port: number | string | null = null,
  timeout: number | null = null,
): Promise<boolean> {
  const h = host || SHIELD_IP;
  const p = Number(port || COMPANION_PORT);
  const t = timeout == null ? PLAYBACK_FSM_COMPANION_TIMEOUT : timeout;
  const timeoutMs = Math.max(50, Math.floor(Number(t) * 1000));
  return new Promise<boolean>((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    try {
      sock.connect(p, h);
    } catch {
      done(false);
    }
  });
}

// --- machine identifier + companion target (helpers that lived on plex.py) --- //

let _machineId: string | null = null;

// The server's machineIdentifier (needed to build playQueue URIs + playMedia params).
export async function machineIdentifier(): Promise<string> {
  if (_machineId) return _machineId;
  try {
    const data = await plexGet('/') as { MediaContainer?: { machineIdentifier?: string } } | null;
    _machineId = (data && data.MediaContainer && data.MediaContainer.machineIdentifier) || '';
  } catch {
    _machineId = '';
  }
  // `?? ''` is for the compiler only: both branches above assign a string, but an `await`
  // discards the narrowing on a module-scoped `let`.
  return _machineId ?? '';
}

// Test seam: clear the cached machine id (unit tests / after a PMS rebuild).
export function _resetMachineIdentifier(): void {
  _machineId = null;
}

// name|machineId -> the plex.tv row that answered for it.
const _companionTarget = new Map<string, PlayerDevice>();

async function plextv<T = unknown>(path: string, token = PLEX_TOKEN, method = 'GET'): Promise<T> {
  const res = await fetch(`https://plex.tv${path}`, {
    method,
    headers: {
      'X-Plex-Token': token,
      'X-Plex-Client-Identifier': CLIENT_ID,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`plex.tv ${res.status} for ${path}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

// Every plex.tv device advertising as a player, as [{name, machineIdentifier, uri}].
// Port of the retired queue_builder/plex.py `player_devices()` (deleted with the Python
// service in #60), which the Node port never carried over — that omission is why the MQTT
// device registry has been Shield-only and the web UI's "Play on ▾" dropdown was reading
// stale retained ghosts (docs/queuepilot-mqtt-cutover.md, "The device-registry gap").
//
// TWO callers, deliberately one implementation: devices.js announces this list, and
// companionTarget below picks one row out of it. Writing the plex.tv call twice is how the
// two would drift on a Plex API change.
//
// `uri` is null for a player advertising no connection (Plex Dash does this) — such a device
// is still announceable and still castable by name, so it is NOT filtered out here; the
// caller decides whether it needs a direct endpoint. Throws on a plex.tv failure so callers
// can tell "no players" from "could not ask".
export async function playerDevices(): Promise<PlayerDevice[]> {
  const devices = await plextv<PlexTvDeviceRow[] | { devices?: PlexTvDeviceRow[] }>(
    '/api/v2/devices',
    PLEX_TOKEN,
  );
  const rows: PlexTvDeviceRow[] = Array.isArray(devices) ? devices : devices.devices || [];
  return rows
    .filter((d) => String(d.provides || '').includes('player'))
    .map((d) => ({
      name: d.name || null,
      machineIdentifier: d.clientIdentifier || null,
      uri: (d.connections || []).map((c) => c.uri).find(Boolean) || null,
    }));
}

// Resolve a player's DIRECT Plex Companion endpoint (http://<ip>:32500) via plex.tv.
// The local server's /clients only lists GDM-discovered players, which never reaches the
// Shield here — so ask plex.tv and talk to the player directly. Cached per key.
export async function companionTarget(
  name: string | null,
  machineId = '',
): Promise<PlayerDevice | null> {
  const key = machineId || name || '';
  if (!key) return null;
  if (_companionTarget.has(key)) return _companionTarget.get(key) ?? null;
  let rows: PlayerDevice[];
  try {
    rows = await playerDevices();
  } catch {
    return null; // network/plex.tv hiccup: caller falls back
  }
  for (const d of rows) {
    if (machineId && d.machineIdentifier !== machineId) continue;
    if (!machineId && d.name !== name) continue;
    // This caller DOES need a direct endpoint — playMedia is sent to `uri`.
    if (!d.uri) continue;
    _companionTarget.set(key, d);
    return d;
  }
  return null;
}

export function _resetCompanionTarget(): void {
  _companionTarget.clear();
}

// --- HTTP helpers ------------------------------------------------------------ //

async function playToken(
  setName: string | null = null,
  userUuid: string | null = null,
): Promise<string> {
  // Token used to build/drive playback: the ACTIVE BINDING's managed-user account token.
  //
  // `userUuid` is the binding session.js already resolved for this scan
  // (routing.bindingFor(cfg, profileTitle)) and it MUST win over the set's top-level
  // user_uuid, which routing.loadSets only mirrors from `profiles[0]` — the DEFAULT
  // binding. On a multi-profile channel (movies / shows / shorts: Younger Kids, then
  // Older Kids) reading the mirror built every playQueue as Younger Kids no matter which
  // profile was picked, and the Younger Kids account cannot see PG titles, so the queue
  // came back EMPTY. Companion still answers 200, so it reported `played: true` and the
  // Shield sat there. Only the binding token is correct here.
  if (userUuid) {
    try {
      const tok = await accountToken(userUuid);
      if (tok) return tok;
    } catch {
      /* fall through to the set default, then admin */
    }
  }
  if (setName) {
    try {
      const cfg = await getSet(setName);
      if (cfg && cfg.user_uuid) {
        const tok = await accountToken(cfg.user_uuid);
        if (tok) return tok;
      }
    } catch {
      /* fall through to admin */
    }
  }
  return PLEX_TOKEN;
}

// Low-level request against Plex server or a Companion host. Returns parsed JSON or {_raw}.
// Companion answers 200 with body "Failure: 200 OK" even when playback DOES start — only
// status is a usable success signal. Throws on non-2xx with .plexStatus / .code.
async function plexReq(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  {
    token = null,
    host = null,
    extraHeaders = null,
    timeoutMs = 60_000,
  }: {
    token?: string | null;
    host?: string | null;
    extraHeaders?: Record<string, string> | null;
    timeoutMs?: number;
  } = {},
): Promise<PlexReqJson> {
  const base = (host || PLEX_URL).replace(/\/+$/, '');
  const url = base + path;
  const headers: Record<string, string> = {
    'X-Plex-Token': token || PLEX_TOKEN,
    'X-Plex-Client-Identifier': CLIENT_ID,
    Accept: 'application/json',
    ...(extraHeaders || {}),
  };
  const res = await request(url, {
    dispatcher: agent,
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) {
    // PlexError carries BOTH `plexStatus` and the numeric `code` mirror the original set by
    // hand — see errors.ts for why the numeric `code` must not be merged with Node's string
    // errno `code` that driver.js's connection-refused matching walks.
    throw new PlexError(res.statusCode, path);
  }
  if (!text) return {};
  try {
    return JSON.parse(text) as PlexReqJson;
  } catch {
    return { _raw: text };
  }
}

// --- find client / create playQueue ------------------------------------------ //

// Return the target player as {name, machineIdentifier, uri}, or null.
// `device` (from the MQTT device registry, via a start command's `target`) overrides the
// env-default Shield. `uri` is the player's DIRECT Companion endpoint; commands go
// straight to it rather than being relayed by the server.
export async function findClient(device: Device | null = null): Promise<ClientTarget | null> {
  if (device) {
    if (device.uri) {
      return {
        name: device.name,
        machineIdentifier: device.machineIdentifier,
        uri: String(device.uri).replace(/\/+$/, ''),
      };
    }
    return companionTarget(device.name || '', device.machineIdentifier || '');
  }
  if (SHIELD_CLIENT_URI) {
    return {
      name: SHIELD_CLIENT_NAME,
      machineIdentifier: SHIELD_CLIENT_MACHINE_ID,
      uri: SHIELD_CLIENT_URI.replace(/\/+$/, ''),
    };
  }
  const target = await companionTarget(SHIELD_CLIENT_NAME, SHIELD_CLIENT_MACHINE_ID);
  if (target) return target;
  // Last-resort: local /clients (usually empty for the Shield — kept for parity).
  try {
    const mc: PlaybackContainer = (await plexReq('GET', '/clients')).MediaContainer || {};
    const clients = mc.Server || mc.Device || [];
    const wantId = SHIELD_CLIENT_MACHINE_ID;
    const wantName = (SHIELD_CLIENT_NAME || '').toLowerCase();
    for (const c of clients) {
      if (
        (wantId && c.machineIdentifier === wantId)
        || (wantName && String(c.name || '').toLowerCase().includes(wantName))
      ) {
        return {
          name: c.name ?? null,
          machineIdentifier: c.machineIdentifier ?? null,
          uri: null,
        };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Create a video playQueue from an ordered list of ratingKeys; return its id.
// continuous=false tells the client to STOP when the queue ends (per-scan max_items cap).
export async function createPlayQueue(
  ratingKeys: (string | number)[] | null | undefined,
  { token = null, continuous = true }: { token?: string | null; continuous?: boolean } = {},
): Promise<number | string | null> {
  if (!ratingKeys || !ratingKeys.length) return null;
  const mid = await machineIdentifier();
  const keys = ratingKeys.map(String).join(',');
  const uri = `server://${mid}/com.plexapp.plugins.library/library/metadata/${keys}`;
  const q = new URLSearchParams({
    type: 'video',
    uri,
    continuous: continuous ? '1' : '0',
    'X-Plex-Client-Identifier': CLIENT_ID,
  });
  const data = await plexReq('POST', `/playQueues?${q}`, { token });
  const mc: PlaybackContainer = (data && data.MediaContainer) || {};
  // An EMPTY queue is a hard failure, not a playable one. Plex answers 200 for a playQueue
  // built from ratingKeys this token cannot see (a managed account whose library filter hides
  // them), and drops them silently — size 0. Pushing that at the Shield "succeeds": Companion
  // returns 200, `played: true` is published, and nothing plays, with no error anywhere. That
  // is how the wrong-token bug above stayed invisible. Throw so playRatingKeys reports it.
  if (!mc.size) {
    throw new Error(
      `Plex built an EMPTY playQueue for ${ratingKeys.length} item(s) — this profile's account `
      + 'cannot see them',
    );
  }
  return mc.playQueueID ?? null;
}

/**
 * Read a live playQueue: its ordered ratingKeys and where the viewer is in it.
 *
 * The ONLY honest source for "how much is left" — the lineup this service built is what it
 * SENT, and the viewer has been skipping around in it since. Top-up decides on this, never on
 * `SESSION.queue`.
 */
export async function readPlayQueue(
  pqId: number | string,
  { token = null }: { token?: string | null } = {},
): Promise<{ ratingKeys: string[]; selectedOffset: number; remaining: number } | null> {
  const q = new URLSearchParams({ 'X-Plex-Client-Identifier': CLIENT_ID });
  let data: PlexReqJson;
  try {
    data = await plexReq('GET', `/playQueues/${pqId}?${q}`, { token });
  } catch {
    // A playQueue Plex has forgotten (server restart, expiry) is not an error worth throwing
    // at a background tick — it means "there is nothing to top up", which is the caller's
    // normal no-op path.
    return null;
  }
  const mc: PlaybackContainer = (data && data.MediaContainer) || {};
  const rows = (mc.Metadata || []) as { ratingKey?: string | number }[];
  const ratingKeys = rows.map((r) => String(r.ratingKey));
  const selectedOffset = Number(mc.playQueueSelectedItemOffset ?? 0) || 0;
  return { ratingKeys, selectedOffset, remaining: Math.max(0, ratingKeys.length - selectedOffset - 1) };
}

/**
 * Append items to a LIVE playQueue, keeping its id — so a top-up never interrupts playback.
 *
 * ⚠️ These are "Play Next" semantics, not "Add to Queue". Verified against this server
 * (e2e/spike-playqueue-extend.ts, 2026-08-17): `PUT /playQueues/{id}?uri=…` inserts
 * immediately AFTER the currently-selected item, and `next=0` / `next=1` / omitting `next`
 * all behave identically — there is no append-at-end spelling. Successive adds DO chain
 * correctly (Plex tracks `playQueueLastAddedItemID`), so a batch keeps its order.
 *
 * That is why top-up waits for TOPUP_AT: at three items left there is almost no tail for the
 * new items to jump ahead of, and a rotation channel's tail is a shuffle anyway. Do not
 * "fix" this by rebuilding the queue — a new playQueue restarts playback, which is the exact
 * hiccup this whole path exists to avoid.
 */
export async function extendPlayQueue(
  pqId: number | string,
  ratingKeys: (string | number)[] | null | undefined,
  { token = null }: { token?: string | null } = {},
): Promise<number | null> {
  if (!ratingKeys || !ratingKeys.length) return 0;
  const mid = await machineIdentifier();
  const q = new URLSearchParams({
    uri: `server://${mid}/com.plexapp.plugins.library/library/metadata/${ratingKeys.map(String).join(',')}`,
    'X-Plex-Client-Identifier': CLIENT_ID,
  });
  const data = await plexReq('PUT', `/playQueues/${pqId}?${q}`, { token });
  const mc: PlaybackContainer = (data && data.MediaContainer) || {};
  // Plex answers 200 with the queue's new size. Reported so the caller can log what actually
  // landed rather than what it asked for — the create path already learned that Plex silently
  // drops keys a token cannot see.
  return mc.size ?? null;
}

// --- audio language (best-effort, both paths) -------------------------------- //

// Select the `lang` audio stream on each queued item so it plays in that language
// (e.g. anime in Japanese, audio_language: "jpn"). Sets the SELECTED stream server-side
// under the set's account token — persists as that account's preference (acceptable:
// the account is the set's dedicated profile). Fully guarded.
async function applyAudioLanguage(
  ratingKeys: (string | number)[] | null | undefined,
  token: string,
  lang: string | null | undefined,
): Promise<void> {
  if (!lang || !ratingKeys || !ratingKeys.length) return;
  const want = String(lang).trim().toLowerCase();
  for (const rk of ratingKeys) {
    try {
      const data = await plexReq('GET', `/library/metadata/${rk}?includeBandwidths=1`, { token });
      const item = ((data.MediaContainer || {}).Metadata || [])[0];
      if (!item) continue;
      for (const media of item.Media || []) {
        for (const part of media.Part || []) {
          const streams = (part.Stream || []).filter((s) => s.streamType === 2 || s.streamType === '2');
          const match = streams.find((s) => {
            const code = String(s.languageCode || '').toLowerCase();
            const name = String(s.language || '').toLowerCase();
            return want === code || want === name || code.startsWith(want) || name.startsWith(want)
              || code.includes(want) || name.includes(want);
          });
          if (match && part.id != null) {
            // Standard Plex put for selected audio stream on a part.
            await plexReq(
              'PUT',
              `/library/parts/${part.id}?audioStreamID=${match.id}&allParts=1`,
              { token },
            );
          }
        }
      }
    } catch {
      /* per-item best-effort; keep going */
    }
  }
}

// --- cast path (sidecar only) ------------------------------------------------ //

// CAST is retired from this process: publish to the cast_sidecar MQTT topic, or return a
// clear error if MQTT isn't wired. Never runs pychromecast / plexapi here.
export async function castPlay(
  ratingKeys: (string | number)[] | null | undefined,
  setName: string | null = null,
  castName: string | null = null,
  offset: number | string | null = 0,
): Promise<PlaybackResult> {
  const result: PlaybackResult = {
    queued: (ratingKeys || []).length,
    played: false,
    mode: 'cast',
    client: castName || SHIELD_CAST_NAME || null,
  };
  if (!ratingKeys || !ratingKeys.length) {
    result.error = 'nothing to play';
    return result;
  }

  const payload = {
    rating_keys: ratingKeys.map(String),
    set: setName || null,
    cast_name: castName || SHIELD_CAST_NAME || null,
    offset: intOffset(offset),
  };

  if (!MQTT_HOST) {
    result.error = (
      'cast mode is handled by cast_sidecar — set MQTT_HOST so we can publish to '
      + `${T_CMD_CAST_PLAY}, or use PLAYBACK_MODE=client`
    );
    return result;
  }

  try {
    // Lazy import so unit tests that never touch cast don't need a live broker.
    const mqtt = await import('mqtt');
    await new Promise<void>((resolve, reject) => {
      const c = mqtt.connect({
        host: MQTT_HOST,
        port: MQTT_PORT,
        protocol: MQTT_PORT === 8883 ? 'mqtts' : 'mqtt',
        username: MQTT_USER,
        password: MQTT_PASS,
        reconnectPeriod: 0,
        connectTimeout: 5000,
      });
      const fail = (e: unknown): void => {
        try { c.end(true); } catch { /* ignore */ }
        reject(e instanceof Error ? e : new Error(errMessage(e)));
      };
      const timer = setTimeout(() => fail(new Error('MQTT connect timed out')), 6000);
      c.on('error', fail);
      c.on('connect', () => {
        c.publish(T_CMD_CAST_PLAY, JSON.stringify(payload), { qos: 1 }, (err) => {
          clearTimeout(timer);
          try { c.end(true); } catch { /* ignore */ }
          if (err) reject(err);
          else resolve();
        });
      });
    });
    // Delegated — the sidecar owns played/scrobble. Surface as played=true so callers
    // that only check that bit don't treat a successful handoff as failure; diag fields
    // make the handoff explicit for logs/state.
    result.played = true;
    result.delegated = true;
    result.topic = T_CMD_CAST_PLAY;
    return result;
  } catch (e) {
    result.error = (
      `cast_sidecar MQTT publish failed (${errMessage(e)}). `
      + `Ensure cast_sidecar is subscribed to ${T_CMD_CAST_PLAY}, or use PLAYBACK_MODE=client.`
    );
    return result;
  }
}

function intOffset(offset: number | string | null | undefined): number {
  const n = Number(offset || 0);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

// --- playRatingKeys (client is the live path) -------------------------------- //

// Play the queue on the target player. Dispatches on the device's mode (registry entry
// via start command `target`), else PLAYBACK_MODE on the env-default Shield.
//
// "client" → remote-control the player's Plex app via Companion playMedia.
// "cast"   → MQTT to cast_sidecar (per-account Plex Cast lives there).
//
// `offset` (ms) is the resume point for the FIRST queued item — non-zero only for a
// curated queue whose lead item was started but not finished.
// What the SERVER says is playing on our target player, as {ratingKey, viewOffset} or null.
//
// This is resume.js's trigger. The retained now-playing topic would have been cheaper, but its
// HA source reports `{"state":"playing", "ratingKey":null}` on this setup — a playing state it
// cannot name — so it is unusable for deciding WHICH episode to seek. /status/sessions names
// the episode and gives its position.
export async function currentSession(
  { device = null }: { device?: Device | null } = {},
): Promise<CurrentSession | null> {
  let data: PlexReqJson;
  try {
    // ADMIN token, deliberately — NOT the set's account token. /status/sessions returns an
    // EMPTY container for a managed user, so querying as the set's profile makes every session
    // invisible and the resume watcher silently does nothing. Measured on the live deploy while
    // a kids' episode was playing:
    //   currentSession({})                -> {"ratingKey":"359877","viewOffset":19485}
    //   currentSession({setName:'shows'}) -> null
    // The seek itself still goes out under the play token, matching playMedia.
    data = await plexReq('GET', '/status/sessions', { token: await playToken(null) });
  } catch {
    return null;
  }
  const md = (data && data.MediaContainer && data.MediaContainer.Metadata) || [];
  if (!md.length) return null;
  // Prefer the session on OUR player — the house has other clients, and seeking off the back of
  // someone else's playback would be a genuinely bad bug.
  let wanted: ClientTarget | null = null;
  try { wanted = await findClient(device); } catch { wanted = null; }
  const mine = md.find((m) => {
    const p = m.Player || {};
    if (!wanted) return true;
    return (wanted.machineIdentifier && p.machineIdentifier === wanted.machineIdentifier)
      || (wanted.name && p.title === wanted.name);
  });
  const m = mine || (wanted ? null : md[0]);
  if (!m) return null;
  return { ratingKey: String(m.ratingKey), viewOffset: Number(m.viewOffset || 0) };
}

// --- the post-play account audit --------------------------------------------------------- //
//
// The ONE fact this system could never read back: which Plex Home profile the Shield is
// signed into. `profiles.waitForProfile()` infers it from a PMS DEBUG line keyed on
// SHIELD_IP; `adb.selectedProfile()` only reports which picker TILE is highlighted, and the
// picker is gone the moment it matters. So `adb.switchTo()` reports success on the CENTER
// keypress and the gate has always taken that on trust.
//
// Once something is PLAYING there is a direct answer. `/status/sessions` stamps every live
// session with the `User` whose token owns it — and that account IS the one Plex will
// scrobble to, which is the only definition of "the right profile" that ever mattered.
//
// This is why it is a POST-play audit and not a pre-play gate: before playMedia there is no
// session to read. Play, then immediately confirm, then stop if it was wrong.
// (docs/decisions/2026-08-21-the-profile-gate-verifies-the-account-plex-is-playing-as.md)

/**
 * Who is Plex playing as on our client? `expectAccountId` is the bound account
 * (`binding.account_id`); null means the caller has nothing to compare and this abstains.
 *
 * Polls, because a session does not appear the instant Companion answers 200 — the client
 * still has to open the stream. Bounded by `timeoutMs`; abstains rather than fails on
 * timeout.
 */
export async function verifyAccount(
  expectAccountId: number | null | undefined,
  {
    device = null,
    timeoutMs = 12_000,
    pollMs = 1_000,
  }: { device?: Device | null; timeoutMs?: number; pollMs?: number } = {},
): Promise<AccountVerdict> {
  if (expectAccountId == null) {
    return { isMismatch: false, accountId: null, title: null, reason: 'no bound account to check' };
  }
  let wanted: ClientTarget | null = null;
  try { wanted = await findClient(device); } catch { wanted = null; }

  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastReason = 'no session appeared on the target client';
  for (;;) {
    let data: PlexReqJson;
    try {
      // ADMIN token, for the same reason currentSession() uses it, and here the reason is
      // sharper: /status/sessions returns an EMPTY container to a managed user, so asking as
      // Younger Kids could never reveal that the Shield is playing as the owner — which is
      // the entire question this function exists to answer.
      data = await plexReq('GET', '/status/sessions', { token: PLEX_TOKEN });
    } catch (e) {
      lastReason = `/status/sessions unreadable: ${errMessage(e)}`;
      data = {};
    }
    const md = (data && data.MediaContainer && data.MediaContainer.Metadata) || [];
    const mine = md.find((m) => {
      const pl = m.Player || {};
      if (!wanted) return true;
      return (wanted.machineIdentifier && pl.machineIdentifier === wanted.machineIdentifier)
        || (wanted.name && pl.title === wanted.name);
    });
    if (mine) {
      const row = mine as typeof mine & { User?: { id?: unknown; title?: unknown } };
      const parsed = parseInt(String(row.User?.id), 10);
      const accountId = Number.isFinite(parsed) ? parsed : null;
      const title = row.User?.title != null ? String(row.User.title) : null;
      if (accountId == null) {
        return { isMismatch: false, accountId: null, title, reason: 'session carries no User id' };
      }
      return { isMismatch: accountId !== Number(expectAccountId), accountId, title };
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.max(0.05, pollMs / 1000));
  }
  return { isMismatch: false, accountId: null, title: null, reason: lastReason };
}

/**
 * Stop playback on the target client. Used ONLY to abort a play that landed on the wrong
 * account — the one case where destroying playback is the correct outcome, because letting
 * it run writes somebody else's watch history.
 */
/**
 * One Companion transport verb against the target client.
 *
 * `stop`, `pause`, `play` and `skipNext` are the same GET with a different last path
 * segment, so they share this. `seekTo()` deliberately does NOT: it needs the server's
 * machineIdentifier and the BINDING's play token, because a seek is addressed to the
 * playQueue rather than to the player.
 *
 * Admin token, matching what the stop path has always sent. Companion routes by target
 * client identifier, not by who owns the session, so the admin token controls a managed
 * user's player — which is the whole point when a kids' queue is on screen.
 */
async function playerCommand(
  verb: 'stop' | 'pause' | 'play' | 'skipNext',
  device: Device | null = null,
): Promise<{ ok: boolean; error?: string }> {
  const client = await findClient(device);
  if (!client) return { ok: false, error: 'target client not found' };
  const params = new URLSearchParams({
    type: 'video',
    'X-Plex-Target-Client-Identifier': client.machineIdentifier || '',
    'X-Plex-Client-Identifier': CLIENT_ID,
    commandID: '1',
  });
  try {
    // Companion answers 200 with a "Failure: 200 OK" body even on success — status only,
    // exactly as seekTo() notes.
    await plexReq('GET', `/player/playback/${verb}?${params}`, {
      token: PLEX_TOKEN, host: client.uri || null,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

export async function stopPlayback(device: Device | null = null): Promise<boolean> {
  const r = await playerCommand('stop', device);
  if (!r.ok && r.error) console.log(`[playback] stop failed: ${r.error}`);
  return r.ok;
}

/**
 * Transport control from the web app's Now-playing bar.
 *
 * Returns the failure reason rather than a bare false, because unlike `stopPlayback()` —
 * whose only caller is the wrong-account kill, where nobody is watching — a human just
 * pressed this button and is owed a sentence when it does not work.
 *
 * Deliberately NOT the driver's retry loop. `drivePlay()` re-opens Plex and retries because
 * it is starting a session from an unknown state, possibly against a sleeping Shield. These
 * verbs only make sense while something is already on screen, so Plex is foreground and
 * Companion is up; a refusal here is real news, not a state to grind through.
 */
export async function transport(
  action: 'stop' | 'pause' | 'resume' | 'next',
  device: Device | null = null,
): Promise<{ ok: boolean; error?: string }> {
  // `resume` is Companion's `play`. The app's vocabulary is pause/resume because the bar
  // shows one toggle; Plex's is pause/play. Translate here, once.
  const verb = action === 'resume' ? 'play' : action === 'next' ? 'skipNext' : action;
  const r = await playerCommand(verb, device);
  if (!r.ok) console.log(`[playback] ${action} failed: ${r.error}`);
  return r;
}

// Seek the target player to `offsetMs` via Companion. Same transport as playMedia.
//
// Why this exists: a Plex playQueue carries NO per-item resume point, and playMedia's `offset`
// applies only to the item it starts on. So every episode after the first restarts at 0:00 no
// matter what progress it has — verified on the Shield 2026-08-11 (an episode with a 3m09s
// marker began at 0:09). Seeking after the advance is the only way to honour the rest.
export async function seekTo(
  offsetMs: number | string | null | undefined,
  {
    device = null,
    setName = null,
    userUuid = null,
  }: { device?: Device | null; setName?: string | null; userUuid?: string | null } = {},
): Promise<SeekResult> {
  const ms = intOffset(offsetMs);
  if (!(ms > 0)) return { seeked: false, error: 'nothing to seek to' };
  const client = await findClient(device);
  if (!client) return { seeked: false, error: 'target client not found' };
  const params = new URLSearchParams({
    offset: String(ms),
    type: 'video',
    machineIdentifier: await machineIdentifier(),
    'X-Plex-Target-Client-Identifier': client.machineIdentifier || '',
    'X-Plex-Client-Identifier': CLIENT_ID,
    commandID: '1',
  });
  try {
    // Companion answers 200 with a "Failure: 200 OK" body even on success — status only.
    await plexReq('GET', `/player/playback/seekTo?${params}`, {
      token: await playToken(setName, userUuid), host: client.uri || null,
    });
    return { seeked: true, offset: ms };
  } catch (e) {
    return { seeked: false, error: errMessage(e) };
  }
}

export async function playRatingKeys(ratingKeys: (string | number)[] | null | undefined, {
  setName = null,
  device = null,
  offset = 0,
  userUuid = null,
}: {
  setName?: string | null;
  device?: Device | null;
  offset?: number | string | null;
  userUuid?: string | null;
} = {}): Promise<PlaybackResult> {
  // Only the two knobs this path reads off the set. `getSet()` is still JS, so the wider
  // `SetRegistryEntry` it really returns is not visible here yet.
  let cfg: { audio_language?: string | null; max_items?: number | null } = {};
  if (setName) {
    try { cfg = (await getSet(setName)) || {}; } catch { cfg = {}; }
  }

  const lang = cfg.audio_language;
  if (lang) {
    try {
      await applyAudioLanguage(ratingKeys, await playToken(setName, userUuid), lang);
    } catch (e) {
      // Never let audio prefs block playback.
      console.log(`[audio] language '${lang}' not applied: ${errMessage(e)}`);
    }
  }

  const mode = (device && device.mode) || PLAYBACK_MODE;
  if (mode === 'cast') {
    return castPlay(ratingKeys, setName, device && device.name, offset);
  }

  const result: PlaybackResult = {
    queued: (ratingKeys || []).length,
    played: false,
    mode: 'client',
    client: null,
  };
  if (!ratingKeys || !ratingKeys.length) {
    result.error = 'nothing to play';
    return result;
  }

  const tok = await playToken(setName, userUuid);
  const client = await findClient(device);
  // A per-scan cap (max_items) means "play exactly these and stop": drop continuous so the
  // client doesn't auto-advance into related content once the queue ends.
  const cap = cfg.max_items;
  const isCapped = typeof cap === 'number' && Number.isInteger(cap) && cap > 0;
  let pqId: number | string | null = null;
  try {
    pqId = await createPlayQueue(ratingKeys, { token: tok, continuous: !isCapped });
  } catch (e) {
    result.error = `${errName(e)}: ${errMessage(e)}`;
    return result;
  }
  result.playQueueID = pqId;

  if (!client) {
    result.error = "target Shield not listed as a player (is its Plex app installed/signed in?)";
    return result;
  }
  result.client = client.name || null;

  let srv: URL;
  try {
    srv = new URL(PLEX_LOCAL_URL);
  } catch {
    result.error = `invalid PLEX_LOCAL_URL: ${PLEX_LOCAL_URL}`;
    return result;
  }
  const first = ratingKeys[0];
  const mid = await machineIdentifier();
  const params = new URLSearchParams({
    key: `/library/metadata/${first}`,
    // Resume point (ms) for the first item — 0 plays from the top.
    offset: String(intOffset(offset)),
    machineIdentifier: mid,
    // Where the Shield should stream FROM — it can't infer this when we bypass the
    // server's relay, so hand it the LAN address explicitly.
    address: srv.hostname,
    port: String(srv.port || (srv.protocol === 'https:' ? 443 : 32400)),
    protocol: srv.protocol.replace(/:$/, ''),
    containerKey: `/playQueues/${pqId}`,
    token: tok,
    'X-Plex-Target-Client-Identifier': client.machineIdentifier || '',
    'X-Plex-Client-Identifier': CLIENT_ID,
    commandID: '1',
  });

  // Companion host: prefer the direct uri; fall back to Plex server relay if missing
  // (rare — Shield never appears on /clients, so uri is the real path).
  const host = client.uri || null;
  try {
    // Companion answers 200 with body "Failure: 200 OK" even when playback DOES start —
    // the body is not a usable success signal; only the HTTP status is.
    await plexReq('GET', `/player/playback/playMedia?${params}`, {
      token: tok,
      host,
      extraHeaders: {
        'X-Plex-Device-Name': 'queuepilot',
        'X-Plex-Product': 'queuepilot',
        'X-Plex-Version': '1.0',
      },
      timeoutMs: 30_000,
    });
    result.played = true;
  } catch (e) {
    if (isPlexError(e) && e.plexStatus) {
      result.error = `playMedia HTTP ${e.plexStatus}`;
    } else {
      // Preserve ECONNREFUSED / "connection refused" wording so driver._isConnRefused matches.
      // NOTE the two different `code`s in play here: this one is Node's STRING errno off a
      // socket failure, not the numeric HTTP mirror PlexError carries. See errors.ts.
      const msg = errMessage(e);
      const code = isNodeError(e)
        ? (e.code || (e.cause as { code?: string } | undefined)?.code)
        : undefined;
      const name = errName(e);
      result.error = code
        ? `${name}: ${msg} (${code})`
        : `${name}: ${msg}`;
    }
  }
  return result;
}

// Convenience re-export shape for tests that want the Python-ish names as an object.
export const _internals = {
  playToken,
  applyAudioLanguage,
  plexReq,
  sleep,
};
