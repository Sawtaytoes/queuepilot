import { expect, it, vi } from 'vitest';
vi.mock('./env.js', async (original) => ({ ...await original<typeof import('./env.js')>(), SHIELD_CLIENT_MACHINE_ID: 'default-player', SHIELD_CLIENT_NAME: 'Default TV', SHIELD_CLIENT_URI: 'http://192.0.2.30:32500' }));
import { _internals } from './playback.js';
it('never substitutes default identity fields into an explicitly selected secondary player', () => {
  const target = _internals.configuredSessionTarget({ id: 'den', name: 'Den TV', machineIdentifier: '', uri: 'http://192.0.2.31:32500', mode: 'client', default: false });
  expect(target).toEqual({ name: 'Den TV', machineIdentifier: null, uri: 'http://192.0.2.31:32500' });
  expect(_internals.sessionBelongsTo({ Player: { machineIdentifier: 'default-player', title: 'Default TV' } }, target!)).toBe(false);
  expect(_internals.sessionBelongsTo({ Player: { machineIdentifier: 'other-id', title: 'Den TV' } }, target!)).toBe(true);
});
