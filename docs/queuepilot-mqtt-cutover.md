# The MQTT cutover: `plex-channels/…` → `queuepilot/…`

> **✅ COMPLETE — 2026-08-15.** All four steps are done. `MQTT_LEGACY_PREFIX` is set to `''` in
> the TrueNAS app env, the bridge is off, `sensor.plex_channels_status` is retired, and the six
> stale retained `plex-channels/…` topics were cleared and confirmed not to come back. The
> procedure below is kept as the record of how it was done and what was observed at each step —
> see [What actually happened](#what-actually-happened-2026-08-15) at the end.

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

Confirm the bridge announced itself (`$APP` is the container — still
`ix-plex-channels-plex-channels-1` until the TrueNAS app itself is renamed):

```sh
ssh root@nas.example.com 'docker logs --since 5m $(docker ps -q --filter name=plex-channels) 2>&1 \
  | grep -i "rename bridge\|mqttd\] connected"'
```

Expect `[mqttd] rename bridge ON — also on plex-channels/…`.

Then confirm **both** prefixes carry retained state. Note there is **no `mosquitto_sub` on the
TrueNAS host and no `node` there either** — the broker is also TLS on 8883, not plain 1883. The
route that works is to run inside the app container, which already has the `mqtt` module and the
credentials in its environment; it must run with `-w /app/server` or the module doesn't resolve:

```sh
ssh root@nas.example.com 'docker exec -i -w /app/server $(docker ps -q --filter name=plex-channels) node -e "
const mqtt = require(\"mqtt\");
const c = mqtt.connect({host:process.env.MQTT_HOST, port:Number(process.env.MQTT_PORT),
  protocol: Number(process.env.MQTT_PORT)===8883?\"mqtts\":\"mqtt\",
  username:process.env.MQTT_USER, password:process.env.MQTT_PASS, reconnectPeriod:0});
const seen=new Map();
c.on(\"connect\",()=>c.subscribe([\"queuepilot/#\",\"plex-channels/#\"]));
c.on(\"message\",(t,b)=>{ if(!seen.has(t)) seen.set(t,b.length); });
setTimeout(()=>{ [...seen.keys()].sort().forEach(t=>console.log(t,seen.get(t)+\"B\")); process.exit(0); },7000);
"'
```

`queuepilot/state` and `plex-channels/state` should both appear with the **same byte count** —
that is the bridge mirroring one payload onto both prefixes. Cross-check from the HA side:
`sensor.queuepilot_status` and `sensor.plex_channels_status` should both exist and update within
a few hundred milliseconds of each other.

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

Same container route as above — an empty **retained** publish:

```sh
ssh root@nas.example.com 'docker exec -i -w /app/server $(docker ps -q --filter name=plex-channels) node -e "
const mqtt = require(\"mqtt\");
const c = mqtt.connect({host:process.env.MQTT_HOST, port:Number(process.env.MQTT_PORT),
  protocol:\"mqtts\", username:process.env.MQTT_USER, password:process.env.MQTT_PASS, reconnectPeriod:0});
c.on(\"connect\",()=>c.publish(\"homeassistant/sensor/plex_channels_status/config\",\"\",
  {retain:true,qos:1},()=>{ console.log(\"cleared\"); process.exit(0); }));
"'
```

`sensor.plex_channels_status` should disappear from HA within seconds. The name is recorded as
`DISCOVERY_LEGACY_OBJECT_ID` in `env.js` so the code and this document agree on it.

### 4. Turn the bridge off

Only after steps 2 and 3 are verified. Set `MQTT_LEGACY_PREFIX=''` in the app env and redeploy.
The old topics stop being published and stop being listened to.

Then confirm the old prefix has genuinely gone quiet — this should time out and print nothing:

Re-run the listing command from step 1. **Every** surviving `plex-channels/…` topic is either an
unmigrated publisher or a stale retained message — and the two look identical in a listing, so
distinguish them: clear the topic, wait, and see whether it comes back. If it does, something is
still publishing to it.

Retained messages on the old topics survive the bridge going off, so clear the leftovers or a
future reader is misled by state nothing is maintaining:

```sh
ssh root@nas.example.com 'docker exec -i -w /app/server $(docker ps -q --filter name=queuepilot) node -e "
const mqtt = require(\"mqtt\");
const c = mqtt.connect({host:process.env.MQTT_HOST, port:Number(process.env.MQTT_PORT),
  protocol:\"mqtts\", username:process.env.MQTT_USER, password:process.env.MQTT_PASS, reconnectPeriod:0});
const dead = [];
c.on(\"connect\",()=>c.subscribe(\"plex-channels/#\"));
c.on(\"message\",(t,b)=>{ if(b.length) dead.push(t); });
setTimeout(()=>{ let n=dead.length; if(!n) { console.log(\"nothing to clear\"); process.exit(0); }
  dead.forEach(t=>c.publish(t,\"\",{retain:true,qos:1},()=>{ console.log(\"cleared\",t); if(!--n) process.exit(0); })); },7000);
"'
```

This clears **whatever is actually there**, which matters because the device registry is a
`devices/<id>` base rather than one topic — enumerating it by hand misses entries.

**Expect stale device ghosts here.** At the time of the rename `plex-channels/devices/` still
held two retained announcements, `Plex Dash` and `Pollycracker`, left by the Python service that
was deleted in #60. They are Python-shaped (`seen` field, spaced JSON) and nothing has refreshed
them since. They are not bridge artefacts and clearing them is correct — see
[the device-registry gap](#the-device-registry-gap) for why they went stale.

## The device-registry gap

Moving prefix surfaced a pre-existing bug that was **not** caused by the rename and was not
fixed by it. **Closed on 2026-08-13** by porting the sweep into `server/src/devices.js`; the
history is kept here because the failure mode is worth remembering.

`mqttd.announceDevices()` announced **only the Shield**. The plex.tv sweep that announced every
device advertising as a player lived in the Python service deleted in #60, and the Node port
never re-implemented it. Because the old announcements were *retained*, the web UI's
"Play on <device>" dropdown kept listing `Plex Dash` and `Pollycracker` afterwards — reading
ghosts off the broker, with nothing refreshing them or noticing if those devices went away.
Moving to a fresh prefix left those ghosts behind and the dropdown fell to one device, which
is how the hole was found.

What it looks like now (`server/src/devices.js`, gated by `e2e/device-registry-test.mjs`):

- every `DEVICE_ANNOUNCE_SECONDS` the announcer publishes the env-default Shield **plus** every
  plex.tv device advertising as a player, each with a `seen` unix epoch;
- a device that stops appearing in a **successful** sweep has its retained topic **cleared**
  (empty payload = de-registered, which is how `mqttc.js` already read it) — the fix had to
  include this, or it would just have minted fresh ghosts;
- a plex.tv failure announces the Shield alone, logs, and leaves the other entries retained and
  untouched: an outage is absence of information, not evidence of absence, and their `seen`
  stops advancing to say so.

The rule that produced this still stands: never "fix" the dropdown by republishing old payloads
under the new prefix — that restores the appearance of working while pointing at a registry
nothing maintains.

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

## What actually happened — 2026-08-15

Executed in the documented order, after the Hono/TypeScript server deploy (#92) went live and
its boot log still showed `[mqttd] rename bridge ON — also on plex-channels/…`.

### Step 2 was already done, but the audit doc overstated it

`home-assistant/docs/2026-08-12-queuepilot-rename-ha-consumer-audit.md` recorded all four
consumers as migrated on 2026-08-12. The live config was checked rather than trusted, and
`/config/automations.yaml` still contained **3 `plex-channels/` hits and 2
`plex_channels_status` hits**.

They turned out to be harmless — every one is prose in a `description:` field, plus the
automation's own `id: plex_channels_status_announcements` slug. The functional check is the one
that matters, and it was clean:

```
grep -E "topic: *[\"']?plex-channels/"  → no matches
grep -E "sensor\.plex_channels_status"  → only inside a description string
grep -E "topic: *[\"']?queuepilot/"     → 4 matches (the 4 live consumers)
```

Worth recording because a raw grep count reads as "migration incomplete" and would have stopped
the cutover for no reason. Count the *functional* references, not the string.

### Step 3 — retiring `sensor.plex_channels_status`

Both sensors were live and updating **4 ms apart**, which is the bridge mirroring one payload
onto both prefixes. Clearing the retained discovery config removed the old entity within
seconds; `sensor.queuepilot_status` was unaffected.

### Step 4 — bridge off

`MQTT_LEGACY_PREFIX=""` appended to the app's 17 existing env vars via `app.update` (the var was
**not** previously present — the bridge was on by the code's default in `env.ts`, so there was
nothing to edit, only something to add). After the redeploy the `rename bridge ON` line is gone
from the boot log.

Six stale retained topics survived on the old prefix, exactly as this document predicted:

```
plex-channels/state · plex-channels/now-playing · plex-channels/resp/last-played
plex-channels/devices/shield · plex-channels/devices/0e072bfb-… · plex-channels/devices/606c3173-…
```

They were confirmed stale before clearing: `plex-channels/now-playing` was **173 B** against
`queuepilot/now-playing`'s **166 B** — a different, older payload, i.e. no longer being mirrored.
All six were cleared, and a re-listing 12 s later reported `LEGACY topics still live: NONE`,
which is the "clear it and see whether it comes back" test this document asks for.

The two `devices/<uuid>` entries are the `Plex Dash` / `Pollycracker` ghosts described under
[the device-registry gap](#the-device-registry-gap) — they had been mirrored onto the new prefix
too, so clearing the legacy copies left the `queuepilot/devices/…` ones untouched and the
dropdown unchanged.

### Why the cards were never at risk

HA has been publishing to `queuepilot/cmd/session/start` since 2026-08-12 and the cards have
worked since. Turning the bridge off removes only the *alias* subscription, which by then had no
publisher. That is the whole point of the staged path: by step 4 the old prefix is already dead
weight, so the step that could break the cards is the one where nothing is left to break.

### Still outstanding

`DISCOVERY_LEGACY_OBJECT_ID` and the `legacyTopic`/`bothTopics`/`canonicalTopic` helpers in
`server/src/env.ts`, plus `e2e/mqtt-legacy-bridge-test.ts`, are now dead code paths kept behind
an empty prefix. Removing them is a separate change — the bridge should sit provably unused for
a while before the ability to re-enable it is deleted.
