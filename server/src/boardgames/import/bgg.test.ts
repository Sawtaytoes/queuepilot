import { describe, expect, it } from 'vitest';

import {
  chunk,
  parseCollection,
  parsePlayerCountPoll,
  parseSearch,
  parseThings,
  toSourceRow,
} from './bgg.js';

// Invented games. The XML *shapes* are real, copied from live `xmlapi2` responses.
const collectionXml = `<?xml version="1.0" encoding="utf-8"?>
<items totalitems="2">
  <item objecttype="thing" objectid="1001" subtype="boardgame" collid="1">
    <name sortindex="1">Harbour Lantern</name>
    <yearpublished>2020</yearpublished>
    <status own="1" prevowned="0" fortrade="0" />
  </item>
  <item objecttype="thing" objectid="1002" subtype="boardgameexpansion" collid="2">
    <name sortindex="1">Harbour Lantern: Tidewater</name>
    <status own="1" prevowned="0" fortrade="0" />
  </item>
  <item objecttype="thing" objectid="1003" subtype="boardgame" collid="3">
    <name sortindex="1">Orchard</name>
    <status own="0" prevowned="1" fortrade="0" />
  </item>
</items>`;

describe('parseCollection', () => {
  it('reads ids, names and the owned flag', () => {
    expect(parseCollection(collectionXml)).toEqual([
      {
        bggId: 1001,
        isOwned: true,
        name: 'Harbour Lantern',
        subtype: 'boardgame',
      },
      {
        bggId: 1002,
        isOwned: true,
        name: 'Harbour Lantern: Tidewater',
        subtype: 'boardgameexpansion',
      },
      {
        bggId: 1003,
        isOwned: false,
        name: 'Orchard',
        subtype: 'boardgame',
      },
    ]);
  });

  /**
   * BGG sends an en dash as `&#8211;`. A title that decodes differently from the CSV export's
   * would import as a SECOND game beside the one already there.
   */
  it('decodes the entities BGG puts in titles', () => {
    const [item] = parseCollection(`<items>
      <item objectid="7" subtype="boardgame">
        <name>Harbour Lantern: Reef &#8211; Deep &amp; Dark</name>
        <status own="1" />
      </item></items>`);

    expect(item?.name).toBe('Harbour Lantern: Reef – Deep & Dark');
  });
});

const thingXml = (poll: string) => `<items>
  <item type="boardgame" id="1001">
    <name type="primary" value="Harbour Lantern" />
    <yearpublished value="2020" />
    <minplayers value="2" />
    <maxplayers value="5" />
    <minplaytime value="30" />
    <maxplaytime value="60" />
    <minage value="10" />
    <link type="boardgamepublisher" id="9" value="Invented Games" />
    <link type="boardgamedesigner" id="8" value="A Person" />
    ${poll}
    <statistics>
      <ratings>
        <average value="7.5" />
        <averageweight value="2.4" />
      </ratings>
    </statistics>
  </item>
</items>`;

const poll = `<poll name="suggested_numplayers" totalvotes="50">
  <results numplayers="1">
    <result value="Best" numvotes="1" />
    <result value="Recommended" numvotes="2" />
    <result value="Not Recommended" numvotes="30" />
  </results>
  <results numplayers="2">
    <result value="Best" numvotes="5" />
    <result value="Recommended" numvotes="20" />
    <result value="Not Recommended" numvotes="1" />
  </results>
  <results numplayers="3">
    <result value="Best" numvotes="40" />
    <result value="Recommended" numvotes="5" />
    <result value="Not Recommended" numvotes="0" />
  </results>
  <results numplayers="4">
    <result value="Best" numvotes="0" />
    <result value="Recommended" numvotes="0" />
    <result value="Not Recommended" numvotes="0" />
  </results>
  <results numplayers="4+">
    <result value="Best" numvotes="0" />
    <result value="Recommended" numvotes="9" />
    <result value="Not Recommended" numvotes="1" />
  </results>
</poll>`;

describe('parsePlayerCountPoll', () => {
  /**
   * This rebuilds the CSV export's `bggbestplayers` / `bggrecplayers` columns, which the XML
   * API does not carry and which the whole player-count verdict rests on.
   */
  it('takes the top-voted answer per player count', () => {
    expect(parsePlayerCountPoll(poll)).toEqual({
      // 3 wins Best outright; 2's top answer is Recommended.
      bestWith: [3],
      recommendedWith: [2, 3],
    });
  });

  it('treats a count nobody voted on as unknown, not bad', () => {
    // 4 has three zero-vote options. It must appear in NEITHER list — `unknown` stays
    // pickable, `notRecommended` does not.
    const { bestWith, recommendedWith } = parsePlayerCountPoll(poll);

    expect(bestWith).not.toContain(4);
    expect(recommendedWith).not.toContain(4);
  });

  it("drops the '4+' bucket rather than reading it as 4", () => {
    // Recommended at "4+" with 9 votes. Parsing that as 4 would invent a verdict the community
    // never gave.
    expect(parsePlayerCountPoll(poll).recommendedWith).toEqual([2, 3]);
  });

  it('says nothing when there is no poll at all', () => {
    expect(parsePlayerCountPoll('<item></item>')).toEqual({
      bestWith: [],
      recommendedWith: [],
    });
  });
});

