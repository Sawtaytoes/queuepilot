// THE TOPIC CONTRACT — the one thing WP-4d moved that nothing may notice.
//
// The four collection jobs used to live in a sibling app, which subscribed to
// `board-game-picker/cmd/sync` and answered on `board-game-picker/resp/sync`. Home Assistant
// publishes that command on a schedule and templates `isOk` off that response to decide whether
// to send a notification. WP-4d moved the HANDLER into this app and left the CONTRACT alone,
// which is the whole reason the move is invisible from outside.
//
// ── Why this is a gate and not a paragraph ───────────────────────────────────────────────
//
// Every part of that contract is a STRING or a KEY NAME, and nothing else in this repo reads
// either. Rename the base to `queuepilot` because it reads better, or rename `isOk` to `ok`
// while tidying a type, and:
//
//   * typecheck passes,
//   * every unit test passes,
//   * the app starts, connects and logs that it is listening,
//   * and the nightly silently stops running, because HA is publishing into a topic nobody
//     subscribes to. The first sign is a collection that has not refreshed in a month.
//
// A failure here is a change to a household automation, not a change to this repo. Fix the
// code; do not fix the test. If the base genuinely has to move, the HA package moves in the
// same change — that is WP-10's problem, not a tidy-up.
//
// Runs against a REAL broker (aedes, the same one the screenshot harness uses), not a stub of
// our own MQTT layer — a stub agreeing with the code that built it would prove nothing.
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// aedes and mqtt live in node_modules `e2e/` does not own, so there is no package for tsc to
// read types from — the same problem `fake-mqtt.ts` solves, resolved the same way and for the
// same reason. Relative to `import.meta.url`, never an absolute path: an absolute one only ever
// existed on one machine and CI silently skipped the layer that needed a broker.
const requireBroker = createRequire(new URL('./broker/node_modules/', import.meta.url).pathname);
const requireClient = createRequire(new URL('../server/node_modules/', import.meta.url).pathname);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Aedes = requireBroker('aedes') as new () => any;
const mqtt = requireClient('mqtt') as {
  connect(url: string): {
    on(event: 'connect', handler: () => void): void;
    on(
      event: 'message',
      handler: (topic: string, payload: Buffer, packet: { retain: boolean }) => void,
    ): void;
    subscribe(topic: string): void;
    publish(topic: string, payload: string, opts: { retain: boolean }): void;
    end(isForced: boolean): void;
  };
};

const PORT = Number(process.env.MQTT_TEST_PORT || 18913);

let failures = 0;
const ok = (name: string, isPass: boolean, detail = ''): void => {
  console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!isPass) failures += 1;
};

// A scratch config directory of its own, MADE rather than assumed: `defaultStorePath()` walks
// its candidates and takes the first whose directory exists, so without this the store lands in
// a hashed tmpdir path instead of here. Same answer either way on a throwaway runner, but a
// harness that names its own scratch is one that cannot collide with another one's.
const SCRATCH = mkdtempSync(join(tmpdir(), 'qp-mqtt-gate-'));
process.env.QUEUES_PATH = join(SCRATCH, 'queues.yaml');
process.env.MQTT_HOST = '127.0.0.1';
process.env.MQTT_PORT = String(PORT);
delete process.env.MQTT_USER;
delete process.env.MQTT_PASS;

const broker = new Aedes();
const subscribed: string[] = [];
broker.on('subscribe', (subs: { topic: string }[]) => {
  for (const one of subs) subscribed.push(one.topic);
});
const server = createServer(broker.handle);
await new Promise<void>((resolve) => server.listen(PORT, resolve));

const { startBoardGameMqtt } = await import('../server/src/boardgames/mqtt.js');
const service = await startBoardGameMqtt();
ok('the service starts when MQTT_HOST is set', service !== null);

// Subscribe the way the Home Assistant automation does.
const watcher = mqtt.connect(`mqtt://127.0.0.1:${PORT}`);
await new Promise<void>((resolve) => watcher.on('connect', () => resolve()));

/**
 * ⚠️ THE WAIT IS BOUNDED, and that is not belt-and-braces.
 *
 * The failure this gate exists to catch — a renamed base — means the command lands on a topic
 * nobody is subscribed to, so no response is EVER published. An unbounded `await` there does not
 * fail; it HANGS, and a hung job in CI burns the runner's whole timeout and reports nothing
 * useful. This repo has already lost six hours to one stalling step. A missing answer is a
 * FAILED answer, and it says so within seconds.
 */
const ANSWER_TIMEOUT_MS = 30_000;
const answered = Promise.race([
  new Promise<{ topic: string; payload: string; isRetained: boolean } | null>((resolve) => {
    watcher.on('message', (topic: string, payload: Buffer, packet: { retain: boolean }) =>
      resolve({ isRetained: packet.retain, payload: payload.toString(), topic }),
    );
  }),
  new Promise<null>((resolve) => setTimeout(() => resolve(null), ANSWER_TIMEOUT_MS)),
]);
watcher.subscribe('board-game-picker/resp/sync');
await new Promise((resolve) => setTimeout(resolve, 400));

ok(
  'the app subscribes to `board-game-picker/cmd/+`',
  subscribed.includes('board-game-picker/cmd/+'),
  [...new Set(subscribed)].join(', '),
);

// The exact publish in `home-assistant/packages/board_game_picker.yaml`.
watcher.publish('board-game-picker/cmd/sync', '{}', { retain: false });

const answer = await answered;
ok(
  'it answers on `board-game-picker/resp/sync`',
  answer?.topic === 'board-game-picker/resp/sync',
  answer === null ? `NOTHING answered within ${ANSWER_TIMEOUT_MS}ms` : answer.topic,
);
ok(
  'the response is NOT retained — a broker replay must not re-run a nightly',
  answer?.isRetained === false,
);

if (answer === null) {
  // Nothing else can be checked, and hanging on to the broker would keep the process alive.
  service?.close();
  watcher.end(true);
  server.close();
  broker.close();
  rmSync(SCRATCH, { force: true, recursive: true });
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}

const body = JSON.parse(answer.payload) as {
  isOk?: unknown;
  failed?: unknown;
  steps?: { name: string; isOk: unknown; isSkipped: unknown; summary: unknown }[];
};

// The HA automation's own template is
// `trigger.payload_json.get('isOk', trigger.payload_json.get('ok', true)) is false`.
ok('the payload carries `isOk`, which is what HA templates on', typeof body.isOk === 'boolean');
ok('and `failed`, a count', typeof body.failed === 'number');
ok(
  'the four steps are named and ordered',
  JSON.stringify((body.steps ?? []).map((step) => step.name)) ===
    JSON.stringify(['sync-bgg', 'enrich', 'link-rulebooks', 'link-videos']),
  (body.steps ?? []).map((step) => step.name).join(' -> '),
);
ok(
  'a step nobody configured is SKIPPED, not failed',
  (body.steps ?? []).some((step) => step.isSkipped === true) && body.isOk === true,
  `failed=${String(body.failed)}`,
);

service?.close();
watcher.end(true);
server.close();
broker.close();
rmSync(SCRATCH, { force: true, recursive: true });

console.log(failures ? `\n${failures} FAILED` : '\nall green');
process.exit(failures ? 1 : 0);
