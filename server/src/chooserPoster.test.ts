import { beforeEach, expect, test, vi } from 'vitest';
const h = vi.hoisted(() => ({
  getSet: vi.fn(), loadSets: vi.fn(), bindingFor: vi.fn(), profileBinding: vi.fn(),
  buckets: vi.fn(), thumb: vi.fn(), plexGet: vi.fn(), profileUser: vi.fn(),
  access: vi.fn(), sharedThumb: vi.fn(), sharedGet: vi.fn(), profileToken: vi.fn(), materialize: vi.fn(), handoff: vi.fn(),
}));
vi.mock('./sets.js', () => ({ getSet: h.getSet }));
vi.mock('./season.js', () => ({ isSetAvailable: () => true }));
vi.mock('./engine/routing.js', () => ({ loadSets: h.loadSets, bindingFor: h.bindingFor }));
vi.mock('./providers/index.js', () => ({ providerFor: () => ({ kind: 'plex', profileBinding: h.profileBinding, profileToken: h.profileToken, buckets: h.buckets, materialize: h.materialize, handoff: h.handoff }) }));
vi.mock('./providers/blocks.js', () => ({ providerIdForSet: () => 'plex' }));
vi.mock('./plex.js', () => ({ thumb: h.thumb, plexGet: h.plexGet, profileUser: h.profileUser }));
vi.mock('./plexSources.js', () => ({ plexServerAccessForProfile: h.access, plexServerThumb: h.sharedThumb, plexServerGet: h.sharedGet }));
import { chooserPoster } from './chooserPoster.js';
beforeEach(() => {
  vi.resetAllMocks();
  const cfg = { id: 'learning', source: 'queue', requires_profile: 'Student' };
  h.getSet.mockResolvedValue(cfg);
  h.loadSets.mockReturnValue({ sets: { learning: cfg } });
  h.bindingFor.mockReturnValue({ account_id: null });
  h.profileBinding.mockResolvedValue({ account_id: 12, user_uuid: 'student' });
  h.profileToken.mockResolvedValue("restricted-token");
  h.buckets.mockResolvedValue({ play: [{ ratingKey: '42' }] });
  h.plexGet.mockResolvedValue({ MediaContainer: { Metadata: [{ type: 'episode', grandparentRatingKey: '11' }] } });
  h.thumb.mockResolvedValue({ buffer: Buffer.from('poster'), contentType: 'image/jpeg' });
});
test('uses the queue profile and show poster without starting or persisting playback', async () => {
  expect(await chooserPoster('learning')).toEqual({ buffer: Buffer.from('poster'), contentType: 'image/jpeg' });
  expect(h.profileBinding).toHaveBeenCalledWith({ account_id: null }, 'Student');
  expect(h.buckets).toHaveBeenCalledWith(expect.objectContaining({ binding: { account_id: 12, user_uuid: 'student' }, token: 'restricted-token' }));
  expect(h.thumb).toHaveBeenCalledWith('11');
  expect(h.materialize).not.toHaveBeenCalled();
  expect(h.handoff).not.toHaveBeenCalled();
});
test('an empty queue has no poster', async () => {
  h.buckets.mockResolvedValue({ play: [] });
  expect(await chooserPoster('learning')).toBeNull();
  expect(h.thumb).not.toHaveBeenCalled();
});
test('shared-server keys stay scoped to that server and queue profile', async () => {
  h.buckets.mockResolvedValue({ play: [{ ratingKey: '42', plexServer: 'remote' }] });
  h.profileUser.mockResolvedValue({ uuid: 'student' });
  h.access.mockResolvedValue({ id: 'remote' });
  h.sharedGet.mockResolvedValue({ MediaContainer: { Metadata: [{ type: 'episode', grandparentRatingKey: '99' }] } });
  h.sharedThumb.mockResolvedValue({ buffer: Buffer.from('shared'), contentType: 'image/jpeg' });
  await chooserPoster('learning');
  expect(h.access).toHaveBeenCalledWith('student', 'remote');
  expect(h.sharedThumb).toHaveBeenCalledWith({ id: 'remote' }, '99');
  expect(h.thumb).not.toHaveBeenCalled();
});
test('unknown queues have no artwork or provider calls', async () => {
  h.getSet.mockResolvedValue(null);
  expect(await chooserPoster('missing')).toBeNull();
  expect(h.buckets).not.toHaveBeenCalled();
});

test('owner queues use the configured admin token when the profile UUID is null', async () => {
  h.profileBinding.mockResolvedValue({ account_id: null, user_uuid: null });
  h.profileToken.mockResolvedValue(null);
  expect(await chooserPoster('learning')).not.toBeNull();
  expect(h.buckets).toHaveBeenCalledWith(expect.objectContaining({ token: null }));
});
test('a missing managed-user token never falls back to the owner token', async () => {
  h.profileToken.mockResolvedValue(null);
  expect(await chooserPoster('learning')).toBeNull();
  expect(h.buckets).not.toHaveBeenCalled();
});
