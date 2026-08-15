// The MQTT service — session start/advance/preview/devices/discovery/state. Sole owner of
// these topics since the Python service was deleted (2026-08-12); cast play is delegated to
// cast_sidecar. HA and the web UI talk MQTT exactly as before.
import { connect, type IClientPublishOptions, type MqttClient } from 'mqtt';
import { randomUUID } from 'node:crypto';
import * as session from './session.js';
import * as enginePreview from './engine/preview.js';
import * as engineRouting from './engine/routing.js';
import * as adb from './adb.js';
import * as devices from './devices.js';
import {
  MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASS,
  T_CMD_START, T_CMD_ADVANCE, T_CMD_SOUNDTRACK, T_CMD_PREVIEW,
  T_RESP_PREVIEW_BASE, T_RESP_LAST_PLAYED, T_RESP_SOUNDTRACK, T_STATE,
  T_DISCOVERY_BASE, DISCOVERY_OBJECT_ID,
  DEVICE_ANNOUNCE_SECONDS,
} from './env.js';
import { errMessage, isNodeError } from './errors.js';
import type {
  Device, PublishedSessionState, SessionStartPayload,
} from './types.js';

/**
 * The publish primitive every helper below uses, and what `devices.announceDevices()` is
 * handed. Named locally because it is this file's own seam (devices.js takes it as a
 * parameter), not a domain shape.
 */
type Publish = (topic: string, payload: unknown, opts?: { qos?: 0 | 1 | 2; retain?: boolean }) => void;

/** The `extra` half of `publishState()` — every key any caller passes, i.e. everything on
 * `PublishedSessionState` that `asDict()` does not already supply. `boot` is this file's
 * own (the connect handler stamps it) and is the only key not declared in types.ts. */
type StateExtra = Partial<Omit<PublishedSessionState, 'engine'>> & { boot?: boolean };

/** `queuepilot/cmd/generic/preview` payload. Untrusted: `reply` is attacker-controlled and
 * is validated against the preview base below. */
interface PreviewPayload {
  set?: unknown;
  reply?: unknown;
  profile?: unknown;
}

/**
 * What `engine/preview.js previewRotation()` hands back, as far as THIS file is concerned:
 * a JSON body to republish, with a `routing` block bolted on afterwards. Local and loose on
 * purpose — mqttd only reads `buckets.length` for its log line and never inspects the rest,
 * and the preview shape belongs to engine/preview.js, not here.
 */
interface PreviewData {
  buckets?: unknown[];
  routing?: unknown;
  [field: string]: unknown;
}

/** `queuepilot/cmd/soundtrack/resolve` payload — the retired resolver's, kept so the answer
 * can echo the requested title. */
interface SoundtrackPayload {
  title?: string | null;
}

let client: MqttClient | null = null;
let announceTimer: NodeJS.Timeout | null = null;

// The one place anything in this file reaches the broker: JSON-encodes non-string payloads,
// defaults to qos 1, and drops the message when the client is not connected.
const pub: Publish = (topic, payload, opts = {}) => {
  const c = client;
  if (!c?.connected) return;
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const settings: IClientPublishOptions = { qos: opts.qos ?? 1, retain: Boolean(opts.retain) };
  c.publish(topic, body, settings);
};

function publishState(extra: StateExtra = {}): void {
  const state: PublishedSessionState & { boot?: boolean } = {
    ...session.SESSION.asDict(), ...extra, engine: 'node',
  };
  pub(T_STATE, state, { retain: true });
}

function publishLastPlayed(item: session.LastPlayed | null): void {
  if (!item) return;
  pub(T_RESP_LAST_PLAYED, item, { retain: true });
}

session.setPublishers({ state: publishState, lastPlayed: publishLastPlayed });

async function handleStart(payload: SessionStartPayload): Promise<void> {
  // `target` comes off the wire as a device-registry ID (the web UI's "Play on ▾" publishes
  // `d.id`), but session/playback want the announced ENTRY — they read `.uri`, `.mode` and
  // `.name` off it. Resolve it against the registry we announce, as the deleted Python
  // service did; an unknown or aged-out id falls back to the env-default Shield rather than
  // failing the scan. Without this a swept device could be listed and picked but never
  // played: playback saw a bare string whose `.uri`/`.name` were undefined.
  if (payload && typeof payload.target === 'string' && payload.target) {
    const device = devices.known(payload.target) as Device | null;
    if (!device) console.log(`[mqttd] unknown target '${payload.target}' — using the default device`);
    payload = { ...payload, target: device };
  }
  const { target } = payload;
  console.log('[mqttd] session/start', JSON.stringify({
    set: payload.set,
    kind: payload.kind,
    profile: payload.profile,
    // `target?.id || target` in the original: a Device logs its id, and anything else (a
    // string id this handler could not resolve) logs itself.
    target: target && typeof target === 'object' ? target.id : target,
  }));
  try {
    await session.startSession(payload);
  } catch (e) {
    console.log(`[mqttd] start failed: ${(isNodeError(e) && e.stack) || errMessage(e)}`);
    publishState({ error: errMessage(e) });
  }
}

