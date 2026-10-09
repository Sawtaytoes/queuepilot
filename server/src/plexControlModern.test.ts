import { describe, expect, it } from 'vitest';
import { parseUiNodes } from './adbLegacy.js';
import { createModernPlexControl, isModernPlexActivity, isModernPlexOnboarding, modernSelectedProfile, PLEX_SETUP_REQUIRED } from './plexControlModern.js';

const ACTIVITY = 'com.plexapp.android/tv.plex.app.MainActivity';
type Node = Record<string, string>;
const node = (id: string, focused = false, name = ''): Node => ({ 'resource-id': id, focused: String(focused), 'content-desc': name });
const picker = (names: string[], selected: number): Node[] => names.map((name, index) => node(`switch-user-item-${index}`, index === selected, name));
const home = (): Node[] => [node('screen-home'), node('primary-navigation-home', true)];

function harness(initial: Node[], onPress: (key: string, nodes: Node[]) => Node[] = (_key, nodes) => nodes) {
  let nodes = initial;
  let activity: string | null = ACTIVITY;
  let cancelled = false;
  let playerActive = false;
  let offset = 1;
  const keys: string[] = [];
  const batches: { key: string; count: number }[] = [];
  let dumps = 0;
  let beforeDump: (() => void) | undefined;
  const control = createModernPlexControl({
    foreground: () => activity,
    dump: () => { dumps += 1; beforeDump?.(); return JSON.stringify(nodes); },
    parse: (xml) => JSON.parse(xml || '[]') as Node[],
    press: async (key, count = 1) => {
      batches.push({ key, count });
      for (let i = 0; i < count; i += 1) { keys.push(key); nodes = onPress(key, nodes); }
      return true;
    },
    sameProfile: async (current, target) => current.toLowerCase() === target.toLowerCase()
      || (current === 'Bob Smith' && target === 'bob'),
    offset: async () => offset,
    playerActive: () => playerActive,
    sleep: async () => {},
  }, { maxPresses: 4, waitSeconds: 0.03 });
  return {
    control, keys, batches, dumpCount: () => dumps, cancel: { isSet: () => cancelled },
    setOffset: (next: number) => { offset = next; },
    setNodes: (next: Node[]) => { nodes = next; },
    setActivity: (next: string | null) => { activity = next; },
    cancelNow: () => { cancelled = true; },
    setPlayerActive: (active: boolean) => { playerActive = active; },
    beforeDump: (hook: () => void) => { beforeDump = hook; },
  };
}

