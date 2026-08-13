# The MQTT cutover: `plex-channels/…` → `queuepilot/…`

The ordered procedure for moving the topic prefix without breaking the NFC cards, plus the
commands that prove each step worked. Companion to the rename decision
([`2026-08-12-plex-channels-becomes-queuepilot`](decisions/2026-08-12-plex-channels-becomes-queuepilot.md)).

**Why this needs a procedure at all:** every failure mode here is silent. A card scan publishes
to a topic nobody is subscribed to, the broker accepts the message, and nothing anywhere logs
an error. The card simply does nothing. There is no crash to notice and no log line to grep, so
the only protection is verifying each step before taking the next one.

## The mechanism

`server/src/env.js` defines two prefixes:

| Var | Default | Meaning |
| --- | --- | --- |
| `MQTT_PREFIX` | `queuepilot` | The canonical prefix. Every `T_*` topic default sits under it. |
| `MQTT_LEGACY_PREFIX` | `plex-channels` | The old prefix, kept alive as an alias. Empty = bridge off. |

While `MQTT_LEGACY_PREFIX` is set, the app **subscribes to and publishes on both prefixes at
once**:

- `mqttd.js` subscribes to all four command topics under both prefixes, folds an inbound topic
  back to its canonical form (`canonicalTopic`), and mirrors every publish — including
  **retained** ones — onto the old topic (`pub` → `legacyTopic`). So an HA automation still on
  `plex-channels/state` reads a real retained message and never sees a gap.
- `mqttc.js` (the web UI's broker client) subscribes to both prefixes for **`now-playing` only**.
  That topic is published by *Home Assistant*, so it arrives on whichever prefix HA has been
  migrated to. `state` and `devices` are published by `mqttd` in the same process, so both
  halves move on the same deploy and a legacy subscription would only deliver every message
  twice.
- The cast topics are **deliberately not bridged**. `server/src/playback.js` is the only
  publisher to `T_CMD_CAST_PLAY` and `cast_sidecar/service.py` the only subscriber; they live in
  the same container reading the same env, so they move in lockstep.

The mapping is pinned in both directions by `e2e/mqtt-legacy-bridge-test.mjs`, which runs in CI.

## Order of operations

Do these one at a time, verifying between each. **Do not bundle the MQTT step with anything
else** — it is the only step that can break the cards, and it is the only one with a staged path.

### 1. Deploy the renamed image with the bridge ON

The defaults already are the bridge-on state, so no app-env change is needed. After the
redeploy, the app is on `queuepilot/…` and the old topics are mirrored.

Confirm the bridge announced itself:

```sh
ssh root@nas.example.com 'docker logs --since 5m ix-queuepilot-queuepilot-1 2>&1 | grep -i "rename bridge\|mqttd\] connected"'
```

Expect `[mqttd] rename bridge ON — also on plex-channels/…`.

Then confirm **both** prefixes carry retained state (`-C 1` exits after one message; if it hangs,
the topic is empty and something is wrong):

```sh
set -a; source /mnt/TrueNAS-Apps/Repos/agentic/.env; set +a
mosquitto_sub -h mqtt.example.com -u "$MQTT_USER" -P "$MQTT_PASS" -t 'queuepilot/state'     -C 1 -W 10
mosquitto_sub -h mqtt.example.com -u "$MQTT_USER" -P "$MQTT_PASS" -t 'plex-channels/state' -C 1 -W 10
```

**Test a real NFC card here, before touching Home Assistant.** Nothing in HA has changed yet, so
a card that fails at this point means the bridge is wrong — roll back (below) rather than
continuing.

### 2. Migrate the Home Assistant consumers

Both prefixes work now, so HA can move at its own pace, one automation at a time. The consumer
inventory is in
[`home-assistant/docs/2026-08-12-queuepilot-rename-ha-consumer-audit.md`](../../home-assistant/docs/2026-08-12-queuepilot-rename-ha-consumer-audit.md).

Two directions to keep straight:

- Automations that **publish** commands (the NFC scanner) can be switched to `queuepilot/cmd/…`
  freely — `mqttd` is listening on both.
- Automations that **subscribe** (session bookkeeping, the announcements) can be switched to
  `queuepilot/…` freely — `mqttd` is publishing to both.

The one that is neither: the automation that publishes `now-playing`. `mqttc` subscribes to both
for exactly this reason, so it too can move whenever.

After each change, scan a card and confirm the behaviour it drives still happens.

### 3. Retire `sensor.plex_channels_status`

`DISCOVERY_OBJECT_ID` **is** the entity_id, so the rename creates a *new* entity
(`sensor.queuepilot_status`) rather than renaming the old one. The old entity stays alive off its
own retained discovery config, which is what lets both work at once.

Once every automation references the new entity, delete the old one by clearing its retained
discovery config (an empty payload is how MQTT discovery says "remove this"):

```sh
mosquitto_pub -h mqtt.example.com -u "$MQTT_USER" -P "$MQTT_PASS" \
  -t 'homeassistant/sensor/plex_channels_status/config' -r -n
```

`sensor.plex_channels_status` should disappear from HA within seconds. The name is recorded as
`DISCOVERY_LEGACY_OBJECT_ID` in `env.js` so the code and this document agree on it.

### 4. Turn the bridge off

Only after steps 2 and 3 are verified. Set `MQTT_LEGACY_PREFIX=''` in the app env and redeploy.
The old topics stop being published and stop being listened to.

Then confirm the old prefix has genuinely gone quiet — this should time out and print nothing:

```sh
mosquitto_sub -h mqtt.example.com -u "$MQTT_USER" -P "$MQTT_PASS" -t 'plex-channels/#' -W 30
```

Anything still arriving is an unmigrated publisher. Note that **retained** messages on the old
topics survive the bridge going off; clear the leftovers so a future reader isn't misled by
stale state:

```sh
for t in state now-playing resp/last-played; do
  mosquitto_pub -h mqtt.example.com -u "$MQTT_USER" -P "$MQTT_PASS" -t "plex-channels/$t" -r -n
done
```

Retained device announcements need the same treatment per id (`plex-channels/devices/shield`).

## Rolling back

The bridge is reversible at every stage, which is the point of doing it this way.

- **Mid-cutover (steps 1–2):** put `MQTT_LEGACY_PREFIX=plex-channels` back if it was cleared and
  redeploy. The old topics come alive again immediately.
- **All the way back:** set `MQTT_PREFIX=plex-channels` in the app env. The old prefix becomes
  canonical again and `legacyTopic` correctly stops aliasing a topic onto itself (covered by the
  bridge test). Note this does **not** rewrite the `T_*` defaults, which are literals under
  `queuepilot/` — so a full rollback also means setting the individual `T_*` vars, or simply
  redeploying the previous image tag, which is the cleaner escape hatch.

Keep the previous image digest to hand before starting:

```sh
ssh root@nas.example.com 'docker inspect ix-queuepilot-queuepilot-1 --format "{{.Image}}"'
```

## What is deliberately *not* renamed

- **`PLEX_CLIENT_IDENTIFIER` = `plex-channels-helper`.** The plex.tv managed-user token exchange
  is keyed on this client id; changing it makes that exchange non-repeatable. It keeps the old
  name permanently.
- **The repo directory on disk** (`/mnt/TrueNAS-Apps/Repos/plex-channels`), which several e2e
  harnesses reference by absolute path.
