import { describe, expect, it } from 'vitest';

import { matchEdition } from './matchEdition.js';

/**
 * Invented editions of an invented game. The matching rules are what we are testing, not
 * anyone's real shelf.
 */
const catalog = [
  {
    id: 11,
    languages: ['English'],
    name: 'English edition, first printing',
    year: 2016,
  },
  {
    id: 12,
    languages: ['English'],
    name: 'English edition 2018',
    year: 2018,
  },
  {
    id: 21,
    languages: ['English'],
    name: 'English third edition',
    year: 2012,
  },
  {
    id: 31,
    languages: ['English'],
    name: 'Harbour Press English edition',
    year: 2021,
  },
  {
    id: 32,
    languages: ['English'],
    name: 'English edition',
    year: 2025,
  },
  {
    id: 33,
    languages: ['English'],
    name: 'English edition',
    year: 2025,
  },
  {
    id: 41,
    languages: ['German'],
    name: 'German first edition',
    year: 2018,
  },
];

describe('matchEdition', () => {
  it('takes a unique nickname even when the year differs from the title', () => {
    expect(
      matchEdition(
        {
          languages: ['English'],
          nickname: 'English third edition',
          year: 2012,
        },
        catalog,
      )?.id,
    ).toBe(21);
  });

  it('is case-insensitive and ignores extra spaces', () => {
    expect(
      matchEdition(
        {
          languages: ['English'],
          nickname: '  ENGLISH EDITION,   FIRST PRINTING ',
          year: 2016,
        },
        catalog,
      )?.id,
    ).toBe(11);
  });

  it('uses the year to break a repeated nickname', () => {
    const reprints = [
      {
        id: 1,
        languages: ['English'],
        name: 'English edition',
        year: 2017,
      },
      {
        id: 2,
        languages: ['English'],
        name: 'English edition',
        year: 2019,
      },
    ];
    expect(
      matchEdition(
        {
          languages: ['English'],
          nickname: 'English edition',
          year: 2019,
        },
        reprints,
      )?.id,
    ).toBe(2);
  });

  it('refuses to guess when two versions share a name and a year', () => {
    expect(
      matchEdition(
        {
          languages: ['English'],
          nickname: 'English edition',
          year: 2025,
        },
        catalog,
      ),
    ).toBeNull();
  });

  it('falls back to a unique year-and-language pair when there is no nickname', () => {
    expect(
      matchEdition(
        {
          languages: ['German'],
          nickname: null,
          year: 2018,
        },
        catalog,
      )?.id,
    ).toBe(41);
  });

  it('does not treat a unique-looking year as enough on its own', () => {
    expect(matchEdition({ languages: [], nickname: null, year: 2016 }, catalog)).toBeNull();
  });

  it('returns null rather than the first English version', () => {
    expect(
      matchEdition(
        {
          languages: ['English'],
          nickname: 'French edition',
          year: 2016,
        },
        catalog,
      ),
    ).toBeNull();
  });
});
