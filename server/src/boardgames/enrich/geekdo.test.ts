import { describe, expect, it } from 'vitest';

import { parseGeekdoItem } from './geekdo.js';

describe('parseGeekdoItem', () => {
  it('reads the uncropped scan and the version list', () => {
    const item = parseGeekdoItem({
      item: {
        name: 'Harbour Lantern',
        images: {
          original: 'https://cf.geekdo-images.com/example__original/img/x/pic1.jpg',
          opengraph: 'https://example.test/cropped.jpg',
        },
        links: {
          boardgamemechanic: [{ name: 'Cooperative Game' }],
          boardgamecategory: [{ name: 'Nautical' }],
          boardgamepublisher: [{ name: 'Harbour Press' }],
          boardgameversion: [
            {
              name: 'English edition, first printing',
              objectid: '324192',
            },
            {
              name: 'German edition 2017',
              objectid: 336553,
            },
          ],
        },
        minplayers: '2',
        maxplayers: '8',
        minage: '12',
        minplaytime: '45',
        maxplaytime: '60',
        yearpublished: '2016',
      },
    });

    expect(item?.imageUrl).toContain('__original/');
    expect(item?.versions).toEqual([
      {
        id: 324192,
        name: 'English edition, first printing',
      },
      { id: 336553, name: 'German edition 2017' },
    ]);
    expect(item?.mechanics).toEqual(['Cooperative Game']);
  });

  it('survives a thing with no versions and no art', () => {
    expect(
      parseGeekdoItem({
        item: { name: 'Harbour Lantern', links: {} },
      }),
    ).toMatchObject({
      imageUrl: null,
      name: 'Harbour Lantern',
      versions: [],
    });
  });
});
