vi.mock('./mqttc.js', () => ({ lastState: () => null, onNowPlaying: vi.fn(), offNowPlaying: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
vi.mock('./env.js', async (original) => ({ ...await original<typeof import('./env.js')>(), ADB_ENABLED: true, ADB_TARGET: '192.0.2.30:5555', SHIELD_IP: '192.0.2.30' }));
vi.mock('node:child_process', () => ({ spawnSync: vi.fn((_bin: string, args: string[]) => ({
  status: 0, stdout: args.some((a) => a.includes('dumpsys window'))
    ? 'mCurrentFocus=Window{abc u0 com.plexapp.android/tv.plex.app.MainActivity}'
    : args.some((a) => a.includes('dumpsys media_session')) ? 'Media button session is com.plexapp.android/player'
    : args.includes('get-state') ? 'device' : '', stderr: '',
})) }));
import { adbTarget, withDevice } from './deviceScope.js';
import * as legacy from './adbLegacy.js';
import * as profiles from './profiles.js';
import * as playback from './playback.js';
import { startSession } from './session.js';
import type { Device } from './types.js';
const second: Device = { id: 'den', name: 'Den TV', machineIdentifier: 'den-player', uri: 'http://192.0.2.31:32500', mode: 'client', default: false, adbTarget: '192.0.2.31:5555' };
beforeEach(() => { vi.clearAllMocks(); });
describe('device control isolation', () => {
  it('refuses an unknown start target before opening any device', async () => {
    expect(await startSession({ set: 'unused', target: 'missing-device' })).toEqual({ error: "unknown device 'missing-device'" });
    expect(spawnSync).not.toHaveBeenCalled();
  });
  it('preserves the default and separates overlapping asynchronous operations', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = withDevice(second, async () => { await gate; legacy.run(['shell', 'getprop ro.product.model']); return adbTarget(); });
    const other = withDevice(null, async () => { legacy.run(['shell', 'getprop ro.product.model']); await Promise.resolve(); return adbTarget(); });
    release();
    expect(await first).toBe('192.0.2.31:5555');
    expect(await other).toBe('192.0.2.30:5555');
    expect(vi.mocked(spawnSync).mock.calls.map((c) => c[1]?.[1])).toEqual(['192.0.2.30:5555', '192.0.2.31:5555']);
  });
  it('issues no subprocess for a foreign client without explicit ADB configuration', () => {
    withDevice({ ...second, adbTarget: undefined }, () => {
      expect(legacy.connect()).toBe(false);
      expect(legacy.run(['shell', 'input keyevent KEYCODE_MEDIA_STOP'])).toBeNull();
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });
  it('does not reuse a default-room profile observation on the secondary player', () => {
    profiles.recordObservedProfile('Ada');
    withDevice(second, () => {
      expect(profiles.LAST_SEEN.title).toBeNull();
      expect(profiles.isObservationFresh()).toBe(false);
      profiles.recordProfileClaim('Grace');
    });
    expect(profiles.LAST_SEEN.title).toBe('Ada');
    withDevice(second, () => expect(profiles.LAST_SEEN.isObserved).toBe(false));
  });
  it('routes each direct modern transport command to the chosen player', async () => {
    for (const action of ['pause', 'resume', 'next', 'stop'] as const) {
      expect(await playback.transport(action, second)).toEqual({ ok: true });
    }
    const calls = vi.mocked(spawnSync).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c[1]?.[1] === '192.0.2.31:5555')).toBe(true);
    expect(calls.filter((c) => String(c[1]?.[3]).startsWith('input keyevent')).map((c) => c[1]?.[3])).toEqual([
      'input keyevent KEYCODE_MEDIA_PAUSE', 'input keyevent KEYCODE_MEDIA_PLAY', 'input keyevent KEYCODE_MEDIA_NEXT', 'input keyevent KEYCODE_MEDIA_STOP',
    ]);
  });
});
