// Plex's new Android TV UI keeps Home, menus, picker and player in MainActivity.
// Activity changes no longer prove navigation: inspect resource IDs and focus.
import { ADB_MAX_PRESSES, ADB_PICKER_WAIT_SECONDS } from './env.js';
import { isCancelled } from './errors.js';
import type { CancelFlag } from './types.js';

type Node = Record<string, string>;
const ACCOUNT = 'primary-navigation-account';
const SWITCH = 'secondary-navigation-account-switch-user';
const TILE = /^switch-user-item-(\d+)$/;
export const PLEX_SETUP_REQUIRED = 'Plex setup required: finish this profile’s onboarding on the TV, then scan again.';

export function isModernPlexOnboarding(nodes: Node[]): boolean {
  return nodes.some((node) => node['resource-id']?.startsWith('whats-new-onboarding-'))
    || (nodes.some((node) => node['resource-id'] === 'screen-all-libraries')
      && nodes.some((node) => node['content-desc'] === 'Continue'));
}

export function isModernPlexActivity(activity: string | null | undefined): boolean {
  return activity === 'com.plexapp.android/tv.plex.app.MainActivity';
}

function decode(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function tiles(nodes: Node[]): Node[] {
  return nodes.filter((node) => TILE.test(node['resource-id'] || '') && node['content-desc']?.trim());
}

export function modernSelectedProfile(nodes: Node[]): string | null {
  const focused = tiles(nodes).filter((node) => node.focused === 'true');
  return focused.length === 1 ? decode(focused[0]?.['content-desc'] || '').trim() || null : null;
}

export interface ModernPlexIo {
  foreground(): string | null;
  dump(): string | null;
  parse(xml: string | null): Node[];
  press(key: string): Promise<boolean>;
  sameProfile(current: string, target: string): Promise<boolean>;
  offset(current: string, target: string): Promise<number | null>;
  playerActive?(): boolean;
  sleep?(ms: number): Promise<void>;
}

export function createModernPlexControl(io: ModernPlexIo, options: { maxPresses?: number; waitSeconds?: number } = {}) {
  const maxPresses = options.maxPresses ?? ADB_MAX_PRESSES;
  const waitMs = (options.waitSeconds ?? ADB_PICKER_WAIT_SECONDS) * 1000;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));

  function read(): Node[] | null {
    if (!isModernPlexActivity(io.foreground())) return null;
    const xml = io.dump();
    // A human may leave Plex while uiautomator waits for an idle window.
    if (!xml || !isModernPlexActivity(io.foreground())) return null;
    return io.parse(xml);
  }

  function isPickerForeground(): boolean {
    const nodes = read();
    return nodes != null && tiles(nodes).length > 0;
  }

  function selectedProfile(): string | null {
    const nodes = read();
    return nodes ? modernSelectedProfile(nodes) : null;
  }

  function isOnboardingForeground(): boolean {
    const nodes = read();
    return nodes != null && isModernPlexOnboarding(nodes);
  }

  async function guardedPress(key: string, cancel: CancelFlag | null, guard: (nodes: Node[]) => boolean, justRead: Node[] | null = null): Promise<boolean> {
    if (isCancelled(cancel)) return false;
    // Menu decisions are synchronous with their dump. Reuse that fresh tree instead of
    // waiting for a second idle-window dump; account alias lookups still require a re-read.
    const nodes = justRead ?? read();
    if (!isModernPlexActivity(io.foreground())) return false;
    if (!nodes || !guard(nodes) || isCancelled(cancel)) return false;
    return io.press(key);
  }

  async function summonPicker(cancel: CancelFlag | null = null): Promise<[string | null, boolean]> {
    const deadline = Date.now() + waitMs;
    let presses = 0;
    let backs = 0;
    while (Date.now() < deadline && presses < maxPresses) {
      if (isCancelled(cancel)) return [null, false];
      const nodes = read();
      if (!nodes) return [null, false];
      if (isModernPlexOnboarding(nodes)) return [null, false];
      if (tiles(nodes).length) {
        const selected = modernSelectedProfile(nodes);
        if (selected) return [selected, true];
        // On a fresh launch React Native can expose the picker before assigning focus.
        // Acquire it with a direction key; CENTER still requires a named focused tile.
        if (!(await guardedPress('KEYCODE_DPAD_LEFT', cancel,
          (live) => tiles(live).length > 0 && !modernSelectedProfile(live), nodes))) return [null, false];
        presses += 1;
        await sleep(350);
        continue;
      }
      const focus = nodes.find((node) => node.focused === 'true');
      const id = focus?.['resource-id'] || '';
      let key: string;
      if (id === SWITCH) key = 'KEYCODE_DPAD_CENTER';
      else if (id === ACCOUNT) key = 'KEYCODE_DPAD_RIGHT';
      else if (id.startsWith('primary-navigation-') || id.startsWith('secondary-navigation-account-')) key = 'KEYCODE_DPAD_UP';
      else if (nodes.some((node) => node['resource-id'] === 'screen-home')) {
        // Back from the player can leave focus in the narrow, collapsed navigation rail.
        const rightEdge = Number(focus?.bounds?.match(/^\[\d+,\d+\]\[(\d+),\d+\]$/)?.[1]);
        key = rightEdge > 0 && rightEdge <= 32 ? 'KEYCODE_DPAD_RIGHT' : 'KEYCODE_DPAD_LEFT';
      }
      else if (io.playerActive?.() && nodes.every((node) => !node.text && !node['content-desc']
        && (!node['resource-id'] || ['android:id/content', 'com.plexapp.android:id/action_bar_root'].includes(node['resource-id'])))) {
        // Protected video exposes only blank root nodes. The active Plex media session
        // identifies this screen; a PIN/onboarding/unknown dialog has visible controls.
        key = 'KEYCODE_MEDIA_STOP';
      }
      else if (nodes.some((node) => node['resource-id']?.startsWith('screen-')) && backs < 3) {
        key = 'KEYCODE_BACK';
        backs += 1;
      } else {
        // Unknown screens (including onboarding/PIN dialogs) receive no input.
        return [null, false];
      }
      console.log(`[adb] modern menu focus '${id || 'content'}': ${key}`);
      if (!(await guardedPress(key, cancel, (live) => !tiles(live).length
        && (key !== 'KEYCODE_MEDIA_STOP' || io.playerActive?.() === true)
        && live.find((node) => node.focused === 'true')?.['resource-id'] === focus?.['resource-id'], nodes))) return [null, false];
      presses += 1;
      await sleep(350);
    }
    return [null, false];
  }

  async function switchTo(target: string, cancel: CancelFlag | null = null): Promise<[boolean, string]> {
    const deadline = Date.now() + waitMs;
    const [name] = await summonPicker(cancel);
    if (!name) {
      const live = read();
      return [false, live && isModernPlexOnboarding(live) ? PLEX_SETUP_REQUIRED : 'could not open the modern Plex profile picker'];
    }
    for (let presses = 0; presses <= maxPresses && Date.now() < deadline; presses += 1) {
      if (isCancelled(cancel)) return [false, 'cancelled by a newer scan'];
      const nodes = read();
      const current = nodes && modernSelectedProfile(nodes);
      if (!nodes || !current) return [false, 'the modern Plex picker lost its focused profile'];
      if (await io.sameProfile(current, target)) {
        // Re-read the exact tile before CENTER; a remembered profile is never proof.
        if (!(await guardedPress('KEYCODE_DPAD_CENTER', cancel, (live) => modernSelectedProfile(live) === current))) return [false, 'profile selection changed before commit'];
        const commitDeadline = Math.min(deadline, Date.now() + 8000);
        while (Date.now() < commitDeadline) {
          if (isCancelled(cancel)) return [false, 'cancelled by a newer scan'];
          const live = read();
          if (live && isModernPlexOnboarding(live)) return [false, PLEX_SETUP_REQUIRED];
          // Require a signed-in navigation screen, not merely disappearance of the tiles.
          // A PIN prompt, launcher, unreadable dump or onboarding is not a successful pick.
          if (live && !tiles(live).length && live.some((node) => node['resource-id'] === 'screen-home'
            || node['resource-id'] === 'primary-navigation-home')) {
            console.log(`[adb] modern picker committed '${current}'; signed-in navigation is visible`);
            return [true, `selected '${current}' on the modern picker`];
          }
          await sleep(350);
        }
        return [false, `Plex did not accept '${current}' into its signed-in navigation`];
      }
      if (presses === maxPresses) break;
      const focused = tiles(nodes).find((node) => node.focused === 'true');
      const currentIndex = Number(focused?.['resource-id']?.match(TILE)?.[1]);
      let step: number | null = null;
      for (const tile of tiles(nodes)) {
        if (await io.sameProfile(decode(tile['content-desc'] || '').trim(), target)) {
          step = Number(tile['resource-id']?.match(TILE)?.[1]) - currentIndex;
          break;
        }
      }
      // Off-screen targets use the Home roster only as a direction hint. Read back after
      // ONE press, so differences in picker order cannot commit the wrong account.
      step ??= await io.offset(current, target);
      if (!step) return [false, `'${target}' is not reachable in the modern Plex picker`];
      const key = step > 0 ? 'KEYCODE_DPAD_RIGHT' : 'KEYCODE_DPAD_LEFT';
      if (!(await guardedPress(key, cancel, (live) => modernSelectedProfile(live) === current))) return [false, 'the modern Plex picker changed before navigation'];
      await sleep(350);
      if (selectedProfile() === current) return [false, `the modern Plex picker did not move from '${current}'`];
    }
    return [false, `modern Plex profile switch exceeded its bounded navigation budget for '${target}'`];
  }

  return { isPickerForeground, isOnboardingForeground, selectedProfile, summonPicker, switchTo };
}
