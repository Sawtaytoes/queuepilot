// The queue-first draw (WP-7): who the queues are for, which backend the session binds to,
// and the order the queues come out in.
//
// Randomness is injected everywhere, so these assert the ORDER a given sequence produces
// rather than asserting that something came back. The cast is Ada, Grace and Linus.
import { describe, expect, it } from 'vitest';

import type { GroupMembership, QueueMember } from '../queuePeople.js';
import type { PlayItem } from '../types.js';
import type { CandidateSet, TonightCandidate } from './pick.js';

import {
  candidatesFor,
  chooseBackend,
  drawQueues,
  firstUnfinishedEntry,
  orderCandidates,
  playItemLabel,
  toResolvedMembers,
} from './pick.js';

/** A number sequence standing in for `Math.random`, so a draw has one right answer. */
const rolls = (...values: number[]): (() => number) => {
  let index = 0;
  return () => values[index++] ?? 0;
};

const set = (over: Partial<CandidateSet> & Pick<CandidateSet, 'id'>): CandidateSet => ({
  activity: 'watching',
  delivery: 'push',
  enabled: true,
  label: '',
  provider_kind: 'plex',
  source: 'queue',
  vocabulary: { name: 'Plex' },
  ...over,
});

const candidate = (
  over: Partial<TonightCandidate> & Pick<TonightCandidate, 'setId'>,
): TonightCandidate => ({
  delivery: 'push',
  providerId: 'plex',
  providerKind: 'plex',
  providerLabel: 'Plex',
  queueActivity: 'watching',
  setLabel: 'Movies',
  source: 'queue',
  tile: 'shows',
  ...over,
});

const person = (id: string, role: QueueMember['role'] = 'required'): QueueMember => ({
  id,
  kind: 'person',
  position: 0,
  role,
});

const group = (id: string, role: QueueMember['role'] = 'required'): QueueMember => ({
  id,
  kind: 'group',
  position: 0,
  role,
});

const membership = (
  groupId: string,
  people: string[],
  minPresent: number | null,
): GroupMembership => ({
  groupId,
  minPresent,
  roster: people.map((personId, position) => ({ personId, position, role: 'required' })),
});

describe('toResolvedMembers — a group is a set, a number and a spare', () => {
  it('makes a person themself, counting one', () => {
    expect(toResolvedMembers([person('ada')], () => null)).toEqual([
      { ...person('ada'), minPresent: 1, people: ['ada'] },
    ]);
  });

  it('makes a group its required roster, counting its own number', () => {
    const resolved = toResolvedMembers([group('older-kids')], () =>
      membership('older-kids', ['grace', 'linus'], 1));

    expect(resolved[0]?.people).toEqual(['grace', 'linus']);
    expect(resolved[0]?.minPresent).toBe(1);
  });

  it('resolves `min_present: null` to all of them, not to one', () => {
    const resolved = toResolvedMembers([group('both')], () =>
      membership('both', ['ada', 'grace'], null));

    expect(resolved[0]?.minPresent).toBe(2);
  });

  // A group nothing knows about is an EMPTY required member, which can never be satisfied, so
  // the queue drops out of the filter. That is the safe direction: a queue that should have
  // been offered and was not is visible on the screen; one offered to the wrong people is not.
  it('drops a queue keyed on a group that no longer exists', () => {
    const resolved = toResolvedMembers([group('gone')], () => null);
    expect(resolved[0]?.people).toEqual([]);
  });
});

