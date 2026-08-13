// The plex-channels -> queuepilot rename bridge (env.js: legacyTopic/bothTopics/canonicalTopic).
//
// Why this is a gate and not a comment: the bridge is what keeps the NFC cards working while
// HA is migrated off the old topic prefix. Every failure mode here is SILENT — a card scan
// publishes to a topic nobody subscribes to, the broker accepts it, and nothing logs an error.
// The cards just stop. So the mapping is pinned in both directions.
//
// env.js reads process.env at import time, so each case sets the environment and then imports
// a fresh copy via a cache-busting query string.
import assert from 'node:assert/strict';

let caseNumber = 0;
const load = async (env) => {
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  caseNumber += 1;
  return import(`../server/src/env.js?bridge-case=${caseNumber}`);
};

// --- bridge ON (the default, and the state we deploy the rename in) ------------------ //
{
  const env = await load({ MQTT_PREFIX: null, MQTT_LEGACY_PREFIX: null });

  assert.equal(env.MQTT_PREFIX, 'queuepilot', 'new prefix is the default');
  assert.equal(env.MQTT_LEGACY_PREFIX, 'plex-channels', 'bridge is ON by default');

  // Every topic default moved prefix.
  assert.equal(env.T_CMD_START, 'queuepilot/cmd/session/start');
  assert.equal(env.T_CMD_ADVANCE, 'queuepilot/cmd/session/advance');
  assert.equal(env.T_CMD_PREVIEW, 'queuepilot/cmd/generic/preview');
  assert.equal(env.T_CMD_SOUNDTRACK, 'queuepilot/cmd/soundtrack/resolve');
  assert.equal(env.T_CMD_CAST_PLAY, 'queuepilot/cmd/cast/play');
  assert.equal(env.T_RESP_PREVIEW_BASE, 'queuepilot/resp/preview');
  assert.equal(env.T_RESP_LAST_PLAYED, 'queuepilot/resp/last-played');
  assert.equal(env.T_RESP_SOUNDTRACK, 'queuepilot/resp/soundtrack');
  assert.equal(env.T_STATE, 'queuepilot/state');
  assert.equal(env.T_NOW_PLAYING, 'queuepilot/now-playing');
  assert.equal(env.T_DEVICES_BASE, 'queuepilot/devices');
  assert.equal(env.DISCOVERY_OBJECT_ID, 'queuepilot_status');
  assert.equal(env.DISCOVERY_LEGACY_OBJECT_ID, 'plex_channels_status');

  // The alias is the OLD topic, byte-for-byte what HA is subscribed to today.
  assert.equal(env.legacyTopic('queuepilot/state'), 'plex-channels/state');
  assert.equal(
    env.legacyTopic('queuepilot/cmd/session/start'),
    'plex-channels/cmd/session/start',
  );
  // Deep paths keep every remaining segment.
  assert.equal(
    env.legacyTopic('queuepilot/resp/preview/abc-123'),
    'plex-channels/resp/preview/abc-123',
  );

  // Subscribe-to-both, new prefix first.
  assert.deepEqual(
    env.bothTopics('queuepilot/cmd/session/advance'),
    ['queuepilot/cmd/session/advance', 'plex-channels/cmd/session/advance'],
  );

  // Inbound folding: either prefix lands on the canonical constant.
  assert.equal(env.canonicalTopic('plex-channels/cmd/session/start'), 'queuepilot/cmd/session/start');
  assert.equal(env.canonicalTopic('queuepilot/cmd/session/start'), 'queuepilot/cmd/session/start');

  // Round trip both ways.
  assert.equal(env.canonicalTopic(env.legacyTopic(env.T_STATE)), env.T_STATE);

  // A topic that is not under either prefix is left completely alone — the discovery topic
  // lives under `homeassistant/`, and aliasing it would publish a bogus config topic.
  assert.equal(env.legacyTopic('homeassistant/sensor/queuepilot_status/config'), null);
  assert.equal(
    env.canonicalTopic('homeassistant/sensor/queuepilot_status/config'),
    'homeassistant/sensor/queuepilot_status/config',
  );
  assert.deepEqual(env.bothTopics('homeassistant/x'), ['homeassistant/x']);

  // A bare prefix with no trailing slash must not be mistaken for a topic under it.
  assert.equal(env.legacyTopic('queuepilot'), null);

  // Substring traps: a DIFFERENT app whose name merely starts with the prefix is not ours.
  assert.equal(env.legacyTopic('queuepilotx/state'), null);
  assert.equal(env.canonicalTopic('plex-channels-other/state'), 'plex-channels-other/state');
}

// --- bridge OFF (the end state, set by clearing MQTT_LEGACY_PREFIX in the app env) ---- //
{
  const env = await load({ MQTT_LEGACY_PREFIX: '' });

  assert.equal(env.T_STATE, 'queuepilot/state', 'topics do not move when the bridge goes off');
  assert.equal(env.legacyTopic('queuepilot/state'), null, 'no alias once the bridge is off');
  assert.deepEqual(env.bothTopics('queuepilot/state'), ['queuepilot/state'], 'subscribe once');
  // With the bridge off an old-prefix message is NOT folded — it is genuinely foreign, and
  // silently accepting it would hide an unmigrated HA automation instead of surfacing it.
  assert.equal(env.canonicalTopic('plex-channels/state'), 'plex-channels/state');
}

// --- an individually-overridden topic opts itself out ---------------------------------- //
{
  const env = await load({ MQTT_LEGACY_PREFIX: 'plex-channels', T_STATE: 'somewhere/else' });

  assert.equal(env.T_STATE, 'somewhere/else', 'the override wins');
  assert.equal(env.legacyTopic(env.T_STATE), null, 'an off-prefix override is not aliased');
  assert.deepEqual(env.bothTopics(env.T_STATE), ['somewhere/else']);
}

// --- a staged rollback: pin the whole app back onto the old prefix ---------------------- //
// The escape hatch if the cutover goes wrong mid-flight. Setting MQTT_PREFIX back makes the
// old topics canonical again, and the bridge then has nothing to add.
{
  const env = await load({
    MQTT_PREFIX: 'plex-channels', MQTT_LEGACY_PREFIX: 'plex-channels', T_STATE: null,
  });

  assert.equal(env.T_STATE, 'queuepilot/state', 'MQTT_PREFIX does not rewrite topic defaults');
  assert.equal(
    env.legacyTopic('plex-channels/state'), null,
    'prefix == legacy prefix must not alias a topic onto itself',
  );
  assert.equal(env.canonicalTopic('plex-channels/state'), 'plex-channels/state');
}

console.log('mqtt-legacy-bridge-test: OK');
