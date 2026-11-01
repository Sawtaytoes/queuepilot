import { describe, expect, it } from 'vitest';
import { parsePlaybackTargets } from './playbackTargets.js';
const row = { id: 'den', name: 'Den TV', uri: 'http://192.0.2.31:32500', machine_identifier: 'den-player', adb_target: '192.0.2.31:5555' };
describe('explicit playback targets', () => {
  it('keeps configured secondary players independent of discovery and the default', () => {
    expect(parsePlaybackTargets([row])).toEqual([{ id: 'den', name: 'Den TV', uri: row.uri, machineIdentifier: 'den-player', mode: 'client', default: false, adbTarget: row.adb_target }]);
    expect(parsePlaybackTargets(null)).toEqual([]);
  });
  it.each([
    { ...row, id: 'shield' }, { ...row, id: 'room/#' }, { ...row, adb_target: '192.0.2.31:5555;reboot' },
    { ...row, adb_target: '192.0.2.30:5555' }, { ...row, uri: 'file:///etc/passwd' },
    { ...row, uri: 'http://user:pass@192.0.2.31' },
  ])('refuses invalid or misrouted deployment settings %j', (bad) => expect(() => parsePlaybackTargets([bad])).toThrow());
  it('refuses duplicate identities', () => {
    expect(() => parsePlaybackTargets([row, row])).toThrow();
    expect(() => parsePlaybackTargets([row, { ...row, id: 'other' }])).toThrow();
  });
});