describe('candidatesFor — the queues a session could draw', () => {
  const sets = [
    set({ activity: 'watching', behavior: 'rewatch', id: 'movies-ada', label: 'Movies' }),
    set({ activity: 'watching', id: 'shows-ada-grace', label: 'Shows' }),
    set({
      activity: 'reading',
      id: 'reading-linus',
      label: 'Reading',
      provider_kind: 'kavita',
      vocabulary: { name: 'Kavita' },
    }),
  ];

  const base = {
    membershipFor: () => null,
    membersByQueue: new Map<string, QueueMember[]>([
      ['movies-ada', [person('ada')]],
      ['shows-ada-grace', [person('ada'), person('grace')]],
      ['reading-linus', [person('linus')]],
    ]),
    personIds: [] as string[],
    providerIdFor: (setId: string) => (setId === 'reading-linus' ? 'kavita' : 'plex'),
    sets,
  };

  it('narrows to the tile — a rewatch rotation is a film night', () => {
    expect(candidatesFor({ ...base, tile: 'movies' }).map((one) => one.setId))
      .toEqual(['movies-ada']);
    expect(candidatesFor({ ...base, tile: 'shows' }).map((one) => one.setId))
      .toEqual(['shows-ada-grace']);
  });

  // Nobody ticked is no filter at all — the correction the WP-6 agent found and the decision
  // records at the end of §5. Read strictly the rule would hide every queue that names anybody.
  it('offers everything when nobody is ticked', () => {
    expect(candidatesFor({ ...base, tile: 'reading' }).map((one) => one.setId))
      .toEqual(['reading-linus']);
  });

  it('hides a queue that a ticked person is not on', () => {
    // Grace is not on the movies queue, so ticking her hides it — the decision's own example.
    expect(
      candidatesFor({ ...base, personIds: ['ada', 'grace'], tile: 'movies' }),
    ).toEqual([]);
    expect(
      candidatesFor({ ...base, personIds: ['ada', 'grace'], tile: 'shows' })
        .map((one) => one.setId),
    ).toEqual(['shows-ada-grace']);
  });

  it('honours "at least one of the kids"', () => {
    const kids = [set({ activity: 'watching', id: 'kids-shows', label: 'Shows' })];
    const withKids = {
      ...base,
      membershipFor: () => membership('older-kids', ['grace', 'linus'], 1),
      membersByQueue: new Map([['kids-shows', [group('older-kids')]]]),
      sets: kids,
      tile: 'shows' as const,
    };

    expect(candidatesFor({ ...withKids, personIds: ['grace'] })).toHaveLength(1);
    expect(candidatesFor({ ...withKids, personIds: ['linus'] })).toHaveLength(1);
    // Ada is not one of the kids, so she is not ON the queue and it goes.
    expect(candidatesFor({ ...withKids, personIds: ['ada'] })).toEqual([]);
  });

  it('never offers a disabled queue', () => {
    expect(
      candidatesFor({
        ...base,
        sets: [set({ enabled: false, id: 'off', label: 'Shows' })],
        tile: 'shows',
      }),
    ).toEqual([]);
  });

  // A mixed queue is a push target and a pull URL at once, and `launchDescriptor` refuses one
  // with a 501. Drawing a card off it would give it a Go that cannot work.
  it('never offers a queue that draws from two providers', () => {
    expect(
      candidatesFor({ ...base, providerIdFor: () => null, tile: 'shows' }),
    ).toEqual([]);
  });

  it('forgets nothing — an excluded queue stays excluded', () => {
    expect(
      candidatesFor({ ...base, excludedSetIds: ['shows-ada-grace'], tile: 'shows' }),
    ).toEqual([]);
  });

  it('stays on the bound backend once a session has one', () => {
    expect(
      candidatesFor({ ...base, boundBackend: 'kavita', tile: 'shows' }),
    ).toEqual([]);
  });

  it('carries the provider product name for the card badge', () => {
    expect(candidatesFor({ ...base, tile: 'reading' })[0]?.providerLabel).toBe('Kavita');
  });

  it('a queue with no name carries its ACTIVITY, never its wire id', () => {
    // It fell back to the id until 2026-08-26, which put a slug on the result card. A name
    // is optional now and the activity is what fills in
    // (decision 2026-08-26-a-queue-name-is-optional-and-the-activity-fills-in).
    expect(
      candidatesFor({
        ...base,
        sets: [set({ id: 'unnamed' })],
        tile: 'shows',
      })[0]?.setLabel,
    ).toBe('Movies & Shows');
  });

  it('…and a name somebody typed is carried verbatim', () => {
    expect(
      candidatesFor({
        ...base,
        sets: [set({ has_explicit_label: true, id: 'named', label: 'Manga & Webtoons' })],
        tile: 'shows',
      })[0]?.setLabel,
    ).toBe('Manga & Webtoons');
  });
});

