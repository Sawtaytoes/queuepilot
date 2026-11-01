import { expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({
  account: vi.fn(), audit: vi.fn(), play: vi.fn(async () => ({ played: true })),
}));
vi.mock('./env.js', async (original) => ({ ...await original<typeof import('./env.js')>(), ADB_ENABLED: false, PLAYBACK_MODE: 'client' }));
vi.mock('./playback.js', () => ({
  currentAccount: hooks.account, verifyAccount: hooks.audit, playRatingKeys: hooks.play,
  companionReady: async () => true,
}));
vi.mock('./adb.js', () => ({ usesModernPlayback: () => false, sameProfile: (a: string, b: string) => a === b }));
vi.mock('./store/db/gatedPush.js', () => ({ recordPush: vi.fn() }));
import { driveToPlaying } from './driver.js';
import { withDevice, invalidateDeviceOperations } from './deviceScope.js';
import * as profiles from './profiles.js';
const device = { id: 'test-player', name: 'Test TV', machineIdentifier: 'test-player-id', uri: 'http://192.0.2.33:32500', mode: 'client', default: false };
for (const boundary of ['preflight', 'audit'] as const) {
  it(`discards the superseded ${boundary} account response on the same player`, async () => {
    let entered = false;
    let release!: () => void;
    const held = async () => {
      entered = true;
      await new Promise<void>((r) => { release = r; });
      return { accountId: 1, title: 'Old', hasSession: true, isMismatch: false };
    };
    hooks.account.mockReset().mockImplementation(boundary === 'preflight' ? held : async () => ({ accountId: 1, title: 'Old' }));
    hooks.audit.mockReset().mockImplementation(held);
    hooks.play.mockClear();
    const pending = driveToPlaying({ ratingKeys: ['123'], requiredProfile: 'Old', accountId: 1, device });
    await vi.waitFor(() => expect(entered).toBe(true));
    invalidateDeviceOperations();
    withDevice(device, () => profiles.recordObservedProfile('Replacement'));
    release();
    expect(await pending).toEqual({ cancelled: true });
    withDevice(device, () => {
      expect(profiles.LAST_SEEN.title).toBe('Replacement');
      expect(profiles.LAST_SEEN.isObserved).toBe(true);
    });
    if (boundary === 'preflight') expect(hooks.play).not.toHaveBeenCalled();
  });
}
it('prevents all profile writers in a superseded operation from changing new evidence', async () => {
  let release!: () => void;
  const pending = withDevice(device, async () => {
    await new Promise<void>((r) => { release = r; });
    profiles.recordObservedProfile('Old');
    profiles.recordProfileClaim('Old claim');
    profiles.invalidateObservedProfile();
  });
  invalidateDeviceOperations();
  withDevice(device, () => profiles.recordObservedProfile('Replacement'));
  release();
  await pending;
  withDevice(device, () => {
    expect(profiles.LAST_SEEN.title).toBe('Replacement');
    expect(profiles.LAST_SEEN.isObserved).toBe(true);
  });
});
