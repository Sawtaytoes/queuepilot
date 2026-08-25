// The activity → backend map (WP-7), and the four things about it that fail SILENTLY.
//
// A wrong row here does not throw. It routes an evening at the wrong backend, or drops an
// activity out of a list, and the screen looks fine. Each test below is one settled fact.
import { describe, expect, it } from 'vitest';

import { ACTIVITIES } from '../activity.js';
import {
  isTonightTile,
  routeForTile,
  TILE_ROUTES,
  tileForSet,
  tilesForQueueActivity,
  TONIGHT_TILES,
} from './routing.js';

describe('the tile row', () => {
  it('is the settled six, in the settled order, with Surprise Me last', () => {
    expect([...TONIGHT_TILES]).toEqual([
      'video-games',
      'board-games',
      'movies',
      'shows',
      'reading',
      'surprise',
    ]);
    expect(TONIGHT_TILES.at(-1)).toBe('surprise');
  });

  it('has no Retro Games tile — MiSTer is Video Games', () => {
    expect(TONIGHT_TILES).not.toContain('retro-games');
    expect(routeForTile('video-games').providerKinds).toContain('mister');
  });

  it('has exactly one map row per tile, and every row names itself', () => {
    expect(Object.keys(TILE_ROUTES).sort()).toEqual([...TONIGHT_TILES].sort());
    for (const [tile, route] of Object.entries(TILE_ROUTES)) expect(route.tile).toBe(tile);
  });

  it('refuses anything that is not a tile at the API edge', () => {
    expect(isTonightTile('movies')).toBe(true);
    expect(isTonightTile('retro-games')).toBe(false);
    expect(isTonightTile('watching')).toBe(false);
    expect(isTonightTile(null)).toBe(false);
  });
});

describe('which backend serves which evening', () => {
  it('gives Video Games Steam and MiSTer together, and names the three that are not built', () => {
    expect(routeForTile('video-games').providerKinds).toEqual(['mister', 'steam']);
    expect(routeForTile('video-games').plannedProviderKinds).toEqual(['cemu', 'dolphin', 'eden']);
  });

  it('sends Movies and Shows to Plex, both drawing from `watching`', () => {
    expect(routeForTile('movies').queueActivity).toBe('watching');
    expect(routeForTile('shows').queueActivity).toBe('watching');
    expect(routeForTile('movies').providerKinds).toEqual(['plex']);
  });

  it('sends Reading to Kavita and Board Games to the absorbed picker', () => {
    expect(routeForTile('reading').providerKinds).toEqual(['kavita']);
    expect(routeForTile('board-games').providerKinds).toEqual(['board-game-picker']);
  });

  // YouTube is a FUTURE provider (brief §7) and is not built. It appears only in the planned
  // column; a row that moved it across would route an evening at a backend that does not exist.
  it('keeps YouTube planned and never built', () => {
    for (const route of Object.values(TILE_ROUTES)) {
      expect(route.providerKinds).not.toContain('youtube');
    }
    expect(routeForTile('shows').plannedProviderKinds).toContain('youtube');
  });

  it('lets Surprise Me reach no backend at all until it has been narrowed', () => {
    expect(routeForTile('surprise').providerKinds).toEqual([]);
    expect(routeForTile('surprise').queueActivity).toBeNull();
    expect(routeForTile('surprise').engine).toBe('narrow-first');
  });

  it('covers every queue activity the app has', () => {
    for (const activity of ACTIVITIES) {
      expect(tilesForQueueActivity(activity).length).toBeGreaterThan(0);
    }
  });
});

describe('tilesForQueueActivity — the map read backwards', () => {
  // ⚠️ THE OPEN QUESTION, in one assertion. `watching` is ONE activity and TWO tiles: the
  // queue model refuses a finer content list, and the tile row separates a film night from a
  // series night. Not a defect to fix here — the implementation plan §5 calls it the one open
  // question that changes the SCHEMA rather than a screen.
  it('answers two tiles for `watching`, and that is the residue', () => {
    expect(tilesForQueueActivity('watching')).toEqual(['movies', 'shows']);
  });

  it('answers exactly one for every other activity', () => {
    expect(tilesForQueueActivity('reading')).toEqual(['reading']);
    expect(tilesForQueueActivity('board-games')).toEqual(['board-games']);
    expect(tilesForQueueActivity('video-games')).toEqual(['video-games']);
  });
});

describe('tileForSet reads the STORED activity, never the provider kind', () => {
  it('maps three of the four activities straight onto a tile', () => {
    expect(tileForSet({ activity: 'reading' })).toBe('reading');
    expect(tileForSet({ activity: 'board-games' })).toBe('board-games');
    expect(tileForSet({ activity: 'video-games' })).toBe('video-games');
  });

  it('splits `watching` on the only marker a set carries', () => {
    expect(tileForSet({ activity: 'watching', behavior: 'rewatch' })).toBe('movies');
    expect(tileForSet({ activity: 'watching', behavior: 'progress' })).toBe('shows');
    // A curated queue has no `behavior` field at all, so it reads as Shows. That is the
    // documented residue, and it must stay the ONLY guess.
    expect(tileForSet({ activity: 'watching' })).toBe('shows');
    expect(tileForSet({ activity: 'watching', behavior: null })).toBe('shows');
  });
});
