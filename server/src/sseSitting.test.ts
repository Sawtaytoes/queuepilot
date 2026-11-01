import { expect, it, vi } from 'vitest';
import type { NowPlaying, PublishedSessionState } from './types.js';
const hooks = vi.hoisted(() => ({
  now: null as ((now: NowPlaying | null) => Promise<void>) | null,
  state: null as ((state: PublishedSessionState | null) => void) | null,
  context: vi.fn(),
  cached: null as NowPlaying | null,
}));
vi.mock('./mqttc.js', () => ({
  lastState: () => ({ deviceId: 'test-player', set: 'sample' }), lastNowPlaying: () => hooks.cached,
  onState: (fn: typeof hooks.state) => { hooks.state = fn; },
  onNowPlaying: (fn: typeof hooks.now) => { hooks.now = fn; },
}));
vi.mock('./session.js', () => ({ SESSION: { sittingId: 1, isPreparing: false, queue: [], set: 'sample' } }));
vi.mock('./store/index.js', () => ({ store: { watchTargets: () => [] } }));
vi.mock('./plex.js', () => ({ playingContext: hooks.context }));
vi.mock('./cache.js', () => ({ dropLeaves: vi.fn(), bumpGeneration: vi.fn() }));
vi.mock('./warm.js', () => ({ kick: vi.fn() }));
import { SESSION } from './session.js';
import { startLiveUpdates, lastNow, withContext } from './sse.js';
startLiveUpdates();
it('never restores an old same-player cache through preparation and success state events', async () => {
  hooks.cached = { deviceId: 'test-player', state: 'playing', ratingKey: 'old-episode', position: 10 };
  hooks.context.mockResolvedValue(null);
  await hooks.now!(hooks.cached);
  expect(lastNow()?.ratingKey).toBe('old-episode');
  SESSION.sittingId += 1;
  SESSION.isPreparing = true;
  hooks.state!(null);
  expect(lastNow()).toBeNull();
  SESSION.isPreparing = false;
  hooks.state!(null);
  expect(lastNow()).toBeNull();
  await hooks.now!({ deviceId: 'test-player', state: 'playing', ratingKey: 'new-episode', position: 20 });
  expect(lastNow()?.ratingKey).toBe('new-episode');
  hooks.cached = null;
});
for (const replaceSitting of [false, true]) {
  it(`rejects an older enrichment after a newer observation${replaceSitting ? ' in a replacement sitting on the same player' : ''}`, async () => {
    let release!: (value: null) => void;
    hooks.context.mockReset().mockImplementationOnce(() => new Promise<null>((r) => { release = r; }))
      .mockResolvedValue(null);
    const old = hooks.now!({ deviceId: 'test-player', state: 'playing', ratingKey: 'old', position: 10 });
    if (replaceSitting) { SESSION.sittingId += 1; hooks.state!(null); }
    await hooks.now!({ deviceId: 'test-player', state: 'playing', ratingKey: 'new', position: 20 });
    release(null);
    await old;
    expect(lastNow()).toMatchObject({ ratingKey: 'new', position: 20 });
  });
}
it('drops a context lookup and cached snapshot after sitting replacement', async () => {
  let release!: (value: null) => void;
  hooks.context.mockImplementationOnce(() => new Promise<null>((r) => { release = r; }));
  const pending = withContext({ state: 'playing', ratingKey: 'old' });
  SESSION.sittingId += 1;
  release(null);
  expect(await pending).toBeNull();
  expect(lastNow()).toBeNull();
});
