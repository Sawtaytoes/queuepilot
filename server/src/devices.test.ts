import { beforeEach, expect, it, vi } from 'vitest';
const secondary = { id: 'den', name: 'Den TV', machineIdentifier: 'den-player', uri: 'http://192.0.2.31:32500', mode: 'client', default: false, adbTarget: '192.0.2.31:5555' };
vi.mock('./playbackTargets.js', () => ({ configuredPlaybackTargets: () => [secondary] }));
vi.mock('./playback.js', () => ({ playerDevices: vi.fn(async () => []) }));
import { announceDevices, known, _reset } from './devices.js';
import { playerDevices } from './playback.js';
beforeEach(() => { _reset(); vi.mocked(playerDevices).mockReset().mockResolvedValue([]); });
it('announces configured clients without discovery and preserves the default', async () => {
  const pub = vi.fn();
  await announceDevices(pub);
  expect(known('den')).toMatchObject(secondary);
  expect(known('shield')?.default).toBe(true);
  expect(known('missing')).toBeNull();
  expect(pub.mock.calls.filter((c) => typeof c[1] === 'object')).toHaveLength(2);
});
it('deduplicates a discovered configured player by machine identity', async () => {
  vi.mocked(playerDevices).mockResolvedValue([{ name: secondary.name, machineIdentifier: secondary.machineIdentifier, uri: secondary.uri }]);
  const pub = vi.fn(); await announceDevices(pub);
  expect(pub.mock.calls.filter((c) => typeof c[1] === 'object')).toHaveLength(2);
  expect(known(secondary.machineIdentifier)).toBeNull();
});
