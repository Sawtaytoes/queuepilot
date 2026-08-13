// MQTT bridge for the web app — the Node process is just another broker client, exactly
// like the HA scanner (the AGENTS.md rule: services talk over MQTT, no new REST/shell
// bridges). It consumes the retained device registry + state that mqttd publishes and sends
// session-start commands ("Play on <device>") back to it. Rotation previews are NOT here:
// they are computed in-process by the engine (server.js /api/generic/:id/preview).
import { connect } from 'mqtt';
// These come from env.js rather than process.env: this module used to re-declare the same
// four knobs with its own copies of the defaults, which is the exact drift env.js exists to
// prevent — during the queuepilot rename those copies would have kept this half of the
// process on `plex-channels/…` while mqttd moved, and the web UI's device list and state
// feed would have gone quiet with nothing logged.
import {
  MQTT_HOST as HOST, MQTT_PORT as PORT, MQTT_USER as USER, MQTT_PASS as PASS,
  T_CMD_START, T_DEVICES_BASE, T_STATE, T_NOW_PLAYING,
  bothTopics, canonicalTopic,
} from './env.js';

export const connected = () => Boolean(client && client.connected);

const DEVICES = new Map(); // id -> announcement payload (retained registry)
let LAST_STATE = null; // last retained queuepilot/state payload
let LAST_NOW = null; // last retained queuepilot/now-playing payload

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
    // T_NOW_PLAYING is LIVE playback, bridged onto MQTT by the HA automation "Queuepilot Now
    // Playing" from the Plex integration's media_player (already push-fed by the PMS
    // websocket, so nothing here polls). T_STATE only says what a session STARTED with; this
    // says what is on screen NOW, and keeps up as the queue auto-advances.
    //
    // Only now-playing needs the legacy twin during the rename. devices and state are
    // published by mqttd in THIS process, so both halves move prefix on the same deploy —
    // subscribing to their old twins as well would just deliver every message twice and
    // double the SSE traffic to the UI. now-playing is different: HA publishes it, so it
    // arrives on whichever prefix that automation has been migrated to, and listening on
    // only one prefix would blank the UI's now-playing row until HA caught up.
    client.subscribe([
      `${T_DEVICES_BASE}/#`,
      T_STATE,
      ...bothTopics(T_NOW_PLAYING),
    ]);
  });
  client.on('error', (e) => console.log(`[mqtt] ${e.message}`));
  client.on('message', (rawTopic, buf) => {
    const text = buf.toString();
    const topic = canonicalTopic(rawTopic);
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
// mqttd resolves it via routing.bindingFor; omitted = the default binding.
export function play(setId, kind, target, profile) {
  if (!connected()) throw new Error('MQTT not connected');
  const payload = { set: setId, kind: kind || 'movie' };
  if (target) payload.target = target;
  if (profile) payload.profile = profile;
  client.publish(T_CMD_START, JSON.stringify(payload), { qos: 1 });
  return payload;
}

