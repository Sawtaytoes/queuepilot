import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ deviceId: 'den' as string | null, set: 'original-queue' }));
const device = { id: 'den', name: 'Den TV', machineIdentifier: 'den-player', uri: 'http://192.0.2.31:32500', mode: 'client', default: false, adbTarget: '192.0.2.31:5555' };
vi.mock('../devices.js', () => ({ known: (id: string) => id === 'den' ? device : null }));
vi.mock('../mqttc.js', () => ({ lastState: () => state, connected: () => true, endActivity: vi.fn(() => ({ sent: true })), play: vi.fn() }));
vi.mock('../playback.js', () => ({ transport: vi.fn(async () => ({ ok: true })), seekTo: vi.fn(async () => ({ seeked: true, offset: 12000 })), stopPlayback: vi.fn(async () => true) }));
import { playbackRoutes } from './playbackRoutes.js';
import * as playback from '../playback.js';
import * as mqttc from '../mqttc.js';
import { invalidateDeviceOperations } from '../deviceScope.js';
const request = (path: string, body: unknown) => playbackRoutes().request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); state.deviceId = 'den'; state.set = 'original-queue'; });
it('routes omitted control targets to the active sitting, including seek and power off', async () => {
  expect((await request('/control', { action: 'pause' })).status).toBe(200);
  expect(playback.transport).toHaveBeenCalledWith('pause', device);
  await request('/control', { action: 'seek', offset: 12000 });
  expect(playback.seekTo).toHaveBeenCalledWith(12000, { device });
  await request('/control', { action: 'power_off' });
  expect(playback.transport).toHaveBeenCalledWith('stop', device);
  expect(mqttc.endActivity).toHaveBeenCalledWith(expect.objectContaining({ target: 'den' }));
});
it('suppresses activity off when the sitting is replaced while stop is pending', async () => {
  let release!: () => void;
  let entered = false;
  vi.mocked(playback.transport).mockImplementationOnce(async () => {
    entered = true;
    await new Promise<void>((r) => { release = r; });
    return { ok: false, error: 'playback operation was replaced' };
  });
  const pending = request('/control', { action: 'power_off' });
  await vi.waitFor(() => expect(entered).toBe(true));
  invalidateDeviceOperations();
  state.set = 'replacement-queue';
  release();
  expect((await pending).status).toBe(409);
  expect(mqttc.endActivity).not.toHaveBeenCalled();
});
it('keeps the original queue in an activity-off request after an ordinary failed stop', async () => {
  vi.mocked(playback.transport).mockImplementationOnce(async () => {
    state.set = 'later-retained-state';
    return { ok: false, error: 'unreachable' };
  });
  expect((await request('/control', { action: 'power_off' })).status).toBe(200);
  expect(mqttc.endActivity).toHaveBeenCalledWith({ set: 'original-queue', target: 'den' });
});
it('rejects unknown explicit start and control targets without changing a player', async () => {
  expect((await request('/control', { action: 'stop', target: 'missing' })).status).toBe(400);
  expect((await request('/play', { set: 'auto', target: 'missing' })).status).toBe(400);
  expect(playback.transport).not.toHaveBeenCalled();
  expect(mqttc.play).not.toHaveBeenCalled();
});
