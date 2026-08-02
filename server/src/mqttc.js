// MQTT bridge for the web app — the Node process is just another broker client, exactly
// like the HA scanner (the AGENTS.md rule: services talk over MQTT, no new REST/shell
// bridges). It consumes the Python service's retained device registry + state, publishes
// session-start commands ("Play on <device>"), and does request/response for the
// Channels-view rotation previews. Mirrors queue_builder/service.main's connection
// settings so the one TrueNAS app env feeds both processes.
import { connect } from 'mqtt';
import { randomUUID } from 'node:crypto';

const HOST = process.env.MQTT_HOST || '';
const PORT = parseInt(process.env.MQTT_PORT || '1883', 10);
const USER = process.env.MQTT_USER || undefined;
const PASS = process.env.MQTT_PASS || undefined;

const T_CMD_START = process.env.T_CMD_START || 'plex-channels/cmd/session/start';
const T_CMD_PREVIEW = process.env.T_CMD_PREVIEW || 'plex-channels/cmd/generic/preview';
const T_RESP_PREVIEW_BASE = process.env.T_RESP_PREVIEW_BASE || 'plex-channels/resp/preview';
const T_DEVICES_BASE = process.env.T_DEVICES_BASE || 'plex-channels/devices';
const T_STATE = process.env.T_STATE || 'plex-channels/state';
// LIVE playback, bridged onto MQTT by the HA automation "Plex Channels Now Playing" from
// the Plex integration's media_player (which is already push-fed by the PMS websocket — so
// nothing here polls). T_STATE only says what a session STARTED with; this says what is on
// screen NOW, and keeps up as the queue auto-advances.
const T_NOW_PLAYING = process.env.T_NOW_PLAYING || 'plex-channels/now-playing';

export const connected = () => Boolean(client && client.connected);

const DEVICES = new Map(); // id -> announcement payload (retained registry)
let LAST_STATE = null; // last retained plex-channels/state payload
let LAST_NOW = null; // last retained plex-channels/now-playing payload
const pendingPreviews = new Map(); // reply topic -> resolve()

let client = null;
if (HOST) {
  client = connect({
    host: HOST,
    port: PORT,
    protocol: PORT === 8883 ? 'mqtts' : 'mqtt', // LE-certed broker; system CAs verify
    username: USER,
    password: PASS,
    reconnectPeriod: 5000,
  });
  client.on('connect', () => {
    console.log(`[mqtt] web connected to ${HOST}:${PORT}`);
    client.subscribe([`${T_DEVICES_BASE}/#`, T_STATE, T_NOW_PLAYING, `${T_RESP_PREVIEW_BASE}/#`]);
  });
  client.on('error', (e) => console.log(`[mqtt] ${e.message}`));
  client.on('message', (topic, buf) => {
    const text = buf.toString();
    if (topic.startsWith(`${T_DEVICES_BASE}/`)) {
      const id = topic.slice(T_DEVICES_BASE.length + 1);
      if (!text) DEVICES.delete(id); // cleared retained topic = de-registered
      else {
        try { DEVICES.set(id, JSON.parse(text)); } catch { /* ignore junk */ }
      }
      return;
    }
    if (topic === T_STATE) {
      try { LAST_STATE = JSON.parse(text); } catch { /* ignore */ }
      stateListeners.forEach((fn) => fn(LAST_STATE));
      return;
    }
    if (topic === T_NOW_PLAYING) {
      // A cleared retained topic means "nothing playing" — distinct from junk, which we drop.
      if (!text) LAST_NOW = null;
      else {
        try { LAST_NOW = JSON.parse(text); } catch { return; }
      }
      nowListeners.forEach((fn) => fn(LAST_NOW));
      return;
    }
    const resolve = pendingPreviews.get(topic);
    if (resolve) {
      pendingPreviews.delete(topic);
      try { resolve(JSON.parse(text)); } catch (e) { resolve({ error: String(e) }); }
    }
  });
}

const stateListeners = new Set();
export const onState = (fn) => stateListeners.add(fn);

const nowListeners = new Set();
export const onNowPlaying = (fn) => nowListeners.add(fn);

export function devices() {
  // Default first, then by name — the dropdown's order.
  return [...DEVICES.values()].sort(
    (a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)) || String(a.name).localeCompare(String(b.name)),
  );
}

export const lastState = () => LAST_STATE;
export const lastNowPlaying = () => LAST_NOW;

// Publish a session start ("Play on <device>"). target omitted -> the default Shield.
// `profile` (PR 4) names the binding to play under on a profiles[] function channel —
// the Python service resolves it via config.binding_for; omitted = the default binding.
export function play(setId, kind, target, profile) {
  if (!connected()) throw new Error('MQTT not connected');
  const payload = { set: setId, kind: kind || 'movie' };
  if (target) payload.target = target;
  if (profile) payload.profile = profile;
  client.publish(T_CMD_START, JSON.stringify(payload), { qos: 1 });
  return payload;
}

// Request/response: rotation-channel preview from the Python service. Cached briefly —
// the pool only moves when someone watches something. A profiles[] channel's pool is
// per-binding, so the cache keys on (set, profile).
const previewCache = new Map(); // `${set}|${profile}` -> {at, data}
const PREVIEW_TTL_MS = 5 * 60 * 1000;

export async function preview(setId, { fresh = false, profile = '' } = {}) {
  if (!connected()) throw new Error('MQTT not connected');
  const key = `${setId}|${profile || ''}`;
  const hit = previewCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < PREVIEW_TTL_MS) return hit.data;
  const reply = `${T_RESP_PREVIEW_BASE}/${randomUUID()}`;
  const req = { set: setId, reply };
  if (profile) req.profile = profile;
  const data = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPreviews.delete(reply);
      reject(new Error('preview timed out (is the queue service up?)'));
    }, 90000);
    pendingPreviews.set(reply, (d) => { clearTimeout(timer); resolve(d); });
    client.publish(T_CMD_PREVIEW, JSON.stringify(req), { qos: 1 });
  });
  if (!data.error) previewCache.set(key, { at: Date.now(), data });
  return data;
}

export const invalidatePreview = (setId) => {
  for (const k of [...previewCache.keys()]) if (k.startsWith(`${setId}|`)) previewCache.delete(k);
};