describe('modern Plex control adapter', () => {
  it('detects the new Plex component without matching a launcher or old Plex', () => {
    expect(isModernPlexActivity(ACTIVITY)).toBe(true);
    expect(isModernPlexActivity('com.google.android.tvlauncher/.MainActivity')).toBe(false);
    expect(isModernPlexActivity('com.plexapp.android/.HomeActivityTV')).toBe(false);
    expect(isModernPlexActivity(null)).toBe(false);
  });

  it('reads focused profile tiles, decodes XML, and ignores unrelated focus/selection', () => {
    const xml = '<hierarchy><node resource-id="switch-user-item-1" focused="true" selected="false" content-desc="Bob &amp; Alice"/><node resource-id="primary-navigation-account" focused="true" content-desc="Carol"/><node resource-id="switch-user-item-2" selected="true" focused="false" content-desc="Dave"/></hierarchy>';
    expect(modernSelectedProfile(parseUiNodes(xml))).toBe('Bob & Alice');
    expect(modernSelectedProfile(picker(['Bob', 'Alice'], -1))).toBe(null);
    expect(modernSelectedProfile([node('switch-user-item-0', true, 'Bob'), node('switch-user-item-1', true, 'Alice')])).toBe(null);
  });

  it('opens the account submenu and profile picker by focused controls', async () => {
    const h = harness(home(), (key, nodes) => {
      const focus = nodes.find((n) => n.focused === 'true')?.['resource-id'];
      if (focus === 'primary-navigation-home' && key === 'KEYCODE_DPAD_UP') return [node('screen-home'), node('primary-navigation-account', true)];
      if (focus === 'primary-navigation-account' && key === 'KEYCODE_DPAD_RIGHT') return [node('secondary-navigation-account-switch-user', true)];
      if (key === 'KEYCODE_DPAD_CENTER') return picker(['Bob', 'Alice'], 0);
      throw new Error(`unexpected press ${key}`);
    });
    expect(await h.control.summonPicker()).toEqual(['Bob', true]);
    expect(h.keys).toEqual(['KEYCODE_DPAD_UP', 'KEYCODE_DPAD_RIGHT', 'KEYCODE_DPAD_CENTER']);
  });

  it('batches the measured visible distance, reads it back, and verifies before committing', async () => {
    let index = 0;
    const names = ['Bob', 'Carol', 'Alice'];
    const h = harness(picker(names, index), (key) => {
      if (key === 'KEYCODE_DPAD_RIGHT') return picker(names, ++index);
      if (key === 'KEYCODE_DPAD_CENTER') return home();
      throw new Error(key);
    });
    expect((await h.control.switchTo('Alice'))[0]).toBe(true);
    expect(h.keys).toEqual(['KEYCODE_DPAD_RIGHT', 'KEYCODE_DPAD_RIGHT', 'KEYCODE_DPAD_CENTER']);
    expect(h.batches).toEqual([{ key: 'KEYCODE_DPAD_RIGHT', count: 2 }, { key: 'KEYCODE_DPAD_CENTER', count: 1 }]);
    // Previously ten costly dumps for the same two-slot switch; five retain the guards.
    expect(h.dumpCount()).toBe(5);
  });

  it('batches leftward navigation and counts arrows against the budget', async () => {
    let index = 3;
    const names = ['Bob', 'Carol', 'Dave', 'Alice'];
    const h = harness(picker(names, index), (key) => key === 'KEYCODE_DPAD_CENTER' ? home() : picker(names, --index));
    expect((await h.control.switchTo('Bob'))[0]).toBe(true);
    expect(h.batches).toEqual([{ key: 'KEYCODE_DPAD_LEFT', count: 3 }, { key: 'KEYCODE_DPAD_CENTER', count: 1 }]);
    expect(h.dumpCount()).toBe(5);

    let boundedIndex = 0;
    const farNames = ['Bob', 'Carol', 'Dave', 'Erin', 'Grace', 'Alice'];
    const bounded = harness(picker(farNames, 0), () => picker(farNames, ++boundedIndex));
    expect((await bounded.control.switchTo('Alice'))[0]).toBe(false);
    expect(bounded.batches).toEqual([{ key: 'KEYCODE_DPAD_RIGHT', count: 4 }]);
    expect(bounded.keys).not.toContain('KEYCODE_DPAD_CENTER');
  });

  it('uses one arrow for an off-screen target even when the roster hints at several', async () => {
    const h = harness(picker(['Bob'], 0), (key) => key === 'KEYCODE_DPAD_CENTER' ? home() : picker(['Alice'], 0));
    h.setOffset(3);
    expect((await h.control.switchTo('Alice'))[0]).toBe(true);
    expect(h.batches).toEqual([{ key: 'KEYCODE_DPAD_RIGHT', count: 1 }, { key: 'KEYCODE_DPAD_CENTER', count: 1 }]);
  });

  it('replans from the measured landing when a batch moves fewer slots', async () => {
    let index = 0;
    const names = ['Bob', 'Carol', 'Alice'];
    const h = harness(picker(names, 0), (key) => {
      if (key === 'KEYCODE_DPAD_CENTER') return home();
      // The second event of the first batch is ignored by the UI.
      if (h.keys.length !== 2) index += 1;
      return picker(names, index);
    });
    expect((await h.control.switchTo('Alice'))[0]).toBe(true);
    expect(h.batches).toEqual([
      { key: 'KEYCODE_DPAD_RIGHT', count: 2 },
      { key: 'KEYCODE_DPAD_RIGHT', count: 1 },
      { key: 'KEYCODE_DPAD_CENTER', count: 1 },
    ]);
  });

  it('refuses a batch if the target tile changes during account lookup', async () => {
    const h = harness(picker(['Bob', 'Carol', 'Alice'], 0));
    h.beforeDump(() => { if (h.dumpCount() === 2) h.setNodes(picker(['Bob', 'Carol', 'Dave'], 0)); });
    expect((await h.control.switchTo('Alice'))[0]).toBe(false);
    expect(h.keys).toEqual([]);
  });

  it('refuses a batch if the focused account moves to a different index', async () => {
    const h = harness(picker(['Bob', 'Carol', 'Alice'], 0));
    h.beforeDump(() => { if (h.dumpCount() === 2) h.setNodes(picker(['Carol', 'Bob', 'Alice'], 1)); });
    expect((await h.control.switchTo('Alice'))[0]).toBe(false);
    expect(h.keys).toEqual([]);
  });

  it('sends no further arrows or CENTER when a batch leaves the picker', async () => {
    const h = harness(picker(['Bob', 'Alice'], 0), () => home());
    expect((await h.control.switchTo('Alice'))[0]).toBe(false);
    expect(h.keys).toEqual(['KEYCODE_DPAD_RIGHT']);
  });

  it('matches the owner display-name alias and verifies signed-in navigation', async () => {
    const h = harness(picker(['Bob Smith'], 0), () => home());
    expect((await h.control.switchTo('bob'))[0]).toBe(true);
    expect(h.keys).toEqual(['KEYCODE_DPAD_CENTER']);
  });

  it('acquires focus on a fresh picker before selecting a named profile', async () => {
    const h = harness(picker(['Bob'], -1), (key) => key === 'KEYCODE_DPAD_LEFT' ? picker(['Bob'], 0) : home());
    expect((await h.control.switchTo('Bob'))[0]).toBe(true);
    expect(h.keys).toEqual(['KEYCODE_DPAD_LEFT', 'KEYCODE_DPAD_CENTER']);
  });

  it('recovers the collapsed navigation rail after leaving playback', async () => {
    const h = harness([node('screen-home'), { ...node('', true), bounds: '[0,20][20,1080]' }], (key, nodes) => {
      if (key === 'KEYCODE_DPAD_RIGHT' && nodes.some((n) => n.bounds)) return [node('screen-home'), node('primary-navigation-account', true)];
      if (key === 'KEYCODE_DPAD_CENTER') return picker(['Bob'], 0);
      return [node('secondary-navigation-account-switch-user', true)];
    });
    expect(await h.control.summonPicker()).toEqual(['Bob', true]);
    expect(h.keys).toEqual(['KEYCODE_DPAD_RIGHT', 'KEYCODE_DPAD_RIGHT', 'KEYCODE_DPAD_CENTER']);
  });

  it('leaves a protected Plex player before opening the profile picker', async () => {
    const h = harness([node('android:id/content')], (key) => {
      if (key === 'KEYCODE_MEDIA_STOP') return [node('screen-home'), node('primary-navigation-account', true)];
      if (key === 'KEYCODE_DPAD_RIGHT') return [node('secondary-navigation-account-switch-user', true)];
      return picker(['Bob'], 0);
    });
    h.setPlayerActive(true);
    expect(await h.control.summonPicker()).toEqual(['Bob', true]);
    expect(h.keys).toEqual(['KEYCODE_MEDIA_STOP', 'KEYCODE_DPAD_RIGHT', 'KEYCODE_DPAD_CENTER']);
  });

  it('does not accept CENTER when a PIN screen or the picker remains', async () => {
    const pin = harness(picker(['Bob'], 0), () => [node('pin-entry', true)]);
    expect((await pin.control.switchTo('Bob'))[0]).toBe(false);
    const stuck = harness(picker(['Bob'], 0));
    expect((await stuck.control.switchTo('Bob'))[0]).toBe(false);
    expect(stuck.keys).toEqual(['KEYCODE_DPAD_CENTER']);
  });

  it('leaves per-profile onboarding untouched before and after selecting a profile', async () => {
    const onboarding = [node('screen-all-libraries'), node('', true, 'Continue')];
    expect(isModernPlexOnboarding(onboarding)).toBe(true);
    expect(isModernPlexOnboarding([node('whats-new-onboarding-progress-button')])).toBe(true);
    expect(isModernPlexOnboarding(home())).toBe(false);
    const initial = harness(onboarding);
    expect(await initial.control.switchTo('Alice')).toEqual([false, PLEX_SETUP_REQUIRED]);
    expect(initial.keys).toEqual([]);
    const after = harness(picker(['Alice'], 0), () => onboarding);
    expect(await after.control.switchTo('Alice')).toEqual([false, PLEX_SETUP_REQUIRED]);
    expect(after.keys).toEqual(['KEYCODE_DPAD_CENTER']);
  });

  it('sends no input when cancelled or when the foreground changes during the dump', async () => {
    const cancelled = harness(picker(['Bob'], 0));
    cancelled.cancelNow();
    expect((await cancelled.control.switchTo('Bob', cancelled.cancel))[0]).toBe(false);
    expect(cancelled.keys).toEqual([]);
    const moved = harness(picker(['Bob'], 0));
    moved.beforeDump(() => moved.setActivity('com.example.launcher/.MainActivity'));
    expect((await moved.control.switchTo('Bob'))[0]).toBe(false);
    expect(moved.keys).toEqual([]);
  });

  it('rechecks cancellation after reading the screen and before a press', async () => {
    const h = harness(picker(['Bob'], 0));
    let dumps = 0;
    h.beforeDump(() => { if (++dumps === 2) h.cancelNow(); });
    expect((await h.control.switchTo('Bob', h.cancel))[0]).toBe(false);
    expect(h.keys).toEqual([]);
  });

  it('fails on an unknown screen and bounds navigation on a stuck menu', async () => {
    const unknown = harness([node('unknown-dialog', true)]);
    expect((await unknown.control.switchTo('Bob'))[0]).toBe(false);
    expect(unknown.keys).toEqual([]);
    const stuck = harness(home());
    expect((await stuck.control.switchTo('Bob'))[0]).toBe(false);
    expect(stuck.keys.length).toBe(4);
  });

  it('does not keep walking when a picker fails to move', async () => {
    const h = harness(picker(['Bob', 'Alice'], 0));
    expect((await h.control.switchTo('Alice'))[0]).toBe(false);
    expect(h.keys).toEqual(['KEYCODE_DPAD_RIGHT']);
  });
});
