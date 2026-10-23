// The queue-title rule in `shared/queueTitle.ts`, from the server's side of the import. The web
// pins the same functions in `web/src/lib/people.test.ts`; these cases are the ones the native
// TV catalog leans on. Invented cast: Ada, Grace and Linus.
import { describe, expect, it } from 'vitest';
import {
  queueListNumbers,
  queueNumbers,
  queueTitle,
  type ListedQueue,
  type NumberedMember,
} from '../../shared/queueTitle.js';

const member = (id: string): NumberedMember => ({ id, kind: 'person', role: 'required' });

describe('queueTitle', () => {
  it('prints a typed name verbatim and the activity when nothing was typed', () => {
    expect(queueTitle({ activity: 'watching', has_explicit_label: true, label: 'Anime' }, null)).toBe(
      'Anime',
    );
    // `label` falls back to the id on the registry; without the flag it is not a name.
    expect(queueTitle({ activity: 'watching', has_explicit_label: false, label: 'movies_shows' }, null)).toBe(
      'Movies & Shows',
    );
  });

  it('appends the number after a plain space, never a middle dot', () => {
    expect(queueTitle({ activity: 'watching' }, 2)).toBe('Movies & Shows 2');
  });

  it('never numbers a typed name', () => {
    expect(queueTitle({ activity: 'watching', has_explicit_label: true, label: 'Movies' }, 3)).toBe(
      'Movies',
    );
  });
});

describe('queueNumbers', () => {
  const nameless = (id: string, activity: ListedQueue['activity'] = 'watching'): ListedQueue => ({
    activity,
    id,
    source: 'queue',
  });

  it('leaves the first of its kind unnumbered and numbers the rest', () => {
    const numbers = queueNumbers([nameless('a'), nameless('b'), nameless('c')], {
      a: [member('ada')],
      b: [member('ada')],
      c: [member('ada')],
    });
    expect([...numbers.values()]).toEqual([null, 2, 3]);
  });

  it('does not collide two queues that differ by activity, by people or by source', () => {
    const numbers = queueNumbers(
      [nameless('a'), nameless('b', 'reading'), nameless('c'), { ...nameless('d'), source: 'rotation' }],
      { a: [member('ada')], b: [member('ada')], c: [member('grace')], d: [member('ada')] },
    );
    expect([...numbers.values()]).toEqual([null, null, null, null]);
  });

  it('treats the same people in a different order as the same card', () => {
    const numbers = queueNumbers([nameless('a'), nameless('b')], {
      a: [member('ada'), member('grace')],
      b: [member('grace'), member('ada')],
    });
    expect([...numbers.values()]).toEqual([null, 2]);
  });

  it('gives a NAMED queue no number and lets it use none up', () => {
    // A queue named "Movies" beside a nameless one for the same person: the nameless one is
    // "Movies & Shows", not "Movies & Shows 2" with no 1 anywhere.
    const numbers = queueNumbers(
      [{ ...nameless('named'), has_explicit_label: true, label: 'Movies' }, nameless('a'), nameless('b')],
      { named: [member('ada')], a: [member('ada')], b: [member('ada')] },
    );
    expect(numbers.get('named')).toBeNull();
    expect(numbers.get('a')).toBeNull();
    expect(numbers.get('b')).toBe(2);
  });
});

describe('queueListNumbers — the Queues page order', () => {
  it('nests a filtered queue under its parent before numbering', () => {
    // Registry order puts the window LAST; the page draws it right under its parent, so it is
    // the second card of its kind there, ahead of `later`.
    const sets: ListedQueue[] = [
      { activity: 'watching', id: 'parent', source: 'queue' },
      { activity: 'watching', id: 'later', source: 'queue' },
      { activity: 'watching', filtered_from: 'parent', id: 'window', source: 'queue' },
    ];
    const ada = [member('ada')];
    const numbers = queueListNumbers(sets, { later: ada, parent: ada, window: ada });
    expect(numbers.get('parent')).toBeNull();
    expect(numbers.get('window')).toBe(2);
    expect(numbers.get('later')).toBe(3);
  });

  it('numbers the Rules queues on their own and leaves a superseded tier out', () => {
    const sets: ListedQueue[] = [
      { activity: 'watching', id: 'legacy', source: 'rotation', superseded_by: 'rules_a' },
      { activity: 'watching', id: 'rules_a', source: 'rotation' },
      { activity: 'watching', id: 'picks_a', source: 'queue' },
      { activity: 'watching', id: 'rules_b', source: 'rotation' },
    ];
    const numbers = queueListNumbers(sets, {});
    expect(numbers.has('legacy')).toBe(false);
    expect(numbers.get('rules_a')).toBeNull();
    expect(numbers.get('picks_a')).toBeNull();
    expect(numbers.get('rules_b')).toBe(2);
  });
});
