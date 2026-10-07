import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({ activity: '', connected: true, onboarding: true, output: '', calls: [] as unknown[][] }));
vi.mock('./env.js', async (importOriginal) => ({ ...await importOriginal<typeof import('./env.js')>(), ADB_ENABLED: true, ADB_TARGET: '192.0.2.30:5555' }));
vi.mock('./adbLegacy.js', () => ({
  foregroundActivity: () => ctl.activity,
  connect: () => ctl.connected,
  switchTo: async (...args: unknown[]) => { ctl.calls.push(['legacy', ...args]); return [true, 'legacy']; },
  isPickerForeground: () => true,
  selectedProfile: () => 'Bob',
  parseUiNodes: () => [],
  sameProfile: async () => true,
  run: (args: string[]) => { ctl.calls.push(['run', ...args]); return ctl.output; },
}));
vi.mock('./plexControlModern.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./plexControlModern.js')>(),
  createModernPlexControl: () => ({
    switchTo: async (...args: unknown[]) => { ctl.calls.push(['modern', ...args]); return [true, 'modern']; },
    isPickerForeground: () => false,
    isOnboardingForeground: () => ctl.onboarding,
    selectedProfile: () => 'Alice',
  }),
}));
import * as adb from './adb.js';

beforeEach(() => { ctl.activity = ''; ctl.connected = true; ctl.onboarding = true; ctl.output = ''; ctl.calls = []; });
describe('Plex UI adapter routing', () => {
  it('preserves the legacy switch, cancellation and profile hint for older Plex', async () => {
    ctl.activity = 'com.plexapp.android/.HomeActivityTV';
    const cancel = { isSet: () => false };
    expect(await adb.switchTo('Bob', cancel, 'Alice')).toEqual([true, 'legacy']);
    expect(ctl.calls).toEqual([['legacy', 'Bob', cancel, 'Alice']]);
    expect(adb.isOnboardingForeground()).toBe(false);
    expect(adb.selectedProfile()).toBe('Bob');
  });
  it('routes the new Plex component to its own adapter and ignores remembered selection hints', async () => {
    ctl.activity = 'com.plexapp.android/tv.plex.app.MainActivity';
    const cancel = { isSet: () => false };
    expect(await adb.switchTo('Alice', cancel, 'Bob')).toEqual([true, 'modern']);
    expect(ctl.calls).toEqual([['modern', 'Alice', cancel]]);
    expect(adb.isPickerForeground()).toBe(false);
    expect(adb.isOnboardingForeground()).toBe(true);
    expect(adb.pickerReady('Bob')).toEqual([true, 'Alice']);
  });
  it('does not mistake an unrelated MainActivity for the new Plex UI', async () => {
    ctl.activity = 'com.example.launcher/.MainActivity';
    await adb.switchTo('Bob');
    expect(ctl.calls[0]?.[0]).toBe('legacy');
    expect(adb.isOnboardingForeground()).toBe(false);
  });

  it('limits modern playback to the configured ADB player', () => {
    ctl.activity = 'com.plexapp.android/tv.plex.app.MainActivity';
    const device = { id: 'one', name: 'Test TV', machineIdentifier: 'test', uri: 'http://192.0.2.31:32500', mode: 'client', default: false };
    expect(adb.usesModernPlayback(device)).toBe(false);
    expect(adb.usesModernPlayback({ ...device, uri: 'http://192.0.2.30:32500' })).toBe(true);
    expect(adb.usesModernPlayback({ ...device, uri: null })).toBe(false);
  });

  it('leaves onboarding untouched and sends a scoped queue intent after setup', () => {
    ctl.activity = 'com.plexapp.android/tv.plex.app.MainActivity';
    expect(adb.playModernQueue('test-server', 42, 15000, '123').ok).toBe(false);
    expect(ctl.calls).toEqual([]);
    ctl.onboarding = false;
    expect(adb.playModernQueue('test-server', 42, 15000, '123').ok).toBe(true);
    expect(ctl.calls[0]?.[2]).toContain('-p com.plexapp.android');
    expect(ctl.calls[0]?.[2]).toContain('containerKey=%2FplayQueues%2F42');
  });

  it('refuses transport commands if another app owns media buttons', () => {
    ctl.activity = 'com.plexapp.android/tv.plex.app.MainActivity';
    ctl.output = 'Media button session is com.example/player';
    expect(adb.modernPlayerCommand('pause').ok).toBe(false);
    expect(ctl.calls).toEqual([['run', 'shell', 'dumpsys media_session']]);
  });

  it('injects a remote key rather than an unattributed media_session dispatch', () => {
    ctl.activity = 'com.plexapp.android/tv.plex.app.MainActivity';
    ctl.output = 'Media button session is com.plexapp.android/native\n    androidx.media3.session.id.test-123 com.plexapp.android/native';
    expect(adb.modernPlayerCommand('pause').ok).toBe(true);
    expect(ctl.calls[1]?.[2]).toBe('input keyevent KEYCODE_MEDIA_PAUSE');
  });
});