async function handleAdvance(): Promise<void> {
  try {
    await session.advanceSession();
  } catch (e) {
    publishState({ error: errMessage(e) });
  }
}

async function handlePreview(payload: PreviewPayload): Promise<void> {
  const setName = String(payload.set || '');
  const reply = String(payload.reply || '');
  const profile = String(payload.profile || '') || '';
  // The reply topic is attacker-controlled input, so it stays confined to the preview base.
  if (!reply.startsWith(T_RESP_PREVIEW_BASE)) {
    console.log(`[mqttd] refused preview reply ${reply}`);
    return;
  }
  try {
    const data = await enginePreview.previewRotation(setName, profile) as PreviewData;
    try { data.routing = engineRouting.forSet(setName, profile); } catch { /* ignore */ }
    pub(reply, data);
    console.log(`[mqttd] preview ${setName}: ${(data.buckets || []).length} buckets`);
  } catch (e) {
    pub(reply, { set: setName, error: errMessage(e) });
  }
}

function handleSoundtrack(payload: SoundtrackPayload | null | undefined): void {
  // The soundtrack resolver (MA → YouTube-Music → Ollama) was Python-only and went with it on
  // 2026-08-12; no live automation published to this topic. Answer clearly so HA never hangs.
  pub(T_RESP_SOUNDTRACK, {
    command_string: null,
    tier: null,
    query: payload?.title || null,
    error: 'soundtrack resolver is retired (it was Python-only, and unused)',
  });
}

// The registry round lives in devices.js (Shield + the plex.tv player sweep, with
// de-registration). It never rejects, but keep the .catch() anyway: an unhandled rejection
// inside setInterval would take the announcer down silently, and a dead announcer looks
// exactly like the ghost registry we just fixed.
function announceDevices(): void {
  devices.announceDevices(pub).catch((e: unknown) => console.log(`[devices] ${errMessage(e)}`));
}

function publishDiscovery(): void {
  const topic = `${T_DISCOVERY_BASE}/sensor/${DISCOVERY_OBJECT_ID}/config`;
  const cfg = {
    name: 'Status',
    unique_id: DISCOVERY_OBJECT_ID,
    object_id: DISCOVERY_OBJECT_ID,
    state_topic: T_STATE,
    value_template: (
      '{% if value_json.error %}error'
      + '{% elif value_json.awaiting %}waiting'
      + '{% elif value_json.playback %}playing'
      + '{% else %}idle{% endif %}'
    ),
    json_attributes_topic: T_STATE,
    icon: 'mdi:plex',
    device: {
      identifiers: ['queuepilot'],
      name: 'QueuePilot',
      manufacturer: 'queuepilot',
      model: 'Media queue controller',
    },
  };
  pub(topic, cfg, { retain: true });
  console.log(`[mqttd] published discovery for ${DISCOVERY_OBJECT_ID}`);
}

export function start(): MqttClient | null {
  if (!MQTT_HOST) {
    console.log('[mqttd] MQTT_HOST unset — Node playback service not started');
    return null;
  }
  // Bound to a const as well as to `client`, so the handlers below keep the narrowing that a
  // module-level `let` loses inside a closure. Same client object either way.
  const c = connect({
    host: MQTT_HOST,
    port: MQTT_PORT,
    protocol: MQTT_PORT === 8883 ? 'mqtts' : 'mqtt',
    username: MQTT_USER,
    password: MQTT_PASS,
    reconnectPeriod: 5000,
    clientId: `queuepilot-node-${randomUUID().slice(0, 8)}`,
  });
  client = c;
  c.on('connect', () => {
    console.log(`[mqttd] connected ${MQTT_HOST}:${MQTT_PORT}`);
    c.subscribe([T_CMD_START, T_CMD_ADVANCE, T_CMD_SOUNDTRACK, T_CMD_PREVIEW]);
    announceDevices();
    publishDiscovery();
    publishState({ boot: true });
    if (announceTimer) clearInterval(announceTimer);
    announceTimer = setInterval(announceDevices, Math.max(30, DEVICE_ANNOUNCE_SECONDS) * 1000);
  });
  c.on('error', (e) => console.log(`[mqttd] ${e.message}`));
  c.on('message', (topic, buf) => {
    // One parse for four command topics, so it stays `unknown` here and each handler declares
    // the shape it reads. A non-object body (or junk) reads as `{}`, exactly as before.
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(buf.toString() || '{}');
      payload = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch { payload = {}; }
    if (topic === T_CMD_START) {
      // fire-and-forget async
      void handleStart(payload as SessionStartPayload);
      return;
    }
    if (topic === T_CMD_ADVANCE) {
      void handleAdvance();
      return;
    }
    if (topic === T_CMD_PREVIEW) {
      void handlePreview(payload as PreviewPayload);
      return;
    }
    if (topic === T_CMD_SOUNDTRACK) {
      handleSoundtrack(payload as SoundtrackPayload);
    }
  });
  return client;
}

export function stop(): void {
  if (announceTimer) clearInterval(announceTimer);
  if (client) client.end(true);
  client = null;
}

void adb; // reserved for future device-health sampling on announce
