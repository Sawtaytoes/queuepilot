// Fake MQTT for the local dev harness — stands in for the real Mosquitto broker + the app's
// own MQTT service (mqttd), which are NOT reachable from the sandbox. It lets the
// offline web UI render everything that needs MQTT: the #/channels preview pools, the
// "Play on ▾" device menu, and play-result toasts.
//
// It is a TINY aedes broker (e2e/broker/node_modules — run `npm install` there once) plus a
// mock responder client that speaks the EXACT topics/payloads the service does
// (see server/src/mqttd.js + server/src/mqttc.js):
//   * announces two RETAINED devices/<id> entries  (plex-channels/devices/#)
//   * answers cmd/generic/preview on its reply topic with a small canned pool
//   * acks   cmd/session/start by publishing a retained plex-channels/state
//
// The canned pool uses REAL ratingKeys from the live Plex server so posters resolve through
// the Node /api/thumb proxy. Run standalone or import startFakeMqtt() from a harness script.
import { createRequire } from 'node:module';
import net from 'node:net';

const requireBroker = createRequire('/mnt/TrueNAS-Apps/Repos/plex-channels/e2e/broker/node_modules/');
const requireClient = createRequire('/mnt/TrueNAS-Apps/Repos/plex-channels/server/node_modules/');
const Aedes = requireBroker('aedes');
const mqtt = requireClient('mqtt');

const PORT = parseInt(process.env.FAKE_MQTT_PORT || '11883', 10);

const T_CMD_START = 'plex-channels/cmd/session/start';
const T_CMD_PREVIEW = 'plex-channels/cmd/generic/preview';
const T_RESP_PREVIEW_BASE = 'plex-channels/resp/preview';
const T_DEVICES_BASE = 'plex-channels/devices';
const T_STATE = 'plex-channels/state';
// Stands in for the HA automation "Plex Channels Now Playing", which bridges the Shield's
// Plex media_player onto this topic (see server/src/mqttc.js).
const T_NOW_PLAYING = 'plex-channels/now-playing';

// Two devices, mirroring the Python announcer: the env-default Shield (default:true) plus a
// second client-mode player, so the "Play on ▾" menu shows a real choice.
const DEVICES = {
  shield: { id: 'shield', name: 'Shield (Theater)', machineIdentifier: 'shield-machine-id',
    uri: null, mode: 'cast', default: true },
  bedroom: { id: 'bedroom', name: 'Bedroom Apple TV', machineIdentifier: 'atv-bedroom-id',
    uri: 'https://192.0.2.42:32500', mode: 'client', default: false },
};

// Canned rotation preview — REAL ratingKeys (Shows=5, Shorts=15, Movies=1) so posters load.
const SHOWS_BUCKETS = [
  { show: 'Alphablocks', ratingKey: '190990', unwatched: 7,
    next: { ratingKey: '190990', title: 'The Wand', season: 2, episode: 3 } },
  { show: 'Babar', ratingKey: '105964', unwatched: 12,
    next: { ratingKey: '105964', title: 'Babar and Father Christmas', season: 1, episode: 5 } },
  { show: 'Bananya', ratingKey: '360420', unwatched: 4,
    next: { ratingKey: '360420', title: 'Bananya Wants to Play', season: 1, episode: 2 } },
  { show: 'Barney and Friends', ratingKey: '106575', unwatched: 9,
    next: { ratingKey: '106575', title: 'Playing It Safe', season: 3, episode: 1 } },
  { show: 'Around the World in 80 Days', ratingKey: '226337', unwatched: 6,
    next: { ratingKey: '226337', title: 'Off We Go', season: 1, episode: 1 } },
  // A "section shorts" bucket (ratingKey starts with 'section-'). Shorts are standalone
  // items, so the bucket carries `items` and the UI renders ONE TILE EACH (a show bucket
  // stays collapsed behind `next`). `unwatched` still counts the whole pile.
  { show: 'Shorts',
    ratingKey: 'section-15',
    unwatched: 24,
    next: { ratingKey: '269283', title: '8 Ball Bunny', season: null, episode: null },
    items: [
      { ratingKey: '269283', title: '8 Ball Bunny' },
      { ratingKey: '232642', title: 'A Corny Concerto' },
      { ratingKey: '269285', title: 'Baby Buggy Bunny' },
      { ratingKey: '199105', title: 'Trail Mix-Up' },
      { ratingKey: '199106', title: 'Tummy Trouble' },
    ] },
];
const MOVIE_POOL = [
  { ratingKey: '456942', title: '5 Centimeters per Second (2007)', count: 3 },
  { ratingKey: '198903', title: '12 Monkeys (1995)', count: 2 },
  { ratingKey: '267576', title: '20,000 Leagues Under the Sea (1954)', count: 1 },
  { ratingKey: '452897', title: '*batteries not included (1987)', count: 1 },
];
const MOVIE_SAMPLE = { ratingKey: '174306', title: '12 Angry Men (1957)' };

