// THE WP-9 GATE — a piece of cardboard on the wall still reaches its queue.
//
// ## What breaks, and why nobody would find out
//
// A physical NFC card carries a SET ID. Home Assistant's `automation.plex_nfc_scanner` maps a
// tag to `{plex_action, kind, set, profile}`, `script.control_plex` publishes
// `{"set": "<id>", "kind": …, "profile": …, "via": "ha"}` on `queuepilot/cmd/session/start`,
// and this app looks that id up in its registry. Nothing in that chain reports a miss to a
// person: a card whose id no longer resolves is silent. Somebody taps it, the theater does not
// start, and the only evidence is a line in a container log nobody is reading.
//
// Since 2026-08-23 the chain has been rebuilt underneath: a store seam, SQLite as the book of
// record, a people table, twelve absorbed board-game tables, a rewritten queue model with a
// schema migration, a new Tonight surface and an activity→provider routing map. Eight work
// packages, every one of them between the broker and the row. This file is what makes "the
// cards still work" a fact rather than a hope.
//
// ## What it asserts, and what each assertion is protecting
//
//   1. **Twenty ids, BY NAME.** A count of twenty passes even if all twenty were replaced, so
//      every id is compared as an exact string, in both directions — nothing missing and
//      nothing extra. This is the registry AFTER the YAML→SQLite migration has run, so it is
//      the migration that is on trial and not the fixture.
//   2. **Sixteen queue ids, BY NAME.** `queues.set_id` is the same wire id as `sets.id`. They
//      can drift apart, and a card that resolves to a set with no lineup behind it is a card
//      that starts nothing.
//   3. **The topics HA speaks.** The app must SUBSCRIBE to the four command topics the
//      household publishes on. A renamed topic constant typechecks perfectly and takes every
//      card with it. Read off the broker's own subscribe event, not off `env.ts` — reading the
//      constant back would be the app agreeing with itself.
//   4. **The discovery config.** `sensor.queuepilot_status` is created by HA from this
//      retained payload. QueuePilot owns its top-up timer, while HA still reads the sensor for
//      dashboards and household automation state.
//   5. **Every card's payload reaches its set.** Twelve card payloads, in the exact shape
//      `script.control_plex` publishes, are put on the real broker and answered by the real
//      `mqttd`. The failure being hunted is `set '<id>' not enabled` — the sentence the app
//      publishes when a wire id does not resolve — plus `profile mismatch`, which is what a
//      per-tier card gets when a gate is re-pointed under it.
//   6. **The gate can fail.** An id that is NOT in the registry must produce exactly that
//      sentence. Without this the suite would pass just as happily against a server that had
//      stopped answering at all.
//   7. **`set: "auto"` still routes.** The UC remote's screen buttons still send it, and the
//      profile-driven branch is the one piece of the wire that resolves an id the card does
//      NOT carry.
//   8. **A manual top-up tick is answered.** QueuePilot normally wakes itself and publishes
//      each result. The MQTT command stays as the manual seam, and its reply topic is part of
//      the contract.
//
// ## What it deliberately does not do
//
// It does not name the live wire ids. This repo is public, five of the twenty carry household
// first names, and the 2026-08-17 history rewrite exists because they were once here
// (`docs/decisions/2026-08-17-the-repo-is-public-so-people-hosts-and-ips-are-placeholders`).
// The fixture mirrors the live registry's SHAPE — twenty ids, sixteen queues, the same profile
// gates, the same odd characters — under the repo's placeholder cast. The live ↔ placeholder
// key, and the run of this contract against the live book of record, are recorded privately.
//
// Offline: Plex points at a closed port, the other providers at `.invalid` hosts, and the
// broker is an in-process aedes. Nothing here reaches the household.
import { createRequire } from 'node:module';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { killServer, spawnServer } from './stubs/server-process.mjs';

