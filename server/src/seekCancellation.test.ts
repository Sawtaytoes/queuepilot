import { expect, it, vi } from 'vitest';
const ctl = vi.hoisted(() => ({ hold: false, release: null as ((text: string) => void) | null }));
const queue = { MediaContainer: { playQueueID: 77, size: 1, playQueueSelectedItemOffset: 0, Metadata: [{ ratingKey: '123' }] } };
vi.mock('undici', async (original) => ({
  ...await original<typeof import('undici')>(),
  request: vi.fn(async (url: string, options: { method: string }) => ({ statusCode: 200, body: { text: async () => {
    if (options.method === 'POST') return JSON.stringify({ MediaContainer: { playQueueID: 77, size: 1 } });
    if (url.includes('/playQueues/')) {
      if (ctl.hold) { ctl.hold = false; return new Promise<string>((r) => { ctl.release = r; }); }
      return JSON.stringify(queue);
    }
    return JSON.stringify({ MediaContainer: { Metadata: [{ ratingKey: '123', viewOffset: 1000, Player: { machineIdentifier: 'den-player', title: 'Den TV' } }] } });
  } } })),
}));
vi.mock('./adb.js', () => ({ usesModernPlayback: () => true, modernPlayerCommand: vi.fn(() => ({ ok: true })), playModernQueue: vi.fn(async () => ({ ok: true })) }));
import * as adb from './adb.js';
import * as playback from './playback.js';
import { invalidateDeviceOperations } from './deviceScope.js';
it('issues no stop or launch when a replacement sitting arrives during a seek read', async () => {
  await playback.createPlayQueue(['123'], { token: 'fixture', host: 'http://192.0.2.10:32400', machineIdentifier: 'fixture-server' });
  ctl.hold = true;
  const pending = playback.seekTo(12000, { device: { id: 'den', name: 'Den TV', machineIdentifier: 'den-player', uri: 'http://192.0.2.31:32500', mode: 'client', default: false }, playQueueID: 77 });
  await vi.waitFor(() => expect(ctl.release).not.toBeNull());
  invalidateDeviceOperations();
  ctl.release!(JSON.stringify(queue));
  expect((await pending).seeked).toBe(false);
  expect(adb.modernPlayerCommand).not.toHaveBeenCalled();
  expect(adb.playModernQueue).not.toHaveBeenCalled();
});