// What the HA bridge would report once a queue is on screen. ratingKey is an INT here
// because that is what HA's media_content_id is. The `bob` entry is a REAL ratingKey in
// the harness `bob` queue, so the playing-tile highlight has something to match; any
// other set falls back to a ratingKey that is NOT in any queue, which exercises the
// no-match path (the web app shows no pill at all — see activeSet() in web/app.js).
const NOW_BY_SET = {
  bob: { ratingKey: 267576, type: 'movie', title: '20,000 Leagues Under the Sea', duration: 7460 },
};
const NOW_FALLBACK = { ratingKey: Number(MOVIE_SAMPLE.ratingKey), type: 'movie', title: MOVIE_SAMPLE.title, duration: 5760 };
const nowPlayingFor = (set, state = 'playing') => ({
  state,
  showTitle: null,
  season: null,
  episode: null,
  username: 'Bob',
  device: 'Family Room SHIELD',
  ...(NOW_BY_SET[set] || NOW_FALLBACK),
});

export function startFakeMqtt({ port = PORT } = {}) {
  const aedes = new Aedes();
  const server = net.createServer(aedes.handle);
  // Every command payload the responder receives, for harness assertions (e.g. that a
  // preview/start carries the selected profile).
  const received = { previews: [], starts: [] };

  return new Promise((resolve) => {
    server.listen(port, () => {
      const client = mqtt.connect({ host: '127.0.0.1', port, protocol: 'mqtt', clientId: 'fake-responder' });

      client.on('connect', () => {
        // Retained device registry (the "Play on ▾" source).
        for (const [id, dev] of Object.entries(DEVICES)) {
          client.publish(`${T_DEVICES_BASE}/${id}`, JSON.stringify({ ...dev, seen: Math.floor(Date.now() / 1e3) }),
            { qos: 1, retain: true });
        }
        // Seed a retained state so /api/state has something before any play.
        client.publish(T_STATE, JSON.stringify({ kind: null, set: null, queue_len: 0, now: null }),
          { qos: 1, retain: true });
        // Idle until something plays — matches what the HA bridge publishes when the Shield
        // is sitting on the Plex home screen.
        client.publish(T_NOW_PLAYING, JSON.stringify({ state: 'idle', ratingKey: null, device: 'Family Room SHIELD' }),
          { qos: 1, retain: true });
        client.subscribe([T_CMD_PREVIEW, T_CMD_START], () => {
          console.log(`[fake-mqtt] broker on :${port}; responder ready (2 devices, canned pool)`);
          resolve({ aedes, server, client, port, received });
        });
      });

      client.on('message', (topic, buf) => {
        let payload = {};
        try { payload = JSON.parse(buf.toString() || '{}'); } catch { /* ignore */ }

        if (topic === T_CMD_PREVIEW) {
          received.previews.push(payload);
          const reply = String(payload.reply || '');
          if (!reply.startsWith(T_RESP_PREVIEW_BASE)) return; // same guard mqttd has
          const out = { set: String(payload.set || ''), buckets: SHOWS_BUCKETS,
            movie: MOVIE_SAMPLE, movie_pool: MOVIE_POOL };
          if (payload.profile) out.profile = String(payload.profile); // PR 4: echoed like the Python side
          client.publish(reply, JSON.stringify(out), { qos: 1 });
          console.log(`[fake-mqtt] preview ${out.set} -> ${reply} (${SHOWS_BUCKETS.length} buckets, ${MOVIE_POOL.length} movies)`);
          return;
        }
        if (topic === T_CMD_START) {
          received.starts.push(payload);
          // Ack a play by publishing a retained state with a playback result (drives the toast).
          const state = { kind: payload.kind || 'movie', set: payload.set || 'auto', queue_len: 1,
            now: MOVIE_SAMPLE.title, playback: { ok: true, device: payload.target || 'shield',
              title: MOVIE_SAMPLE.title } };
          client.publish(T_STATE, JSON.stringify(state), { qos: 1, retain: true });
          // ...and the live-playback topic the HA bridge owns, so the active-queue pill and
          // the playing-tile highlight light up exactly as they do in production.
          const now = nowPlayingFor(state.set);
          client.publish(T_NOW_PLAYING, JSON.stringify(now), { qos: 1, retain: true });
          console.log(`[fake-mqtt] session/start set=${state.set} target=${payload.target || '(default)'} -> state ack + now-playing rk=${now.ratingKey}`);
        }
      });
    });
  });
}

// Standalone: `node e2e/fake-mqtt.mjs` keeps the broker up until killed.
if (import.meta.url === `file://${process.argv[1]}`) {
  startFakeMqtt().then(() => console.log('[fake-mqtt] running; Ctrl-C to stop'));
}
