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

const CLIENT_ID = PLEX_CLIENT_IDENTIFIER;

// Dedicated undici agent for Companion + playQueue POSTs. Companion is on the Shield
// (often plain HTTP, sometimes self-signed TLS if proxied); the Plex server cert is
// self-signed. Same rejectUnauthorized:false rule as plex.js.
const agent = new Agent({
  keepAliveTimeout: 30_000,
  connections: 8,
  connect: { rejectUnauthorized: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Companion readiness ----------------------------------------------------- //

// Is the Plex Companion endpoint (host:32500) accepting a TCP connection right now?
// playMedia lands on the client's Companion server; when Plex is closed or mid-navigation
// that port isn't listening and the GET fails with ECONNREFUSED, which used to kill the
// scan with nothing playing. The FSM (driver.js) probes this immediately before firing
// play so it can re-open Plex and retry instead. A cheap connect-and-drop — proves the
// port is up without sending a request.
export async function companionReady(host = null, port = null, timeout = null) {
  const h = host || SHIELD_IP;
  const p = Number(port || COMPANION_PORT);
  const t = timeout == null ? PLAYBACK_FSM_COMPANION_TIMEOUT : timeout;
  const timeoutMs = Math.max(50, Math.floor(Number(t) * 1000));
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (ok) => {
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

let _machineId = null;

// The server's machineIdentifier (needed to build playQueue URIs + playMedia params).
export async function machineIdentifier() {
  if (_machineId) return _machineId;
  try {
    const data = await plexGet('/');
    _machineId = (data && data.MediaContainer && data.MediaContainer.machineIdentifier) || '';
  } catch {
    _machineId = '';
  }
  return _machineId;
}

// Test seam: clear the cached machine id (unit tests / after a PMS rebuild).
export function _resetMachineIdentifier() {
  _machineId = null;
}

const _companionTarget = new Map(); // name|machineId -> {name, machineIdentifier, uri}

async function plextv(path, token = PLEX_TOKEN, method = 'GET') {
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
  return text ? JSON.parse(text) : {};
}

// Resolve a player's DIRECT Plex Companion endpoint (http://<ip>:32500) via plex.tv.
// The local server's /clients only lists GDM-discovered players, which never reaches the
// Shield here — so ask plex.tv and talk to the player directly. Cached per key.
export async function companionTarget(name, machineId = '') {
  const key = machineId || name || '';
  if (!key) return null;
  if (_companionTarget.has(key)) return _companionTarget.get(key);
  let devices;
  try {
    devices = await plextv('/api/v2/devices', PLEX_TOKEN);
  } catch {
    return null; // network/plex.tv hiccup: caller falls back
  }
  const rows = Array.isArray(devices) ? devices : devices.devices || [];
  for (const d of rows) {
    if (!String(d.provides || '').includes('player')) continue;
    if (machineId && d.clientIdentifier !== machineId) continue;
    if (!machineId && d.name !== name) continue;
    const uri = (d.connections || []).map((c) => c.uri).find(Boolean) || null;
    if (!uri) continue;
    const target = {
      name: d.name,
      machineIdentifier: d.clientIdentifier,
      uri,
    };
    _companionTarget.set(key, target);
    return target;
  }
  return null;
}

export function _resetCompanionTarget() {
  _companionTarget.clear();
}

// --- HTTP helpers ------------------------------------------------------------ //

async function playToken(setName = null) {
  // Token used to build/drive playback: the set's managed-user account token.
  // Falls back to admin only if the account token can't be minted.
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
async function plexReq(method, path, { token = null, host = null, extraHeaders = null, timeoutMs = 60_000 } = {}) {
  const base = (host || PLEX_URL).replace(/\/+$/, '');
  const url = base + path;
  const headers = {
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
    const err = new Error(`plex ${res.statusCode} for ${path}`);
    err.plexStatus = res.statusCode;
    err.code = res.statusCode;
    throw err;
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

// --- find client / create playQueue ------------------------------------------ //

// Return the target player as {name, machineIdentifier, uri}, or null.
// `device` (from the MQTT device registry, via a start command's `target`) overrides the
// env-default Shield. `uri` is the player's DIRECT Companion endpoint; commands go
// straight to it rather than being relayed by the server.
export async function findClient(device = null) {
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
    const mc = (await plexReq('GET', '/clients')).MediaContainer || {};
    const clients = mc.Server || mc.Device || [];
    const wantId = SHIELD_CLIENT_MACHINE_ID;
    const wantName = (SHIELD_CLIENT_NAME || '').toLowerCase();
    for (const c of clients) {
      if (
        (wantId && c.machineIdentifier === wantId)
        || (wantName && String(c.name || '').toLowerCase().includes(wantName))
      ) {
        return {
          name: c.name,
          machineIdentifier: c.machineIdentifier,
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
export async function createPlayQueue(ratingKeys, { token = null, continuous = true } = {}) {
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
  const mc = (data && data.MediaContainer) || {};
  return mc.playQueueID ?? null;
}

// --- audio language (best-effort, both paths) -------------------------------- //

// Select the `lang` audio stream on each queued item so it plays in that language
// (e.g. anime in Japanese, audio_language: "jpn"). Sets the SELECTED stream server-side
// under the set's account token — persists as that account's preference (acceptable:
// the account is the set's dedicated profile). Fully guarded.
async function applyAudioLanguage(ratingKeys, token, lang) {
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
export async function castPlay(ratingKeys, setName = null, castName = null, offset = 0) {
  const result = {
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
    await new Promise((resolve, reject) => {
      const c = mqtt.connect({
        host: MQTT_HOST,
        port: MQTT_PORT,
        protocol: MQTT_PORT === 8883 ? 'mqtts' : 'mqtt',
        username: MQTT_USER,
        password: MQTT_PASS,
        reconnectPeriod: 0,
        connectTimeout: 5000,
      });
      const fail = (e) => {
        try { c.end(true); } catch { /* ignore */ }
        reject(e);
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
      `cast_sidecar MQTT publish failed (${e && e.message ? e.message : e}). `
      + `Ensure cast_sidecar is subscribed to ${T_CMD_CAST_PLAY}, or use PLAYBACK_MODE=client.`
    );
    return result;
  }
}

function intOffset(offset) {
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
export async function currentSession({ device = null } = {}) {
  let data;
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
  let wanted = null;
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

// Seek the target player to `offsetMs` via Companion. Same transport as playMedia.
//
// Why this exists: a Plex playQueue carries NO per-item resume point, and playMedia's `offset`
// applies only to the item it starts on. So every episode after the first restarts at 0:00 no
// matter what progress it has — verified on the Shield 2026-08-11 (an episode with a 3m09s
// marker began at 0:09). Seeking after the advance is the only way to honour the rest.
export async function seekTo(offsetMs, { device = null, setName = null } = {}) {
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
      token: await playToken(setName), host: client.uri || null,
    });
    return { seeked: true, offset: ms };
  } catch (e) {
    return { seeked: false, error: e && e.message ? e.message : String(e) };
  }
}

export async function playRatingKeys(ratingKeys, {
  setName = null,
  device = null,
  offset = 0,
} = {}) {
  let cfg = {};
  if (setName) {
    try { cfg = (await getSet(setName)) || {}; } catch { cfg = {}; }
  }

  const lang = cfg.audio_language;
  if (lang) {
    try {
      await applyAudioLanguage(ratingKeys, await playToken(setName), lang);
    } catch (e) {
      // Never let audio prefs block playback.
      console.log(`[audio] language '${lang}' not applied: ${e && e.message ? e.message : e}`);
    }
  }

  const mode = (device && device.mode) || PLAYBACK_MODE;
  if (mode === 'cast') {
    return castPlay(ratingKeys, setName, device && device.name, offset);
  }

  const result = {
    queued: (ratingKeys || []).length,
    played: false,
    mode: 'client',
    client: null,
  };
  if (!ratingKeys || !ratingKeys.length) {
    result.error = 'nothing to play';
    return result;
  }

  const tok = await playToken(setName);
  const client = await findClient(device);
  // A per-scan cap (max_items) means "play exactly these and stop": drop continuous so the
  // client doesn't auto-advance into related content once the queue ends.
  const cap = cfg.max_items;
  const isCapped = Number.isInteger(cap) && cap > 0;
  let pqId = null;
  try {
    pqId = await createPlayQueue(ratingKeys, { token: tok, continuous: !isCapped });
  } catch (e) {
    result.error = `${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}`;
    return result;
  }
  result.playQueueID = pqId;

  if (!client) {
    result.error = "target Shield not listed as a player (is its Plex app installed/signed in?)";
    return result;
  }
  result.client = client.name || null;

  let srv;
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
    if (e && e.plexStatus) {
      result.error = `playMedia HTTP ${e.plexStatus}`;
    } else {
      // Preserve ECONNREFUSED / "connection refused" wording so driver._isConnRefused matches.
      const msg = e && e.message ? e.message : String(e);
      const code = e && (e.code || e.cause?.code);
      const name = e && e.name ? e.name : 'Error';
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
