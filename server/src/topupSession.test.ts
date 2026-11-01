import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('./session.js', () => ({ SESSION: {
  sittingId: 1, isPreparing: false, set: 'sample', profile: 'Ada', device: null,
  playQueueID: 'old-queue', queuedTotal: 3, lastMovieRk: null,
} }));
vi.mock('./engine/routing.js', () => ({
  loadSets: () => ({ sets: { sample: { source: 'rotation', length: 'infinite' } } }),
  bindingFor: () => ({ user_uuid: 'fixture-user' }),
}));
import { SESSION } from './session.js';
import { topup, _resetCooldown, type TopupDeps } from './topup.js';
beforeEach(() => {
  _resetCooldown();
  Object.assign(SESSION, { sittingId: 1, isPreparing: false, set: 'sample', playQueueID: 'old-queue', queuedTotal: 3 });
});
for (const boundary of ['read', 'build', 'extend'] as const) {
  it(`discards a top-up replaced during ${boundary} without changing another sitting`, async () => {
    let entered = false;
    let release!: () => void;
    const held = () => { entered = true; return new Promise<void>((r) => { release = r; }); };
    const read = vi.fn(async () => {
      if (boundary === 'read') await held();
      return { remaining: 1, ratingKeys: ['1'], items: [{ ratingKey: '1' }] };
    });
    const build = vi.fn(async () => {
      if (boundary === 'build') await held();
      return { play: [{ ratingKey: '2' }] };
    });
    const extend = vi.fn(async (_queue: string | number, _items: unknown, _opts: unknown) => {
      if (boundary === 'extend') await held();
      return 2;
    });
    const deps = { readPlayQueue: read, extendPlayQueue: extend,
      providerFor: () => ({ profileToken: async () => 'fixture-token', buckets: build }),
    } as unknown as TopupDeps;
    const pending = topup({ deps });
    await vi.waitFor(() => expect(entered).toBe(true));
    Object.assign(SESSION, { sittingId: 2, isPreparing: true, playQueueID: 'new-queue', queuedTotal: 9 });
    release();
    expect((await pending).reason).toBe('session replaced');
    expect(SESSION.queuedTotal).toBe(9);
    if (boundary !== 'extend') expect(extend).not.toHaveBeenCalled();
    else expect(extend.mock.calls[0]?.[0]).toBe('old-queue');
  });
}
