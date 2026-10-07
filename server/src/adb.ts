// Public ADB control seam. Older Android TV Plex keeps its original adapter;
// the single-activity Plex UI uses a separate, accessibility-driven adapter.
// Transport, wake/launch and profile aliases are shared, not UI navigation.
import * as legacy from './adbLegacy.js';
import { ADB_ENABLED, ADB_TARGET } from './env.js';
import type { CancelFlag, Device } from './types.js';
import { modernQueueLink, plexOwnsMediaButtons } from './plexPlaybackModern.js';
import { createModernPlexControl, isModernPlexActivity, modernSelectedProfile } from './plexControlModern.js';

export * from './adbLegacy.js';

const modern = createModernPlexControl({
  foreground: legacy.foregroundActivity,
  dump: () => legacy.run(['shell', 'uiautomator dump /sdcard/queuepilot-ui.xml >/dev/null && cat /sdcard/queuepilot-ui.xml']),
  parse: legacy.parseUiNodes,
  press: (key) => legacy.press(key, { settle: legacy.SETTLE }),
  sameProfile: legacy.sameProfile,
  playerActive: () => plexOwnsMediaButtons(legacy.run(['shell', 'dumpsys media_session'])),
  offset: async (current, target) => legacy.offsetBetween(await legacy.profileOrder(), current, target),
});

function usesModernUi(): boolean {
  return isModernPlexActivity(legacy.foregroundActivity());
}

export function usesModernPlayback(device: Device | null = null): boolean {
  if (!ADB_ENABLED || !usesModernUi()) return false;
  // ADB is configured for one physical player. Never send another player's command here.
  if (!device) return true;
  if (device.mode !== 'client' || !device.uri) return false;
  try { return new URL(device.uri).hostname === ADB_TARGET.split(':')[0]; }
  catch { return false; }
}

export async function playModernQueue(serverId: string, queueId: string | number, offsetMs: number, ratingKey: string): Promise<{ ok: boolean; error?: string }> {
  if (!usesModernPlayback()) return { ok: false, error: 'new Plex UI is not foreground' };
  if (modern.isOnboardingForeground()) return { ok: false, error: 'Plex profile setup is required on the TV' };
  const link = modernQueueLink(serverId, queueId, offsetMs, ratingKey);
  // A new scan can keep the same account while replacing a running queue. The video
  // route applies its queue/offset on mount, so leave the current player first.
  if (plexOwnsMediaButtons(legacy.run(['shell', 'dumpsys media_session']))) {
    const stopped = modernPlayerCommand('stop');
    if (!stopped.ok) return stopped;
    await new Promise<void>((resolve) => { setTimeout(resolve, 350); });
    if (!usesModernPlayback()) return { ok: false, error: 'Plex left foreground before starting the queue' };
  }
  // Link contains only validated identifiers, digits and percent-encoded URI data.
  const output = legacy.run(['shell', `am start -a android.intent.action.VIEW -p com.plexapp.android -d '${link}'`]);
  return output != null && !/Error:|Exception/.test(output)
    ? { ok: true } : { ok: false, error: 'Plex rejected the playback deep link' };
}

export function modernPlayerCommand(verb: 'stop' | 'pause' | 'play' | 'skipNext'): { ok: boolean; error?: string } {
  const dump = legacy.run(['shell', 'dumpsys media_session']);
  if (!usesModernPlayback() || !plexOwnsMediaButtons(dump)) {
    return { ok: false, error: 'Plex does not own the active player controls' };
  }
  // cmd media_session dispatch sends an unattributed event which crashes Media3 on
  // some Android TV builds. Input injects the same attributed event as a real remote.
  const key = { stop: 'KEYCODE_MEDIA_STOP', pause: 'KEYCODE_MEDIA_PAUSE', play: 'KEYCODE_MEDIA_PLAY', skipNext: 'KEYCODE_MEDIA_NEXT' }[verb];
  const output = legacy.run(['shell', `input keyevent ${key}`]);
  return output != null && !/Error:|Exception/.test(output)
    ? { ok: true } : { ok: false, error: 'Plex media control failed' };
}

export function isPickerForeground(): boolean {
  return usesModernUi() ? modern.isPickerForeground() : legacy.isPickerForeground();
}

export function isOnboardingForeground(): boolean {
  return usesModernUi() && modern.isOnboardingForeground();
}

export function selectedProfileFromXml(xml: string | null | undefined): string | null {
  return modernSelectedProfile(legacy.parseUiNodes(xml)) ?? legacy.selectedProfileFromXml(xml);
}

export function selectedProfile(): string | null {
  return usesModernUi() ? modern.selectedProfile() : legacy.selectedProfile();
}

export function pickerReady(known: string | null = null): [boolean, string | null] {
  if (!usesModernUi()) return legacy.pickerReady(known);
  const name = modern.selectedProfile();
  return [name != null, name];
}

export async function summonPicker(cancel: CancelFlag | null = null, knownCurrent: string | null = null): Promise<[string | null, boolean]> {
  return usesModernUi() ? modern.summonPicker(cancel) : legacy.summonPicker(cancel, knownCurrent);
}

export async function switchTo(target: string, cancel: CancelFlag | null = null, knownCurrent: string | null = null): Promise<[boolean, string]> {
  if (!ADB_ENABLED || !legacy.connect()) return legacy.switchTo(target, cancel, knownCurrent);
  if (!usesModernUi()) return legacy.switchTo(target, cancel, knownCurrent);
  console.log(`[adb] using the modern Plex control adapter for '${target}'`);
  return modern.switchTo(target, cancel);
}
