// The MQTT device registry (server/src/devices.js) — the "Play on ▾" dropdown's source.
//
// Why this is a gate: the registry is RETAINED topics, so every failure here is invisible.
// The Node port announced only the Shield for months and nobody noticed, because the broker
// kept serving the Python service's last announcements — `Plex Dash` and `Pollycracker` as
// ghosts, refreshed by nothing and de-registered by nothing (docs/queuepilot-mqtt-cutover.md,
// "The device-registry gap"). A registry that stops sweeping and a registry that stops
// clearing look identical from the UI: a plausible list of devices. So both halves are
// pinned here — what gets announced, and what gets CLEARED.
//
// Fully offline: plex.tv is stubbed at `globalThis.fetch` (playback.js's plextv() helper is
// the only thing that calls it), so this needs no token and no network.
//
// Run:  server/node_modules/.bin/tsx e2e/device-registry-test.ts     (from the repo root; exits non-zero on failure)

// env.js + config.js read process.env at module-eval, so these must precede the imports.
process.env.CONFIG_PATH = '/nonexistent/config.yaml'; // ignore any real /config host YAML
process.env.PLAYBACK_MODE = 'client';
process.env.SHIELD_CLIENT_NAME = 'Family Room SHIELD';
process.env.SHIELD_CLIENT_MACHINE_ID = '';
process.env.SHIELD_CLIENT_URI = '';

import assert from 'node:assert/strict';

const T = 'queuepilot/devices';

// --- the plex.tv stub -------------------------------------------------------------- //
// One knob: what /api/v2/devices does this round. Rows are shaped like the real plex.tv
// payload (provides / clientIdentifier / connections[]), because that shaping IS the code
// under test — playerDevices() filters on `provides` and flattens `connections`.
/** One plex.tv `/api/v2/devices` row as `playerDevices()` reads it. */
interface PlexTvRow {
  name?: string;
  clientIdentifier?: string;
  provides?: string;
  connections?: { uri: string }[];
}
/** What the knob returns this round: the rows, or the harness's `__status` escape hatch for
 * "plex.tv answered non-2xx". */
type PlexTvOutcome = PlexTvRow[] | { __status: number };

let plextv: () => PlexTvOutcome = () => [];
const fetched: string[] = [];
// The stub answers with only the two fields `plextv()` reads (`ok`, `text()`), so it is not a
// `Response` and the global is assigned through one cast rather than by faking 30 unused members.
globalThis.fetch = (async (url: unknown) => {
  fetched.push(String(url));
  const outcome = plextv();
  const status = (outcome as { __status?: number }).__status;
  if (outcome && status) {
    return { ok: false, status, text: async () => '' };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(outcome) };
}) as unknown as typeof globalThis.fetch;

const devices = await import('../server/src/devices.js');

// Collect what would go to the broker. This is mqttd's pub() signature — the one place
// anything reaches the client, which is why devices.js publishes THROUGH it rather than
// touching the client itself.
/**
 * One recorded publish. `payload` is `any` on purpose: it is EITHER the retained device object
 * or the empty string that ERASES it, and the assertions below probe both — a union would need
 * narrowing on every line without making any of them stricter.
 */
interface PublishedMessage {
  topic: string;
  payload: any;
  opts: { retain?: boolean };
}

let published: PublishedMessage[] = [];
const pub = (topic: string, payload: unknown, opts: { retain?: boolean } = {}) =>
  published.push({ topic, payload, opts });
const round = async () => { published = []; await devices.announceDevices(pub); return published; };
const topics = () => published.map((p) => p.topic);
const sent = (id: string) => published.find((p) => p.topic === `${T}/${id}`);

const FAILS: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

const SHIELD_ROW: PlexTvRow = {
  name: 'Family Room SHIELD',
  clientIdentifier: 'shield-machine-id',
  provides: 'client,player,pubsub-player',
  connections: [{ uri: 'http://192.0.2.50:32500' }],
};
const DASH_ROW: PlexTvRow = {
  name: 'Plex Dash',
  clientIdentifier: '0e072bfb-dash',
  provides: 'player',
  connections: [], // a player advertising no connection — real: this is what Plex Dash does
};
const POLLY_ROW: PlexTvRow = {
  name: 'Pollycracker',
  clientIdentifier: '606c3173-polly',
  provides: 'client,player',
  connections: [{ uri: 'http://192.0.2.213:53833' }],
};
const SERVER_ROW: PlexTvRow = { name: 'nas', clientIdentifier: 'pms-machine-id', provides: 'server' };

