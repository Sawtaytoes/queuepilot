import { describe, expect, it } from 'vitest';

import { matchTitle, normalizeTitle } from './match.js';

// Invented titles only. The *shapes* below are real (an edition suffix, a stylised character, a
// colon-suffixed box), the games are not.
const targets = [
  { gameId: 'harbour', name: 'Harbour Lantern' },
  {
    gameId: 'harbour',
    name: 'Harbour Lantern: Tidewater Box',
  },
  { gameId: 'orchard', name: 'Orchard (Second Edition)' },
  { gameId: 'pa$try', name: 'Pa$try Panic' },
  { gameId: 'moth', name: 'Moth & Flame' },
  { gameId: 'signal', name: 'Signal - Deep Water' },
  { gameId: 'villages', name: 'Villages of Rill' },
  { gameId: 'castles', name: 'Castles of Rill' },
];

describe('normalizeTitle', () => {
  it('strips the punctuation two filing systems disagree about', () => {
    expect(normalizeTitle('Signal - Deep Water')).toBe(normalizeTitle('Signal: Deep Water'));
  });

  it('reads a stylised dollar sign as an s', () => {
    expect(normalizeTitle('Pa$try Panic')).toBe('pastry panic');
  });

  it('spells out an ampersand', () => {
    expect(normalizeTitle('Moth & Flame')).toBe(normalizeTitle('Moth and Flame'));
  });

  it('drops a parenthesised edition and the word rulebook', () => {
    expect(normalizeTitle('Orchard (Second Edition)')).toBe(normalizeTitle('Orchard Rulebook'));
  });
});

describe('matchTitle', () => {
  it('matches an identical title', () => {
    expect(matchTitle('Harbour Lantern', targets)).toEqual({
      alternatives: [],
      confidence: 'exact',
      gameId: 'harbour',
    });
  });

  it('matches through an edition suffix the library omits', () => {
    expect(matchTitle('Orchard', targets)).toMatchObject({
      confidence: 'exact',
      gameId: 'orchard',
    });
  });

  it('matches a bare title to the box that extends it', () => {
    // "Harbour Lantern" is also a game name here, so use a title that only exists as the
    // longer box label.
    expect(matchTitle('Harbour Lantern Tidewater', targets)).toMatchObject({
      confidence: 'prefix',
      gameId: 'harbour',
    });
  });

  it('matches a library title that is longer than the game', () => {
    expect(matchTitle('Signal - Deep Water: Salvage', targets)).toMatchObject({
      confidence: 'prefix',
      gameId: 'signal',
    });
  });

  /**
   * The one that matters. Fuzzy distance rates these two at 0.75 and would file Castles'
   * rulebook under Villages — a wrong rulebook on a right-looking game, which is worse than
   * none.
   */
  it('does not reach for a near-miss on a shared suffix', () => {
    expect(matchTitle('Cottages of Rill', targets)).toMatchObject({
      confidence: 'none',
      gameId: null,
    });
  });

  it('reports rather than guesses when two games fit', () => {
    const ambiguous = matchTitle('Rill', [
      { gameId: 'villages', name: 'Rill: Villages' },
      { gameId: 'castles', name: 'Rill: Castles' },
    ]);

    expect(ambiguous.confidence).toBe('ambiguous');
    expect(ambiguous.gameId).toBeNull();
    expect(ambiguous.alternatives).toHaveLength(2);
  });

  it('is happy when several boxes of ONE game fit', () => {
    expect(
      matchTitle('Harbour Lantern', [
        {
          gameId: 'harbour',
          name: 'Harbour Lantern: Tidewater Box',
        },
        {
          gameId: 'harbour',
          name: 'Harbour Lantern: Reef Box',
        },
      ]),
    ).toMatchObject({
      confidence: 'prefix',
      gameId: 'harbour',
    });
  });

  it('has nothing to say about an empty title', () => {
    expect(matchTitle('   ', targets)).toMatchObject({
      confidence: 'none',
    });
  });
});
