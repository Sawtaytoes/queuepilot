// THE COLLECTION SYNC AS AN MQTT COMMAND.
//
// ── ⚠️ THE TOPIC CONTRACT DID NOT MOVE, AND MUST NOT ─────────────────────────────────────
//
//   `board-game-picker/cmd/sync`    in
//   `board-game-picker/resp/sync`   out
//   `board-game-picker/status`      retained, `{online: true/false}`
//
// Home Assistant already publishes to that command topic on a schedule and already listens on
// that response topic to decide whether to notify. The HANDLER moved from the sibling app into
// this one; the CONTRACT is what makes that invisible from the outside. Changing the base would
// mean editing an HA automation and a script in the same breath, and the automation is the
// thing that proves the move worked.
//
// The base is therefore `board-game-picker` and NOT `queuepilot`, which reads wrong and is
// right. When WP-10 retires the sibling app the base can be revisited — as its own change, with
// the HA package edited alongside it, and never as a side effect of moving code.
//
// ── HA OWNS THE SCHEDULE. THERE IS NO CRON HERE, AND NEVER MAY BE ────────────────────────
//
// The tick arrives as a message. This app decides nothing about WHEN and everything about what.
// The workspace rule is explicit: recurring work is an HA automation that publishes MQTT, and a
// TrueNAS cron job is not the timer. Do not add one, not even as a side effect of something
// else.
//
// ── `@charcuterie/server/mqtt`, not a hand-rolled client ─────────────────────────────────
//
// It is the same library the sibling app used, so the wire behaviour is identical rather than
// merely intended to be: single-flight per action (an overlapping command answers
// `{ok: false, reason: 'already-running'}` rather than queueing a second four-step sync), a
// thrown handler answering `{error, ok: false}`, and commands and responses NEVER retained —
// a broker replay must not re-run a nightly.
//
// This is separate from `mqttc.ts` / `mqttd.ts` on purpose. Those are the playback service on
// the `queuepilot/…` base; this is one app-owned job on a base it inherited. One client each is
// cheaper to reason about than one client with two topic namespaces.
import { createMqttService } from '@charcuterie/server/mqtt';

import { runCollectionSync } from './jobs/collectionSync.js';

/** Everything the broker needs, or nothing. */
export interface BoardGameMqttOptions {
  host?: string | undefined;
  base?: string | undefined;
  port?: number | undefined;
  username?: string | undefined;
  password?: string | undefined;
}

/**
 * Subscribe to the collection-sync command, if there is a broker.
 *
 * Optional in exactly the way the sibling app's was: no `MQTT_HOST` and the app runs without a
 * broker, the same way missing upstream credentials hide the sync. Returns `null` when it did
 * not start, so a caller can say so.
 */
export async function startBoardGameMqtt({
  host = process.env.MQTT_HOST,
  base = process.env.BOARD_GAME_MQTT_BASE || 'board-game-picker',
  port = Number(process.env.MQTT_PORT ?? 8883),
  username = process.env.MQTT_USER,
  password = process.env.MQTT_PASS,
}: BoardGameMqttOptions = {}): Promise<{ close: () => void } | null> {
  if (host === undefined || host.length === 0) return null;

  const mqtt = await createMqttService({ base, host, password, port, username });

  mqtt.handleCommand('sync', async () => {
    console.log(`[boardgames] ${base}/cmd/sync — starting the collection sync`);
    const result = await runCollectionSync((message) => console.log(`[boardgames] ${message}`));
    console.log(
      `[boardgames] collection sync finished — ${result.failed} step(s) failed of ${result.steps.length}`,
    );
    // The payload shape HA already reads: it templates `isOk` to decide whether to notify.
    return result;
  });

  console.log(`[boardgames] listening on ${base}/cmd/sync`);
  return mqtt;
}
