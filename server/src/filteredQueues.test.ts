// A FILTERED queue is a VIEW of another queue, and these are the rules that make it one:
// it inherits everything, it owns its name and its filter, its provider block is narrowed to
// what it shows, and an item that cannot say which library it is in is kept rather than lost.
//
// The fixture library ids are 2 and 5 and the queue is "Reading" — invented, like every
// fixture in this repo (AGENTS.md).
import { describe, expect, it } from 'vitest';

import {
  filterOf,
  inheritFilteredQueues,
  parentIdOf,
  passesFilter,
  type FilterableEntry,
} from './filteredQueues.js';

const parent: FilterableEntry = {
  add_as: 'random',
  episodes: 2,
  id: 'reading',
  kind: 'picks',
  label: 'Comics & Strips',
  providers: [{ libraries: ['2', '5'], provider: 'kavita' }],
  skipped: ['901'],
  source: 'queue',
};

const child: FilterableEntry = {
  filter: { libraries: ['5'] },
  filtered_from: 'reading',
  id: 'strips',
  label: 'Strips',
};

const resolve = (entries: FilterableEntry[]) => {
  const out = new Map(
    inheritFilteredQueues(entries).map((e) => [String(e.id), e]),
  );
  return out;
};

describe('parentIdOf / filterOf', () => {
  it('reads the parent and the filter off a filtered entry', () => {
    expect(parentIdOf(child)).toBe('reading');
    expect(filterOf(child)).toEqual({ libraries: ['5'] });
  });

  it('reports no filter at all for an ordinary queue', () => {
    expect(parentIdOf(parent)).toBeNull();
    expect(filterOf(parent)).toBeNull();
  });

  it('is still a filtered queue when its filter says nothing yet', () => {
    const bare = { filtered_from: 'reading', id: 'strips' };
    expect(parentIdOf(bare)).toBe('reading');
    // A filter with empty lists, NOT null: "is this a view" and "what does it exclude" are
    // two questions, and a half-configured view is still a view.
    expect(filterOf(bare)).toEqual({ libraries: [] });
  });
});

describe('inheritFilteredQueues', () => {
  it('gives the filtered queue everything the parent has', () => {
    const strips = resolve([parent, child]).get('strips');
    expect(strips?.source).toBe('queue');
    expect(strips?.kind).toBe('picks');
    expect(strips?.add_as).toBe('random');
    expect(strips?.episodes).toBe(2);
    // The skip list is shared, like the entries: it is progress, not presentation.
    expect(strips?.skipped).toEqual(['901']);
  });

  it('keeps the filtered queue’s own id, name and filter', () => {
    const strips = resolve([parent, child]).get('strips');
    expect(strips?.id).toBe('strips');
    expect(strips?.label).toBe('Strips');
    expect(strips?.filtered_from).toBe('reading');
    expect(strips?.filter).toEqual({ libraries: ['5'] });
  });

  it('narrows the inherited provider block to the filter’s libraries', () => {
    const strips = resolve([parent, child]).get('strips');
    expect(strips?.providers).toEqual([
      { libraries: ['5'], provider: 'kavita' },
    ]);
    // The PARENT is untouched — inheritance copies, it does not move.
    expect(parent.providers).toEqual([
      { libraries: ['2', '5'], provider: 'kavita' },
    ]);
  });

  it('takes the filter whole when the parent claims no libraries', () => {
    // No libraries on the parent means EVERY library, so there is nothing to intersect with.
    const open = { ...parent, providers: [{ provider: 'kavita' }] };
    const strips = resolve([open, child]).get('strips');
    expect(strips?.providers).toEqual([
      { libraries: ['5'], provider: 'kavita' },
    ]);
  });

  it('leaves an ordinary queue exactly as it was', () => {
    expect(resolve([parent, child]).get('reading')).toEqual(parent);
  });

  it('leaves a dangling parent reference alone rather than inventing a queue', () => {
    const orphan = { ...child, filtered_from: 'nothing-here' };
    // Unchanged: no provider, no entries. That is what a typo should look like — a queue that
    // half works would hide it.
    expect(resolve([parent, orphan]).get('strips')).toEqual(orphan);
  });

  it('refuses a filter of a filter', () => {
    const grandchild: FilterableEntry = {
      filter: { libraries: ['5'] },
      filtered_from: 'strips',
      id: 'strips-2',
      label: 'Strips 2',
    };
    const out = resolve([parent, child, grandchild]);
    // One hop only: the grandchild keeps its own sparse record and inherits nothing.
    expect(out.get('strips-2')).toEqual(grandchild);
    expect(out.get('strips')?.providers).toEqual([
      { libraries: ['5'], provider: 'kavita' },
    ]);
  });

  it('inherits from a parent written after it in the file', () => {
    expect(resolve([child, parent]).get('strips')?.source).toBe('queue');
  });
});

describe('passesFilter', () => {
  const filter = { libraries: ['5'] };

  it('keeps an item in one of the filter’s libraries', () => {
    expect(passesFilter(filter, { libraryId: '5' })).toBe(true);
    expect(passesFilter(filter, { libraryId: 5 })).toBe(true);
  });

  it('drops an item from another library', () => {
    expect(passesFilter(filter, { libraryId: '2' })).toBe(false);
  });

  it('KEEPS an item that cannot say which library it is in', () => {
    // A lookup that failed must not silently delete one of the owner's entries. Showing him
    // one that does not belong is visible; losing one is not.
    expect(passesFilter(filter, { libraryId: null })).toBe(true);
    expect(passesFilter(filter, { libraryId: '' })).toBe(true);
  });

  it('narrows nothing when there is no filter, or an empty one', () => {
    expect(passesFilter(null, { libraryId: '2' })).toBe(true);
    expect(passesFilter({ libraries: [] }, { libraryId: '2' })).toBe(true);
  });
});