describe('one session talks to one backend', () => {
  const steamOne = candidate({ providerId: 'steam', setId: 'steam-1', tile: 'video-games' });
  const steamTwo = candidate({ providerId: 'steam', setId: 'steam-2', tile: 'video-games' });
  const mister = candidate({ providerId: 'mister', setId: 'mister-1', tile: 'video-games' });

  it('is bound before it starts when one backend serves the activity', () => {
    expect(chooseBackend([steamOne, steamTwo], rolls(0.9))).toBe('steam');
  });

  it('draws the backend when two serve it, rather than taking the first', () => {
    // An evening that could be Steam or MiSTer is a normal evening. What is NOT allowed is
    // wandering between them once one has been drawn.
    expect(chooseBackend([steamOne, mister], rolls(0))).toBe('steam');
    expect(chooseBackend([steamOne, mister], rolls(0.99))).toBe('mister');
  });

  it('binds nothing when there is nothing to draw', () => {
    expect(chooseBackend([], rolls(0))).toBeNull();
  });

  it('drops every queue outside the drawn backend', () => {
    const drawn = drawQueues([steamOne, mister, steamTwo], rolls(0, 0, 0));
    expect(drawn.backend).toBe('steam');
    expect(drawn.ordered.map((one) => one.setId).sort()).toEqual(['steam-1', 'steam-2']);
  });
});

describe('orderCandidates — a shuffle, not a sort', () => {
  const three = [candidate({ setId: 'a' }), candidate({ setId: 'b' }), candidate({ setId: 'c' })];

  it('is deterministic for a given sequence', () => {
    // Fisher-Yates walks i = 2 then i = 1. `0.99` takes the last index each time, so nothing
    // swaps out of place; the answer is the input order.
    expect(orderCandidates(three, rolls(0.99, 0.99)).map((one) => one.setId))
      .toEqual(['a', 'b', 'c']);
    // `0` takes index 0 each time: [a,b,c] -> swap i=2 with j=0 -> [c,b,a] -> swap i=1 with
    // j=0 -> [b,c,a].
    expect(orderCandidates(three, rolls(0, 0)).map((one) => one.setId))
      .toEqual(['b', 'c', 'a']);
  });

  it('keeps every queue — a shuffle loses nothing', () => {
    expect(orderCandidates(three, rolls(0.4, 0.7)).map((one) => one.setId).sort())
      .toEqual(['a', 'b', 'c']);
  });

  it('leaves one and none alone', () => {
    expect(orderCandidates([], rolls(0.5))).toEqual([]);
    expect(orderCandidates([three[0] as TonightCandidate], rolls(0.5))).toHaveLength(1);
  });
});

describe('playItemLabel — one lineup item, said in words', () => {
  it('names the SHOW and puts the episode code beside it', () => {
    expect(
      playItemLabel({ episode: 4, ratingKey: '1', season: 2, show: 'Harbour Lantern', title: 'The Tide' } as PlayItem),
    ).toEqual({ detail: 'S02E04 · The Tide', title: 'Harbour Lantern' });
  });

  it('names a film by its own title, with no code to add', () => {
    expect(playItemLabel({ ratingKey: '7', title: 'Quarry Duel' } as PlayItem))
      .toEqual({ detail: null, title: 'Quarry Duel' });
  });

  it('counts a reading item in chapters, and a whole volume in volumes', () => {
    expect(playItemLabel({ chapterId: 9, number: 113, seriesId: 2, title: 'Tidewright' } as PlayItem))
      .toEqual({ detail: 'Ch 113', title: 'Tidewright' });
    expect(
      playItemLabel({ chapterId: 9, number: 3, seriesId: 2, title: 'Tidewright', unit: 'volume' } as PlayItem),
    ).toEqual({ detail: 'Vol 3', title: 'Tidewright' });
  });

  it('names a game by its title, whichever backend it came from', () => {
    expect(playItemLabel({ appid: '400', title: 'Portal' } as PlayItem).title).toBe('Portal');
    expect(playItemLabel({ path: '/games/SNES/x.sfc', title: 'Super Widget' } as PlayItem).title)
      .toBe('Super Widget');
  });

  // A shape nothing recognises still answers with something a card can print. An unnamed card
  // is a worse failure than a thin one.
  it('never answers with an empty title', () => {
    expect(playItemLabel({ chapterId: 1, seriesId: 1, title: '' } as PlayItem).title).toBe('Next up');
  });
});

describe('firstUnfinishedEntry — the head of a curated queue, off our own store', () => {
  it('skips what is already done', () => {
    expect(
      firstUnfinishedEntry([
        { display: 'Watched Thing', done: true },
        { display: 'Next Thing', done: false },
      ]),
    ).toBe('Next Thing');
  });

  it('answers null when the whole queue is finished', () => {
    expect(firstUnfinishedEntry([{ display: 'Done', done: true }])).toBeNull();
    expect(firstUnfinishedEntry([])).toBeNull();
  });

  it('skips an entry with nothing to print rather than showing a blank line', () => {
    expect(firstUnfinishedEntry([{ display: '', done: false }])).toBeNull();
  });
});