// Same resolution the fake broker uses: aedes belongs to the `e2e/broker` workspace and the
// mqtt client to `server/`, and neither is resolvable from `e2e/` itself.
const requireBroker = createRequire(new URL('./broker/node_modules/', import.meta.url).pathname);
const requireClient = createRequire(new URL('../server/node_modules/', import.meta.url).pathname);
/* eslint-disable @typescript-eslint/no-explicit-any -- see fake-mqtt.ts: hand-writing an aedes
   surface to type a fake broker would be more machinery than the broker. */
const Aedes = requireBroker('aedes') as new () => any;
const mqtt = requireClient('mqtt') as { connect(opts: unknown): MqttHandle };
/* eslint-enable @typescript-eslint/no-explicit-any */

interface MqttHandle {
  on(event: 'connect', handler: () => void): void;
  on(event: 'message', handler: (topic: string, payload: Buffer) => void): void;
  publish(topic: string, payload: string, opts?: { qos?: number; retain?: boolean }): void;
  subscribe(topics: string[], cb: () => void): void;
  end(force?: boolean): void;
}

const BROKER_PORT = 21891;
const WEB_PORT = 18791;

const T_CMD_START = 'queuepilot/cmd/session/start';
const T_CMD_ADVANCE = 'queuepilot/cmd/session/advance';
const T_CMD_TOPUP = 'queuepilot/cmd/session/topup';
const T_CMD_PREVIEW = 'queuepilot/cmd/generic/preview';
const T_RESP_TOPUP = 'queuepilot/resp/topup';
const T_STATE = 'queuepilot/state';
const T_DISCOVERY = 'homeassistant/sensor/queuepilot_status/config';

/**
 * THE TWENTY. Placeholders, and a one-for-one stand-in for the live registry's twenty — same
 * count, same mix of curated queues and rules pools, same shapes.
 */
const EXPECTED_SETS = [
  'bob',
  'bob_kids',
  'bob_carol_movies',
  'bob_alice',
  'bob_dave_movies',
  'demo',
  'bob_erin_movies',
  'carol_1',
  'bob_frank_movies',
  'bob_anime',
  'bob_alice_anime',
  'bob_kids_anime',
  'family_anime',
  'manga_webtoons',
  'older_kids_shorts_shows',
  'younger_kids_shows',
  'younger',
  'older',
  'shorts',
  'movies',
] as const;

/** The sixteen `source: queue` sets. The four rules pools have no curated lineup. */
const EXPECTED_QUEUES = EXPECTED_SETS.filter(
  (id) => !['younger', 'older', 'shorts', 'movies'].includes(id),
);

/**
 * THE CARD TABLE — the same shape as `tag_command_map` in `automation.plex_nfc_scanner`, and
 * the same twelve rows the household has on the wall: five per-tier kid cards, six curated
 * per-audience cards, and the theater reel.
 *
 * `profile` is what the card carries, and it is load-bearing rather than decorative: a set
 * with `requires_profile` refuses a card that names a different one, so this table is also
 * what proves the gates and the cards still agree with each other.
 */
const CARDS: readonly { set: string; kind: 'picks' | 'rules'; profile: string }[] = [
  { kind: 'picks', profile: 'Older Kids', set: 'older_kids_shorts_shows' },
  { kind: 'rules', profile: 'Older Kids', set: 'movies' },
  { kind: 'picks', profile: 'Younger Kids', set: 'younger_kids_shows' },
  { kind: 'rules', profile: 'Younger Kids', set: 'shorts' },
  { kind: 'rules', profile: 'Younger Kids', set: 'movies' },
  { kind: 'picks', profile: '', set: 'bob' },
  { kind: 'picks', profile: '', set: 'bob_anime' },
  { kind: 'picks', profile: '', set: 'bob_alice' },
  { kind: 'picks', profile: '', set: 'bob_alice_anime' },
  { kind: 'picks', profile: '', set: 'bob_kids' },
  { kind: 'picks', profile: '', set: 'bob_kids_anime' },
  { kind: 'picks', profile: '', set: 'demo' },
];

