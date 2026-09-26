import { describe, expect, it } from 'vitest';

import { _internals } from './playback.js';

describe('mixed-server Plex play queues', () => {
  it('keeps lineup order while grouping consecutive source URIs', () => {
    const refs = _internals.queueItemRefs([
      { ratingKey: '1' },
      { ratingKey: '2', plexServer: 'friend' },
      { ratingKey: '3', plexServer: 'friend' },
      { ratingKey: '4' },
    ]);

    expect(_internals.queueGroups(refs, 'home')).toEqual([
      { server: 'home', ratingKeys: ['1'] },
      { server: 'friend', ratingKeys: ['2', '3'] },
      { server: 'home', ratingKeys: ['4'] },
    ]);
  });
});
