import { AsyncLocalStorage } from 'node:async_hooks';
import { ADB_TARGET, SHIELD_IP } from './env.js';
import type { Device } from './types.js';
import { isAdbTarget } from './playbackTargets.js';

const scope = new AsyncLocalStorage<Device | null>();

/** Bind a whole operation, including its asynchronous continuations, to one player. */
export function withDevice<T>(device: Device | null, work: () => T): T {
  return scope.run(device, work);
}

export const scopedDevice = (): Device | null => scope.getStore() ?? null;
export const deviceKey = (): string => scopedDevice()?.default ? 'shield' : scopedDevice()?.id ?? 'shield';
export function deviceHost(): string | null {
  const device = scopedDevice();
  if (!device) return SHIELD_IP;
  try { return device.uri ? new URL(device.uri).hostname : null; } catch { return null; }
}

/** A foreign client without explicit ADB configuration may never use the default TV. */
export function adbTarget(): string | null {
  const device = scopedDevice();
  if (!device) return ADB_TARGET;
  if (device.adbTarget) return isAdbTarget(device.adbTarget) ? device.adbTarget : null;
  return device.mode === 'client' && deviceHost() === ADB_TARGET.split(':')[0] ? ADB_TARGET : null;
}
