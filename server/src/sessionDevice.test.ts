import { afterEach, expect, it, vi } from 'vitest';
import { SESSION, advanceSession } from './session.js';
import * as playback from './playback.js';
import type { Device } from './types.js';
const device: Device = { id: 'den', name: 'Den TV', machineIdentifier: 'den-player', uri: 'http://192.0.2.31:32500', mode: 'client', default: false, adbTarget: '192.0.2.31:5555' };
afterEach(() => { vi.restoreAllMocks(); SESSION.device = null; SESSION.queue = []; SESSION.cursor = 0; SESSION.set = null; SESSION.userUuid = null; });
it('advances on the sitting’s selected device and publishes its identity separately from length', async () => {
  SESSION.device = device;
  SESSION.set = 'grace-shows';
  SESSION.userUuid = 'grace-profile';
  SESSION.queue = [{ ratingKey: '123' }, { ratingKey: '124' }];
  SESSION.target = 8;
  const send = vi.spyOn(playback, 'playRatingKeys').mockResolvedValue({ played: true });
  await advanceSession();
  expect(send).toHaveBeenCalledWith([{ ratingKey: '124' }], { setName: 'grace-shows', offset: 0, userUuid: 'grace-profile', device });
  expect(SESSION.asDict().deviceId).toBe('den');
  expect(SESSION.target).toBe(8);
});
