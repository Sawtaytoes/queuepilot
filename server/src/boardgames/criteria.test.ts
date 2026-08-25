// The pick body, parsed. Every enumerated field is a closed set, and a wrong value is a
// rejection rather than a silent default — a picker that answers a question nobody asked
// looks exactly like one that worked.
import { describe, expect, it } from 'vitest';

import { parsePickCriteria } from './criteria.js';

const criteriaOf = (body: Record<string, unknown>) => {
  const parsed = parsePickCriteria(body);
  if ('error' in parsed) throw new Error(`unexpected rejection: ${parsed.error}`);
  return parsed.criteria;
};

describe('parsePickCriteria', () => {
  it('fills the defaults from a body that says only the head count', () => {
    expect(criteriaOf({ playerCount: 3 })).toEqual({
      categories: [],
      excludedGameIds: [],
      fitness: 'bestOrRecommended',
      groupId: null,
      interactionType: null,
      maxPlaytime: null,
      maxWeight: null,
      playerCount: 3,
      playerIds: null,
      rulesKnown: 'any',
    });
  });

  it('renames personIds to the engine’s playerIds and keeps the order', () => {
    expect(criteriaOf({ personIds: ['ada', 'linus'], playerCount: 2 }).playerIds).toEqual([
      'ada',
      'linus',
    ]);
  });

  it('reads an empty personIds as "nobody named", not as a table of nought', () => {
    expect(criteriaOf({ personIds: [], playerCount: 2 }).playerIds).toBeNull();
  });

  it('carries the ceilings through, and null for "no ceiling"', () => {
    expect(criteriaOf({ maxPlaytime: 60, maxWeight: 2.4, playerCount: 4 })).toMatchObject({
      maxPlaytime: 60,
      maxWeight: 2.4,
    });
    expect(criteriaOf({ maxWeight: null, playerCount: 4 }).maxWeight).toBeNull();
  });

  it('omits the seed rather than sending undefined into the engine', () => {
    expect('seed' in criteriaOf({ playerCount: 2 })).toBe(false);
    expect(criteriaOf({ playerCount: 2, seed: 7 }).seed).toBe(7);
  });

  for (const [field, body] of [
    ['playerCount, when absent', {}],
    ['playerCount, when nought', { playerCount: 0 }],
    ['playerCount, when fractional', { playerCount: 2.5 }],
    ['fitness', { fitness: 'bestOnley', playerCount: 2 }],
    ['rulesKnown', { playerCount: 2, rulesKnown: 'most' }],
    ['interactionType', { interactionType: 'coop', playerCount: 2 }],
    ['maxWeight', { maxWeight: 'light', playerCount: 2 }],
    ['seed', { playerCount: 2, seed: 'random' }],
  ] as const) {
    it(`rejects a bad ${field}`, () => {
      expect(parsePickCriteria(body)).toHaveProperty('error');
    });
  }

  it('drops a non-string out of a list rather than stringifying it', () => {
    expect(
      criteriaOf({ excludedGameIds: ['harbour-lantern', 7, null], playerCount: 2 })
        .excludedGameIds,
    ).toEqual(['harbour-lantern']);
  });
});
