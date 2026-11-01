import { expect, it, vi } from 'vitest';
const ctl = vi.hoisted(() => ({ resolve: null as ((binding: object) => void) | null, entered: false }));
vi.mock('./mqttc.js', () => ({ lastState: () => null, onNowPlaying: vi.fn(), offNowPlaying: vi.fn() }));
vi.mock('./engine/routing.js', () => ({ loadSets: () => ({ sets: { sample: { id: 'sample', source: 'rotation', enabled: true } } }), bindingFor: () => ({}) }));
vi.mock('./providers/index.js', () => ({ providerFor: () => ({ profileBinding: () => { ctl.entered = true; return new Promise<object>((r) => { ctl.resolve = r; }); } }) }));
import { SESSION, startSession } from './session.js';
it('does not let a replaced profile lookup overwrite the active device or sitting', async () => {
  const active = { id: 'active', name: 'Active TV', machineIdentifier: 'active-player', uri: 'http://192.0.2.32:32500', mode: 'client', default: false };
  SESSION.device = active;
  const pending = startSession({ set: 'sample', target: { ...active, id: 'old' } });
  await vi.waitFor(() => expect(ctl.entered).toBe(true));
  expect(await startSession({ set: 'missing' })).toEqual({ error: 'disabled' });
  const replacementDevice = SESSION.device;
  ctl.resolve!({});
  expect(await pending).toEqual({ cancelled: true });
  expect(SESSION.device).toBe(replacementDevice);
});
