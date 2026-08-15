// The device registry — the "Play on ▾" dropdown's source, and what a start command's
// `target` id resolves against.
//
// Retained `queuepilot/devices/<id>` announcements: the env-default Shield (always present,
// so an empty/unreachable plex.tv never leaves the dropdown blank) plus every plex.tv device
// advertising as a player. Re-announced every DEVICE_ANNOUNCE_SECONDS by mqttd.
//
// Why this module exists: the sweep lived in the Python service deleted in #60 and the Node
// port only ever announced the Shield. Because the announcements are RETAINED, nobody
// noticed — the dropdown kept listing `Plex Dash` and `Pollycracker` off the broker as
// ghosts, refreshed by nothing and de-registered by nothing, until the queuepilot rename
// moved the prefix and left them behind (docs/queuepilot-mqtt-cutover.md, "The
// device-registry gap"). This is the port of `queue_builder/service.py`'s `_build_devices` /
// `announce_devices`, so the registry is genuinely live rather than genuinely stale.
//
// Kept out of mqttd.js so it can be tested with no broker: `announceDevices` takes the
// publish function as an argument.
import { playerDevices } from './playback.js';
import type { PlayerDevice } from './playback.js';
import type { Device } from './types.js';
import { errMessage } from './errors.js';
import {
  T_DEVICES_BASE,
  PLAYBACK_MODE,
  SHIELD_CLIENT_NAME,
  SHIELD_CLIENT_MACHINE_ID,
  SHIELD_CLIENT_URI,
} from './env.js';

export const DEFAULT_ID = 'shield';

/**
 * What actually goes on the wire, which is `Device` with the two identity fields widened.
 *
 * `Device` in types.ts declares `name` and `machineIdentifier` as plain strings, and that
 * holds for `shieldEntry()` — but NOT for the plex.tv branch below, which copies
 * `playerDevices()`'s row through verbatim and a plex.tv row may carry a null for either.
 * (Only ONE of the two has to be present: `id` is `machineIdentifier || name`, and a row
 * with neither is skipped.) So the announced shape is the wider one, and narrowing it to
 * `Device` here would be a claim the sweep cannot make. Reported, not fixed.
 */
type AnnouncedDevice = Omit<Device, 'name' | 'machineIdentifier'> & {
  name: string | null;
  machineIdentifier: string | null;
};

/** An announced device once the round's `seen` stamp is on it — the retained payload. */
type RetainedDevice = AnnouncedDevice & { seen: number };

/** mqttd's publisher. It mirrors onto the legacy prefix, which is why devices.ts publishes
 * THROUGH it rather than touching the client itself. */
type Publish = (topic: string, payload: unknown, opts?: { retain?: boolean }) => void;

// id -> the payload currently RETAINED on the broker for that id. Mirrors broker state, so
// the diff against the next sweep says exactly which topics have to be cleared.
const REGISTRY = new Map<string, RetainedDevice>();

/**
 * Resolve a start command's `target` id to its announced device entry, or null.
 * Unknown/absent ids fall back to the env-default Shield at the call site, exactly as the
 * Python service did — an id that aged out must not fail the scan.
 */
export const known = (id: string | null | undefined): RetainedDevice | null => (
  REGISTRY.get(String(id ?? '')) || null
);

/** Test seam: forget what we believe is retained on the broker. */
export const _reset = (): void => REGISTRY.clear();

// The env-default Shield. Always announced, always `default: true`, never de-registered —
// it is the target every card scan uses when no `target` is given.
function shieldEntry(): AnnouncedDevice {
  return {
    id: DEFAULT_ID,
    name: SHIELD_CLIENT_NAME,
    // env.js (not process.env directly) so the /config host-config layer is honoured —
    // reading process.env here meant a deploy that set these in config.yaml announced a
    // Shield with no machine id.
    machineIdentifier: SHIELD_CLIENT_MACHINE_ID || '',
    uri: SHIELD_CLIENT_URI || null,
    mode: PLAYBACK_MODE || 'client',
    default: true,
  };
}