// --- 1. a full sweep: the Shield plus every plex.tv player -------------------------- //
{
  plextv = () => [SHIELD_ROW, DASH_ROW, POLLY_ROW, SERVER_ROW];
  await round();

  ok('asks plex.tv for the device list', fetched.at(-1) === 'https://plex.tv/api/v2/devices', fetched.at(-1));
  ok('announces the Shield + both players, nothing else', topics().length === 3, topics().join(' '));
  ok('every announcement is retained', published.every((p) => p.opts.retain === true));

  // The payload shape is the contract with the web UI and with whatever HA does with it —
  // byte-for-byte what the deleted Python service published (observed on the broker).
  const polly = sent('606c3173-polly');
  ok('a player is announced under its machine id', Boolean(polly));
  // The assertion on the line above is the guard; `!` keeps the next line throwing where it did.
  const { seen, ...shape } = polly!.payload;
  assert.deepEqual(shape, {
    id: '606c3173-polly',
    name: 'Pollycracker',
    machineIdentifier: '606c3173-polly',
    uri: 'http://192.0.2.213:53833',
    mode: 'client',
    default: false,
  });
  ok('payload matches the Python announcement shape', true);
  ok('`seen` is a unix epoch (how a consumer ages a device out)',
    Number.isInteger(seen) && Math.abs(seen - Math.floor(Date.now() / 1000)) < 5, String(seen));

  // A player with no advertised connection is still announced — it is castable by name, and
  // filtering it out here is what would silently shrink the dropdown.
  ok('a connectionless player is announced with uri:null', sent('0e072bfb-dash')?.payload.uri === null);

  // The filter under test: `provides` must contain "player".
  ok('a non-player (a server) is excluded', !sent('pms-machine-id'));

  // The Shield reaches plex.tv too. Listing it twice — once as the default, once not — is a
  // confusing dropdown, so its row folds into the default entry and fills in what env didn't.
  const shield = sent('shield');
  ok('the Shield is the default entry', shield?.payload.default === true);
  ok('the Shield is not also listed under its machine id', !sent('shield-machine-id'));
  ok('the Shield borrows the id/uri plex.tv knows',
    shield?.payload.machineIdentifier === 'shield-machine-id'
    && shield?.payload.uri === 'http://192.0.2.50:32500');
  ok('the Shield carries `seen` as well', Number.isInteger(shield?.payload.seen));

  // The registry is also what a start command's `target` id resolves against.
  ok('a target id resolves to its entry', devices.known('606c3173-polly')?.name === 'Pollycracker');
  ok('an unknown target id resolves to null (caller falls back to the Shield)',
    devices.known('nope') === null && devices.known(undefined) === null);
}

// --- 2. a device that disappears is DE-REGISTERED, not left stale ------------------- //
{
  plextv = () => [SHIELD_ROW, POLLY_ROW]; // Plex Dash went away
  await round();

  // mqttc.js reads an EMPTY retained payload as de-registered (`if (!text) DEVICES.delete`).
  const cleared = sent('0e072bfb-dash');
  ok('the vanished device gets its retained topic cleared', cleared?.payload === '');
  ok('the clear is retained too (it must ERASE the retained message)', cleared?.opts.retain === true);
  ok('it drops out of the registry', devices.known('0e072bfb-dash') === null);
  ok('the survivors are re-announced', Boolean(sent('shield') && sent('606c3173-polly')));
}

// --- 3. plex.tv unreachable: the Shield still announces, nothing is lost ------------- //
{
  // (a) a hard network failure
  plextv = () => { throw new Error('getaddrinfo ENOTFOUND plex.tv'); };
  await round();
  ok('a plex.tv outage still announces the Shield', sent('shield')?.payload.default === true);
  ok('a plex.tv outage announces ONLY the Shield', topics().length === 1, topics().join(' '));
  ok('a known device is NOT cleared on a failed sweep — absence of information is not '
    + 'evidence of absence, and it stays playable over its own uri',
    devices.known('606c3173-polly')?.name === 'Pollycracker');
  ok('...and its retained payload is left untouched, so its `seen` stops advancing',
    !published.some((p) => p.topic.endsWith('606c3173-polly')));

  // (b) plex.tv answering 401 (an expired token) is the same class of failure
  plextv = () => ({ __status: 401 });
  await round();
  ok('a plex.tv 401 degrades the same way', topics().length === 1 && Boolean(sent('shield')));

  // The sweep recovering is what actually de-registers it.
  plextv = () => [SHIELD_ROW];
  await round();
  ok('the first SUCCESSFUL sweep without it clears it', sent('606c3173-polly')?.payload === '');
  ok('and only then does it leave the registry', devices.known('606c3173-polly') === null);
}

// --- 4. the announcer can never take the interval down ------------------------------- //
{
  devices._reset();
  plextv = () => [POLLY_ROW];
  // A publish that throws (a broker client mid-reconnect) must not reject out of the round:
  // mqttd runs this on setInterval, where an unhandled rejection kills the announcer and
  // leaves exactly the ghost registry this module exists to end.
  await assert.doesNotReject(() => devices.announceDevices(() => { throw new Error('not connected'); }));
  ok('a throwing publisher never rejects out of the announce round', true);

  // And it recovers on the next round rather than staying wedged.
  const after = await round();
  ok('the next round announces normally', after.some((p) => p.topic === `${T}/606c3173-polly`));
}

console.log(FAILS.length ? `\nFAILED: ${FAILS.length} (${FAILS.join(', ')})` : '\nOK: device registry announce + de-registration');
process.exit(FAILS.length ? 1 : 0);
