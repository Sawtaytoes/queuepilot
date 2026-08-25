// The activity vocabulary, and the one property that lets WP-5 migrate sixteen queues without
// writing a byte: every provider serves exactly one activity, so the answer is a lookup.
import { describe, expect, it } from 'vitest';

import {
  ACTIVITIES,
  ACTIVITY_LABELS,
  activityForProviderKind,
  activityForSet,
  isActivity,
} from './activity.js';

describe('the activity is what you are DOING, not which vendor serves it', () => {
  it('gives every provider this app has exactly one activity', () => {
    expect(activityForProviderKind('plex')).toBe('watching');
    expect(activityForProviderKind('kavita')).toBe('reading');
    expect(activityForProviderKind('board-game-picker')).toBe('board-games');
    expect(activityForProviderKind('steam')).toBe('video-games');
    // MiSTer is Video Games, not a "Retro Games" of its own — "'Video Games' would include
    // MiSTer and Steam and Switch (Eden) and Wii U (Cemu), and GameCube/Wii (Dolphin)."
    expect(activityForProviderKind('mister')).toBe('video-games');
  });

  it('answers `watching` for a provider it has never heard of', () => {
    // Every set that predates a non-Plex provider is a Plex set, so this is the fallback that
    // cannot surprise anybody — and a new provider gets a real row in the same change.
    expect(activityForProviderKind('some-future-thing')).toBe('watching');
    expect(activityForProviderKind(null)).toBe('watching');
  });

  it('names four activities and labels every one of them', () => {
    expect(ACTIVITIES).toEqual(['watching', 'reading', 'video-games', 'board-games']);
    for (const activity of ACTIVITIES) expect(ACTIVITY_LABELS[activity]).toBeTruthy();
  });

  it('keeps Movies and Shows as ONE activity', () => {
    // The finer list was rejected on a specific failure: "the Older Kids queue would show up
    // under both Shows and Shorts, but I don't think of it like that in my head."
    expect(ACTIVITY_LABELS.watching).toBe('Movies & Shows');
    expect(isActivity('anime')).toBe(false);
    expect(isActivity('shows')).toBe(false);
  });
});

describe('a stored activity is an override, and a bad one is ignored', () => {
  it('prefers the stored value over the provider', () => {
    expect(activityForSet({ activity: 'reading', provider_kind: 'plex' })).toBe('reading');
  });

  it('falls back to the provider when nothing is stored', () => {
    expect(activityForSet({ provider_kind: 'kavita' })).toBe('reading');
  });

  it('ignores a value that is not one of the four rather than propagating it', () => {
    // A typo in a hand-edited `sets.yaml` should put the queue under its provider's activity,
    // not under a heading that exists nowhere and hides it from every screen.
    expect(activityForSet({ activity: 'moovies', provider_kind: 'plex' })).toBe('watching');
  });
});