// Fold a plex.tv row into the Shield entry when it IS the Shield, rather than listing the
// same player twice (once as the default, once not) — and let it fill in the machine id / uri
// the env didn't provide.
function isShield(row: PlayerDevice, shield: AnnouncedDevice): boolean {
  if (SHIELD_CLIENT_MACHINE_ID && row.machineIdentifier === SHIELD_CLIENT_MACHINE_ID) return true;
  const rowName = String(row.name || '').trim().toLowerCase();
  return Boolean(rowName) && rowName === String(shield.name || '').trim().toLowerCase();
}

/**
 * Publish one round of the registry.
 *
 * @param {(topic: string, payload: unknown, opts?: object) => void} pub mqttd's publisher —
 *   it mirrors onto the legacy prefix, so the registry crosses the rename bridge like
 *   everything else.
 *
 * Never throws and never rejects: this runs on an interval, and an unhandled rejection there
 * would take the announcer (and the process's exit code) with it.
 */
export async function announceDevices(pub: Publish): Promise<void> {
  try {
    // One timestamp for the whole round, so every entry announced together reads as one sweep.
    const seen = Math.floor(Date.now() / 1000);
    const shield = shieldEntry();
    const next = new Map<string, AnnouncedDevice>([[shield.id, shield]]);

    let swept = false;
    try {
      for (const row of await playerDevices()) {
        const id = row.machineIdentifier || row.name;
        if (!id) continue;
        if (isShield(row, shield)) {
          shield.machineIdentifier = shield.machineIdentifier || row.machineIdentifier || '';
          shield.uri = shield.uri || row.uri || null;
          continue;
        }
        next.set(id, {
          id,
          name: row.name,
          machineIdentifier: row.machineIdentifier,
          uri: row.uri,
          // plex.tv players are driven over Companion playMedia; cast is the Shield's own
          // sidecar path and is not something we can infer for a foreign device.
          mode: 'client',
          default: false,
        });
      }
      swept = true;
    } catch (e) {
      // A plex.tv hiccup degrades to "the Shield only" for THIS round — the Shield is
      // env-configured and needs no network to announce, so card scans keep working.
      console.log(`[devices] plex.tv enumeration failed: ${errMessage(e)}`);
    }

    // De-registration: mqttc.js treats an EMPTY retained payload as "this device is gone"
    // (`if (!text) DEVICES.delete(id)`), so a device that stops appearing must have its topic
    // cleared or it becomes exactly the ghost this whole module exists to end.
    //
    // Only a SUCCESSFUL sweep may de-register. A failed sweep is absence of information, not
    // evidence of absence — and a device with a `uri` stays directly playable over Companion
    // while plex.tv is down, so dropping it from the dropdown would remove a capability that
    // still works. Its entry is left retained and untouched, which means its `seen` stops
    // advancing: that is what `seen` is FOR (this is the one place we diverge from the Python
    // original, which cleared the topics on a failed enumeration and flapped the dropdown).
    if (swept) {
      for (const gone of REGISTRY.keys()) {
        if (next.has(gone)) continue;
        pub(`${T_DEVICES_BASE}/${gone}`, '', { retain: true });
        REGISTRY.delete(gone);
      }
    }

    // `seen` is a unix epoch, kept from the Python payloads: it is the only thing that lets a
    // consumer age out a device whose announcement stopped being refreshed, and dropping it
    // would have made the retained registry indistinguishable from the stale one again. The
    // Shield carries it too — a registry where one entry has no freshness stamp is one every
    // consumer has to special-case.
    for (const [id, device] of next) {
      const payload: RetainedDevice = { ...device, seen };
      pub(`${T_DEVICES_BASE}/${id}`, payload, { retain: true });
      REGISTRY.set(id, payload);
    }
  } catch (e) {
    console.log(`[devices] announce failed: ${e instanceof Error && e.stack ? e.stack : String(e)}`);
  }
}
