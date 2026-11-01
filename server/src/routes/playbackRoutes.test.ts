import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ deviceId: 'den' as string | null }));
const device = { id: 'den', name: 'Den TV', machineIdentifier: 'den-player', uri: 'http://192.0.2.31:32500', mode: 'client', default: false, adbTarget: '192.0.2.31:5555' };
vi.mock('../devices.js', () => ({ known: (id: string) => id === 'den' ? device : null }));
vi.mock('../mqttc.js', () => ({ lastState: () => state, connected: () => true, endActivity: vi.fn(() => ({ sent: true })), play: vi.fn() }));
vi.mock('../playback.js', () => ({ transport: vi.fn(async () => ({ ok: true })), seekTo: vi.fn(async () => ({ seeked: true, offset: 12000 })), stopPlayback: vi.fn(async () => true) }));
import { playbackRoutes } from './playbackRoutes.js';
import * as playback from '../playback.js';
import * as mqttc from '../mqttc.js';
const request = (path: string, body: unknown) => playbackRoutes().request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); state.deviceId = 'den'; });
it('routes omitted control targets to the active sitting, including seek and power off', async () => {
  expect((await request('/control', { action: 'pause' })).status).toBe(200);
  expect(playback.transport).toHaveBeenCalledWith('pause', device);
  await request('/control', { action: 'seek', offset: 12000 });
  expect(playback.seekTo).toHaveBeenCalledWith(12000, { device });
  await request('/control', { action: 'power_off' });
  expect(playback.transport).toHaveBeenCalledWith('stop', device);
  expect(mqttc.endActivity).toHaveBeenCalledWith(expect.objectContaining({ target: 'den' }));
});
it('rejects unknown explicit start and control targets without changing a player', async () => {
  expect((await request('/control', { action: 'stop', target: 'missing' })).status).toBe(400);
  expect((await request('/play', { set: 'auto', target: 'missing' })).status).toBe(400);
  expect(playback.transport).not.toHaveBeenCalled();
  expect(mqttc.play).not.toHaveBeenCalled();
});
