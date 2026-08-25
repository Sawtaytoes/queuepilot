import { describe, expect, it } from 'vitest';

import { parseThingVersions } from './versionsXml.js';

const xml = `<?xml version="1.0"?>
<items>
  <item type="boardgame" id="1001">
    <name value="Harbour Lantern"/>
    <image>https://cf.geekdo-images.com/default.jpg</image>
    <versions>
      <item type="boardgameversion" id="11">
        <thumbnail>https://cf.geekdo-images.com/t1.jpg</thumbnail>
        <image>https://cf.geekdo-images.com/v1.jpg</image>
        <name type="primary" sortindex="1" value="English edition, first printing"/>
        <yearpublished value="2016"/>
        <link type="boardgamepublisher" id="1" value="Harbour Press"/>
        <link type="language" id="2184" value="English"/>
      </item>
      <item type="boardgameversion" id="12">
        <name type="primary" sortindex="1" value="German edition 2017"/>
        <yearpublished value="2017"/>
        <link type="language" id="2188" value="German"/>
      </item>
    </versions>
  </item>
</items>`;

describe('parseThingVersions', () => {
  it('reads nested version items without swallowing the parent', () => {
    expect(parseThingVersions(xml)).toEqual([
      {
        id: 11,
        imageUrl: 'https://cf.geekdo-images.com/v1.jpg',
        languages: ['English'],
        name: 'English edition, first printing',
        publishers: ['Harbour Press'],
        thumbnailUrl: 'https://cf.geekdo-images.com/t1.jpg',
        year: 2016,
      },
      {
        id: 12,
        imageUrl: null,
        languages: ['German'],
        name: 'German edition 2017',
        publishers: [],
        thumbnailUrl: null,
        year: 2017,
      },
    ]);
  });

  it('returns nothing when the thing has no versions', () => {
    expect(
      parseThingVersions(
        `<items><item type="boardgame" id="1"><name value="X"/></item></items>`,
      ),
    ).toEqual([]);
  });
});