/**
 * The sentences the app publishes when a WIRE id fails to resolve. Matched as text because
 * that is all a state payload carries — there is no error code — and because these three are
 * exactly the failures a re-keyed row, a dropped set or a moved gate produce. Everything
 * further down the chain (Plex unreachable, a provider not configured) is expected here and
 * must NOT fail the suite: this gate is about the id reaching the set, not about the play.
 */
const WIRE_FAILURES = [/not enabled/i, /profile mismatch/i, /has no set mapped/i, /no profile/i];

let failures = 0;
const ok = (name: string, condition: boolean, extra = ''): void => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!condition) failures += 1;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface StateMessage {
  error?: unknown;
  awaiting?: unknown;
  [field: string]: unknown;
}

async function main(): Promise<void> {
  // ---- the broker -------------------------------------------------------------------- //
  /* eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- untyped aedes */
  const aedes = new Aedes();
  /* eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- untyped aedes */
  const broker = net.createServer(aedes.handle);
  /** Every topic the app under test subscribed to, recorded at the broker. */
  const subscribed = new Set<string>();
  /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
  aedes.on('subscribe', (subs: { topic: string }[]) => {
    for (const s of subs) subscribed.add(s.topic);
  });
  /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
  await new Promise<void>((resolve) => broker.listen(BROKER_PORT, resolve));

  // ---- the config directory ---------------------------------------------------------- //
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'qp-wire-'));
  await fs.copyFile('e2e/fixtures/wire-contract.sets.yaml', path.join(dir, 'sets.yaml'));
  await fs.copyFile('e2e/fixtures/wire-contract.queues.yaml', path.join(dir, 'queues.yaml'));
  await fs.writeFile(path.join(dir, 'groups.yaml'), 'groups: []\n');
  await fs.writeFile(path.join(dir, 'pending.yaml'), 'seen_through: 0\n');

  let child: ChildProcess | null = null;
  let client: MqttHandle | null = null;

  try {
    child = spawnServer({
      env: {
        ...process.env,
        BOARD_GAME_PICKER_URL: 'https://board-games.invalid',
        CACHE_PATH: path.join(dir, 'cache.sqlite'),
        GROUPS_PATH: path.join(dir, 'groups.yaml'),
        HISTORY_PATH: path.join(dir, '.history.json'),
        KAVITA_API_KEY: 'offline-harness-key',
        KAVITA_API_SERVER_URL: 'https://kavita.invalid',
        MQTT_HOST: '127.0.0.1',
        MQTT_PORT: String(BROKER_PORT),
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        PENDING_PATH: path.join(dir, 'pending.yaml'),
        // The LIVE setting. Without it a gated set takes the pre-FSM branch and blocks on
        // `waitForProfile` for two minutes per card, which is both slow and a different code
        // path from the one the household runs.
        PLAYBACK_FSM: 'true',
        PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
        PLEX_TOKEN: '',
        // Only the `set: "auto"` branch reaches this, and it has no profile to find here.
        PROFILE_WAIT_SECONDS: '1',
        PROVIDERS_PATH: path.join(dir, 'providers.yaml'),
        PROVIDERS_SECRETS_PATH: path.join(dir, 'providers.secrets.yaml'),
        QUEUES_PATH: path.join(dir, 'queues.yaml'),
        SETS_PATH: path.join(dir, 'sets.yaml'),
        STORE_BACKEND: 'sqlite',
        // Named rather than derived, so the harness can read the book of record back.
        STORE_PATH: path.join(dir, 'queuepilot.sqlite'),
        WEB_PORT: String(WEB_PORT),
      },
      stdio: 'ignore',
    });

    const base = `http://localhost:${WEB_PORT}`;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try {
        const res = await fetch(`${base}/api/sets`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      await sleep(200);
    }

    // ---- 1 + 2: the ids, by name --------------------------------------------------- //
    const setsBody = (await (await fetch(`${base}/api/sets`)).json()) as {
      sets?: { id: string }[];
    };
    const setIds = (setsBody.sets ?? []).map((s) => s.id);
    ok(
      'twenty set ids, none missing',
      EXPECTED_SETS.every((id) => setIds.includes(id)),
      `missing ${JSON.stringify(EXPECTED_SETS.filter((id) => !setIds.includes(id)))}`,
    );
    ok(
      'twenty set ids, none extra',
      setIds.every((id) => (EXPECTED_SETS as readonly string[]).includes(id)),
      `extra ${JSON.stringify(setIds.filter((id) => !(EXPECTED_SETS as readonly string[]).includes(id)))}`,
    );
    ok('the count is twenty', setIds.length === 20, `saw ${setIds.length}`);

    // Read off the BOOK OF RECORD rather than off `/api/queues`, and the difference is the
    // point: that endpoint answers with a row per SET (a rotation pool included, with an
    // empty `items`), so it cannot tell "this queue is keyed `bob`" from "this set has no
    // lineup". `queues.set_id` is a wire id in its own right and this is where it lives.
    const db = new DatabaseSync(path.join(dir, 'queuepilot.sqlite'), { readOnly: true });
    let queueIds: string[] = [];
    try {
      queueIds = (
        db.prepare('select distinct set_id from queues order by set_id').all() as {
          set_id: string;
        }[]
      ).map((row) => row.set_id);
    } finally {
      db.close();
    }
    ok(
      'sixteen queue ids, none missing',
      EXPECTED_QUEUES.every((id) => queueIds.includes(id)),
      `missing ${JSON.stringify(EXPECTED_QUEUES.filter((id) => !queueIds.includes(id)))}`,
    );
    ok(
      'sixteen queue ids, none extra',
      queueIds.every((id) => EXPECTED_QUEUES.includes(id as (typeof EXPECTED_QUEUES)[number])),
      `extra ${JSON.stringify(queueIds.filter((id) => !EXPECTED_QUEUES.includes(id as (typeof EXPECTED_QUEUES)[number])))}`,
    );
    ok(
      'every queue id is also a set id — a card resolves to a lineup, not to an orphan',
      queueIds.every((id) => setIds.includes(id)),
    );

    // ---- the client ----------------------------------------------------------------- //
    const states: StateMessage[] = [];
    const topups: unknown[] = [];
    const discovery: Record<string, unknown>[] = [];

    client = mqtt.connect({
      clientId: 'wire-contract-probe',
      host: '127.0.0.1',
      port: BROKER_PORT,
      protocol: 'mqtt',
    });

    await new Promise<void>((resolve) => {
      client!.on('connect', () => {
        client!.subscribe([T_STATE, T_RESP_TOPUP, T_DISCOVERY], resolve);
      });
    });

    client.on('message', (topic, buf) => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(buf.toString() || 'null');
      } catch {
        return;
      }
      if (topic === T_STATE && parsed && typeof parsed === 'object') {
        states.push(parsed as StateMessage);
      }
      if (topic === T_RESP_TOPUP) topups.push(parsed);
      if (topic === T_DISCOVERY && parsed && typeof parsed === 'object') {
        discovery.push(parsed as Record<string, unknown>);
      }
    });

    // The retained discovery + boot state land on subscribe.
    await sleep(1500);

    // ---- 3: the topics HA speaks ---------------------------------------------------- //
    for (const topic of [T_CMD_START, T_CMD_ADVANCE, T_CMD_TOPUP, T_CMD_PREVIEW]) {
      ok(`subscribed to ${topic}`, subscribed.has(topic));
    }

    // ---- 4: the discovery config ---------------------------------------------------- //
    const cfg = discovery[discovery.length - 1] ?? null;
    ok('discovery config published', cfg != null);
    ok(
      'discovery object_id is queuepilot_status',
      cfg?.object_id === 'queuepilot_status',
      String(cfg?.object_id),
    );
    ok('discovery state topic is queuepilot/state', cfg?.state_topic === T_STATE);
    ok(
      'discovery exposes the state as attributes for HA dashboards and household automations',
      cfg?.json_attributes_topic === T_STATE,
    );

    /** Publish one command and wait for the next state message it causes. */
    const startAndRead = async (payload: Record<string, unknown>): Promise<StateMessage[]> => {
      const before = states.length;
      client!.publish(T_CMD_START, JSON.stringify(payload), { qos: 1 });
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await sleep(100);
        if (states.length > before) break;
      }
      return states.slice(before);
    };

    // ---- 5: every card's payload reaches its set ------------------------------------ //
    for (const card of CARDS) {
      // EXACTLY what `script.control_plex` puts on the wire, `via` and all.
      const seen = await startAndRead({
        kind: card.kind,
        profile: card.profile,
        set: card.set,
        via: 'ha',
      });
      const errors = seen
        .map((s) => (typeof s.error === 'string' ? s.error : ''))
        .filter(Boolean);
      const wireFailure = errors.find((e) => WIRE_FAILURES.some((rx) => rx.test(e)));
      ok(
        `card {"set": "${card.set}"${card.profile ? `, "profile": "${card.profile}"` : ''}} resolves`,
        seen.length > 0 && !wireFailure,
        wireFailure ?? (seen.length ? '' : 'no state was published at all'),
      );
    }

    // Every id in the registry, not only the twelve that are on cardboard: a web tile, a
    // voice sentence and `automation.plex_app_control` publish the same payload for any of
    // them, and an id that resolves for nobody is still a broken address.
    for (const id of EXPECTED_SETS) {
      const seen = await startAndRead({ kind: 'picks', profile: '', set: id, via: 'ha' });
      const errors = seen
        .map((s) => (typeof s.error === 'string' ? s.error : ''))
        .filter(Boolean);
      const notEnabled = errors.find((e) => /not enabled/i.test(e));
      ok(`{"set": "${id}"} is a live address`, seen.length > 0 && !notEnabled, notEnabled ?? '');
    }

    // ---- 6: the gate can fail ------------------------------------------------------- //
    const bogus = await startAndRead({
      kind: 'picks',
      profile: '',
      set: 'no_such_set_id',
      via: 'ha',
    });
    ok(
      'an unknown id is refused BY NAME (so a green run means something)',
      bogus.some((s) => typeof s.error === 'string' && /no_such_set_id.*not enabled/i.test(s.error)),
      JSON.stringify(bogus.map((s) => s.error)),
    );

    // ---- 7: `set: "auto"` still routes ---------------------------------------------- //
    const auto = await startAndRead({ kind: 'rules', profile: '', set: 'auto', via: 'ha' });
    ok(
      'set "auto" reaches the profile-driven router',
      auto.some((s) => s.awaiting === 'profile'),
      JSON.stringify(auto.map((s) => s.awaiting ?? s.error)),
    );

    // ---- 8: a top-up tick is answered ----------------------------------------------- //
    const topupsBefore = topups.length;
    client.publish(T_CMD_TOPUP, '{}', { qos: 1 });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await sleep(100);
      if (topups.length > topupsBefore) break;
    }
    ok(
      'an empty {} manual top-up is answered on resp/topup',
      topups.length > topupsBefore,
    );

    // An advance with an empty body must not take the service down — it is what the
    // "switch it up" card and the voice sentence both send.
    client.publish(T_CMD_ADVANCE, '{}', { qos: 1 });
    await sleep(500);
    const stillUp = await fetch(`${base}/api/sets`).then(
      (r) => r.ok,
      () => false,
    );
    ok('an empty advance leaves the service running', stillUp);
  } finally {
    client?.end(true);
    if (child) killServer(child);
    broker.close();
    /* eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
    aedes.close();
    await fs.rm(dir, { force: true, recursive: true });
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
