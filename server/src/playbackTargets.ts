import { hostdata } from './hostConfig.js';
import type { Device } from './types.js';

/** ADB serials are explicit deployment settings, never inferred from arbitrary clients. */
export function isAdbTarget(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*:[0-9]{1,5}$/.test(value)) return false;
  const port = Number(value.split(':')[1]);
  return port > 0 && port <= 65535;
}

export function parsePlaybackTargets(value: unknown): Device[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('playback_targets must be an array');
  const ids = new Set(['shield']);
  const machines = new Set<string>();
  return value.map((row: unknown) => {
    if (!row || typeof row !== 'object') throw new Error('invalid playback target');
    const r = row as Record<string, unknown>;
    if (typeof r.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(r.id) || ids.has(r.id)) throw new Error('invalid or duplicate playback target id');
    if (typeof r.name !== 'string' || !r.name.trim()) throw new Error(`playback target ${r.id} needs a name`);
    if (typeof r.uri !== 'string') throw new Error(`playback target ${r.id} needs a uri`);
    const uri = new URL(r.uri);
    if (!['http:', 'https:'].includes(uri.protocol) || uri.username || uri.password || uri.pathname !== '/' || uri.search || uri.hash) throw new Error(`invalid playback target uri for ${r.id}`);
    if (r.adb_target != null && !isAdbTarget(r.adb_target)) throw new Error(`invalid adb_target for ${r.id}`);
    if (r.adb_target && String(r.adb_target).split(':')[0] !== uri.hostname) throw new Error(`adb_target and uri must name the same player for ${r.id}`);
    const machine = typeof r.machine_identifier === 'string' ? r.machine_identifier : '';
    if (machine && machines.has(machine)) throw new Error('duplicate playback target machine identifier');
    ids.add(r.id);
    if (machine) machines.add(machine);
    return { id: r.id, name: r.name, uri: uri.origin, machineIdentifier: machine,
      mode: 'client', default: false, ...(r.adb_target ? { adbTarget: String(r.adb_target) } : {}) };
  });
}

export const configuredPlaybackTargets = (): Device[] => parsePlaybackTargets(hostdata('playback_targets'));