describe('parseThings', () => {
  it('reads the numbers and only the publishers', () => {
    const [detail] = parseThings(thingXml(poll));

    expect(detail).toMatchObject({
      bestWith: [3],
      bggId: 1001,
      subtype: 'boardgame',
      maxPlayers: 5,
      maxPlaytime: 60,
      minAge: 10,
      minPlayers: 2,
      publishers: ['Invented Games'],
      rating: 7.5,
      weight: 2.4,
      yearPublished: 2020,
    });
  });

  /**
   * The fixture above says `id="1001"` and carries NO `objectid`, because that is what BGG
   * actually sends. An earlier fixture invented an `objectid`, the parser read that, and
   * `Number(null)` → 0 → "finite, therefore valid" meant every game in a live batch parsed as
   * id 0. The detail lookup then matched none of them and the collection imported with no
   * weights, no polls and no expansion flags — with a green test suite.
   */
  it('refuses a payload with no usable id rather than calling it 0', () => {
    expect(
      parseThings('<items><item type="boardgame"><name value="No Id" /></item></items>'),
    ).toEqual([]);
  });

  /**
   * BGG writes 0 for "we don't know" in weight and playtime, exactly like the CSV export. A 0
   * weight would make an unrated game the SIMPLEST in the collection and win every complexity
   * filter it should have failed.
   */
  it('reads a zero weight as unknown, not as trivial', () => {
    const [detail] = parseThings(
      thingXml(poll).replace('<averageweight value="2.4" />', '<averageweight value="0" />'),
    );

    expect(detail?.weight).toBeNull();
  });
});

describe('toSourceRow', () => {
  /**
   * The bug that inflated a live import by more than half again on its first run.
   * `/collection` stamps EVERY row with the subtype you queried, so an expansion arrives
   * claiming to be a `boardgame`; only the `thing` payload knows better. Trust the wrong one
   * and every expansion box becomes its own game instead of collapsing into its parent.
   */
  it('takes the expansion flag from the detail, not the collection entry', () => {
    expect(
      toSourceRow(
        {
          bggId: 1002,
          isOwned: true,
          name: 'Harbour Lantern: Tidewater',
          // What /collection always says, whatever the truth.
          subtype: 'boardgame',
        },
        {
          bestWith: [],
          bggId: 1002,
          maxPlayers: 4,
          maxPlaytime: null,
          minAge: null,
          minPlayers: 2,
          minPlaytime: null,
          publishers: [],
          rating: null,
          recommendedWith: [],
          subtype: 'boardgameexpansion',
          weight: null,
          yearPublished: null,
        },
      ).kind,
    ).toBe('expansion');
  });

  it("maps a BGG expansion to this app's expansion kind", () => {
    expect(
      toSourceRow(
        {
          bggId: 1002,
          isOwned: true,
          name: 'Harbour Lantern: Tidewater',
          subtype: 'boardgameexpansion',
        },
        undefined,
      ).kind,
    ).toBe('expansion');
  });

  it('survives a game the detail pass never returned', () => {
    const row = toSourceRow(
      {
        bggId: 1001,
        isOwned: true,
        name: 'Harbour Lantern',
        subtype: 'boardgame',
      },
      undefined,
    );

    expect(row).toMatchObject({
      bestWith: [],
      name: 'Harbour Lantern',
      weight: null,
    });
  });
});

describe('chunk', () => {
  it('batches ids the way the thing endpoint wants them', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 20)).toEqual([]);
  });
});

describe('parseSearch', () => {
  // The shape of a real `/search?type=boardgame` response: the id on `item`, the title on a
  // nested self-closing `name`.
  const searchXml = `<?xml version="1.0" encoding="utf-8"?>
<items total="3">
  <item type="boardgame" id="142039">
    <name type="primary" value="Harbour Lantern"/>
    <yearpublished value="2013"/>
  </item>
  <item type="boardgame" id="158340">
    <name type="primary" value="Harbour Lantern: Flying Garden"/>
    <yearpublished value="2013"/>
  </item>
  <item type="boardgame" id="900001">
    <name type="primary" value="Harbour Lantern &amp; Friends"/>
  </item>
</items>`;

  it('reads id, title and year off each hit', () => {
    expect(parseSearch(searchXml)).toEqual([
      {
        bggId: 142039,
        name: 'Harbour Lantern',
        yearPublished: 2013,
      },
      {
        bggId: 158340,
        name: 'Harbour Lantern: Flying Garden',
        yearPublished: 2013,
      },
      {
        bggId: 900001,
        name: 'Harbour Lantern & Friends',
        yearPublished: null,
      },
    ]);
  });

  it('is empty rather than throwing on a no-hit response', () => {
    expect(parseSearch('<?xml version="1.0"?><items total="0"></items>')).toEqual([]);
  });
});
