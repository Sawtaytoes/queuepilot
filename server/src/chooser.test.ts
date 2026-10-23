import { afterEach, expect, test, vi } from 'vitest';
import { createChooser, type ChooserState } from './chooser.js';

const harness = () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const catalog = vi.fn(async (people: string[]) => people.includes('ada')
    ? [{ id: 'films', title: 'Movies', kind: 'picks' }, { id: 'series', title: 'Shows', kind: 'rules' }] : []);
  const publish = vi.fn();
  const chooser = createChooser({ catalog, person: (id) => ['ada', 'grace'].includes(id) ? { id, name: id } : undefined, publish });
  const scan = (personId: string, eventId = `${personId}-${Date.now()}`, reader = 'desk') => chooser.handle(reader, { action: 'scan', personId, eventId, atMs: Date.now() });
  const state = () => publish.mock.lastCall?.[1] as ChooserState;
  const action = (name: string, rest = {}) => chooser.handle('desk', { action: name, sessionId: state().sessionId, revision: state().revision, ...rest });
  return { chooser, catalog, publish, scan, state, action };
};
afterEach(() => vi.useRealTimers());
test('scans accumulate only within a reader, never play, and duplicate delivery does not add or reopen', async () => {
  const h = harness(); await h.scan('ada', 'one'); await h.scan('grace', 'two');
  expect(h.state().people.map((p) => p.id)).toEqual(['ada', 'grace']);
  expect(h.publish.mock.calls.map((c) => c[2])).toEqual(['show', 'show']);
  await h.action('dismiss'); await h.scan('ada', 'one'); expect(h.state().isActive).toBe(false);
  await h.scan('grace', 'three', 'other'); expect(h.state().people.map((p) => p.id)).toEqual(['grace']); h.chooser.clear();
});
test('inactivity ends at sixty seconds after the last interaction and the next scan starts empty', async () => {
  const h = harness(); await h.scan('ada'); await vi.advanceTimersByTimeAsync(59_000);
  await h.action('touch'); await vi.advanceTimersByTimeAsync(59_000); expect(h.state().isActive).toBe(true);
  await vi.advanceTimersByTimeAsync(1000); expect(h.state().isActive).toBe(false);
  await h.scan('grace'); expect(h.state().people.map((p) => p.id)).toEqual(['grace']); h.chooser.clear();
});
test('stale frames, unknown people, old scans and ineligible queues never request playback', async () => {
  const h = harness(); await h.scan('stranger'); expect(h.publish).not.toHaveBeenCalled();
  await h.chooser.handle('desk', { action: 'scan', personId: 'ada', atMs: 1, eventId: 'old' }); expect(h.publish).not.toHaveBeenCalled();
  await h.scan('ada'); const old = h.state(); await h.scan('grace');
  await h.chooser.handle('desk', { action: 'choose', sessionId: old.sessionId, revision: old.revision, queueId: 'films' });
  await h.action('choose', { queueId: 'missing' }); expect(h.publish.mock.calls.some((c) => c[2] === 'play')).toBe(false);
  await h.action('remove', { personId: 'ada' }); expect(h.state().queues).toEqual([]);
  await h.action('remove', { personId: 'grace' }); expect(h.state().isActive).toBe(false); h.chooser.clear();
});
test('tap revalidates eligibility and dispatches exactly once before dismissing', async () => {
  const h = harness(); await h.scan('ada'); const current = h.state();
  const input = { action: 'choose', sessionId: current.sessionId, revision: current.revision, queueId: 'series' };
  await Promise.all([h.chooser.handle('desk', input), h.chooser.handle('desk', input)]);
  expect(h.publish.mock.calls.filter((c) => c[2] === 'play')).toHaveLength(1);
  expect(h.publish.mock.lastCall?.[3]).toEqual({ id: 'series', title: 'Shows', kind: 'rules' });
  expect(h.state().isActive).toBe(false); h.chooser.clear();
});
test('a delayed catalog cannot play after the selection expires', async () => {
  const h = harness(); await h.scan('ada');
  const original = h.catalog.getMockImplementation()!;
  h.catalog.mockImplementation(async (people) => { await new Promise((resolve) => setTimeout(resolve, 61_000)); return original(people); });
  const pending = h.action('choose', { queueId: 'films' });
  await vi.advanceTimersByTimeAsync(61_000); await pending;
  expect(h.publish.mock.calls.some((c) => c[2] === 'play')).toBe(false); h.chooser.clear();
});
