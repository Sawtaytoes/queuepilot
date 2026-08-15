// MQTT bridge for the web app — the Node process is just another broker client, exactly
// like the HA scanner (the AGENTS.md rule: services talk over MQTT, no new REST/shell
// bridges). It consumes the retained device registry + state that mqttd publishes and sends
// session-start commands ("Play on <device>") back to it. Rotation previews are NOT here:
// they are computed in-process by the engine (server.js /api/generic/:id/preview).
import { connect, type MqttClient } from 'mqtt';
// These come from env.js rather than process.env: this module used to re-declare the same
// four knobs with its own copies of the defaults, which is the exact drift env.js exists to
// prevent — during the queuepilot rename those copies would have kept this half of the
// process on `plex-channels/…` while mqttd moved, and the web UI's device list and state
// feed would have gone quiet with nothing logged.
import {
  MQTT_HOST as HOST, MQTT_PORT as PORT, MQTT_USER as USER, MQTT_PASS as PASS,
  T_CMD_START, T_DEVICES_BASE, T_STATE, T_NOW_PLAYING,
} from './env.js';
import type { Device, NowPlaying, PublishedSessionState } from './types.js';

/**
 * What `play()` puts on the wire. Local (not in types.ts) because it is the OUTBOUND twin of
 * `SessionStartPayload` and deliberately narrower: this publisher only ever sends a device
 * REGISTRY ID as `target`, never a resolved Device — mqttd.js is what swaps the id for the
 * announced entry (see the latent-bug note on `SessionStartPayload`).
 */
interface StartCommand {
  set: string;
  kind: string;
  target?: string;
  profile?: string;
  /** An entry key — play THAT member of a curated set. Web-only; a card never sends it. */
  only?: string;
}

/** A device announcement as it comes back off the retained registry: unvalidated JSON, so
 * every field is optional even though `devices.js` always writes a full `Device`. */
type AnnouncedDevice = Partial<Device> & Record<string, unknown>;

type StateListener = (state: PublishedSessionState | null) => void;
type NowPlayingListener = (now: NowPlaying | null) => void;

export const connected = (): boolean => Boolean(client && client.connected);

const DEVICES = new Map<string, AnnouncedDevice>(); // id -> announcement payload (retained registry)
let LAST_STATE: PublishedSessionState | null = null; // last retained queuepilot/state payload
let LAST_NOW: NowPlaying | null = null; // last retained queuepilot/now-playing payload

/**
 * Off-the-wire JSON as a plain object, or null for "not an object".
 *
 * `JSON.parse` is `any`, and assigning that straight into a typed slot would be the one cast
 * that makes every field below a lie. Everything this module retains arrives unvalidated, so
 * it is checked for object-ness once, here, and the interfaces stay honest about the rest.
 */
function asRecord(text: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(text);
  return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
}

let client: MqttClient | null = null;
if (HOST) {
  // Bound to a const so the callbacks below keep the narrowing: `client` is a mutable
  // module-level `let`, so TS discards `!== null` inside a closure. Same object, same
  // IMPORT-TIME connect — tests that set MQTT_* before importing this module still connect
  // on import, which is the behaviour they depend on.
  const c = connect({
    host: HOST,
    port: PORT,
    protocol: PORT === 8883 ? 'mqtts' : 'mqtt', // LE-certed broker; system CAs verify
    username: USER,
    password: PASS,
    reconnectPeriod: 5000,
  });
  client = c;
  c.on('connect', () => {
    console.log(`[mqtt] web connected to ${HOST}:${PORT}`);
    // T_NOW_PLAYING is LIVE playback, bridged onto MQTT by the HA automation "Queuepilot Now
    // Playing" from the Plex integration's media_player (already push-fed by the PMS
    // websocket, so nothing here polls). T_STATE only says what a session STARTED with; this
    // says what is on screen NOW, and keeps up as the queue auto-advances.
    c.subscribe([
      `${T_DEVICES_BASE}/#`,
      T_STATE,
      T_NOW_PLAYING,
    ]);
  });
  c.on('error', (e) => console.log(`[mqtt] ${e.message}`));
  c.on('message', (topic, buf) => {
    const text = buf.toString();
    if (topic.startsWith(`${T_DEVICES_BASE}/`)) {
      const id = topic.slice(T_DEVICES_BASE.length + 1);
      if (!text) DEVICES.delete(id); // cleared retained topic = de-registered
      else {
        // A non-object payload (a bare number/string) is now DROPPED rather than stored as a
        // "device" — the one behaviour delta in this file's conversion, and unreachable from
        // the only publisher (devices.js announceDevices, which always sends an object).
        try {
          const row = asRecord(text);
          if (row) DEVICES.set(id, row as AnnouncedDevice);
        } catch { /* ignore junk */ }
      }
      return;
    }
    if (topic === T_STATE) {
      // Unlike now-playing this topic is published by mqttd in THIS process, so the shape is
      // the one publishState() writes — object-ness is still the only thing checked.
      try {
        const row = asRecord(text);
        if (row) LAST_STATE = row as unknown as PublishedSessionState;
      } catch { /* ignore */ }
      stateListeners.forEach((fn) => fn(LAST_STATE));
      return;
    }
    if (topic === T_NOW_PLAYING) {
      // A cleared retained topic means "nothing playing" — distinct from junk, which we drop.
      if (!text) LAST_NOW = null;
      else {
        try {
          const row = asRecord(text);
          if (row === null) return; // a non-object payload is junk, not "nothing playing"
          LAST_NOW = row as NowPlaying;
        } catch { return; }
      }
      nowListeners.forEach((fn) => fn(LAST_NOW));
    }
  });
}

const stateListeners = new Set<StateListener>();
export const onState = (fn: StateListener): Set<StateListener> => stateListeners.add(fn);

const nowListeners = new Set<NowPlayingListener>();
export const onNowPlaying = (fn: NowPlayingListener): Set<NowPlayingListener> => nowListeners.add(fn);

export function devices(): AnnouncedDevice[] {
  // Default first, then by name — the dropdown's order.
  return [...DEVICES.values()].sort(
    (a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)) || String(a.name).localeCompare(String(b.name)),
  );
}

export const lastState = (): PublishedSessionState | null => LAST_STATE;
export const lastNowPlaying = (): NowPlaying | null => LAST_NOW;

// Publish a session start ("Play on <device>"). target omitted -> the default Shield.
// `profile` (PR 4) names the binding to play under on a profiles[] function channel —
// mqttd resolves it via routing.bindingFor; omitted = the default binding.
// `only` is an entry key: play THAT member of a curated set instead of whatever the set
// would have chosen. Web-only — no physical card sends it.
export function play(
  setId: string,
  kind?: string | null,
  target?: string | null,
  profile?: string | null,
  only?: string | null,
): StartCommand {
  if (!connected()) throw new Error('MQTT not connected');
  const payload: StartCommand = { set: setId, kind: kind || 'movie' };
  if (target) payload.target = target;
  if (profile) payload.profile = profile;
  if (only) payload.only = only;
  // `connected()` just proved client is non-null; it is a module-level `let`, so say so.
  client!.publish(T_CMD_START, JSON.stringify(payload), { qos: 1 });
  return payload;
}

