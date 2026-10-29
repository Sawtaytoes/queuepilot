import { randomUUID } from 'node:crypto';

export interface ChooserQueue { id: string; title: string; kind: string; profile?: string }
export interface ChooserPerson { id: string; name: string; artworkPath?: string }
export interface ChooserState {
  sessionId: string;
  revision: string;
  isActive: boolean;
  expiresAt: number;
  people: ChooserPerson[];
  queues: ChooserQueue[];
  message?: string;
}
interface Selection extends ChooserState { timer?: ReturnType<typeof setTimeout> }

/** Reader-local selections never start playback until a current, eligible queue is tapped. */
export const createChooser = ({ catalog, person, publish, now = Date.now }: {
  catalog: (people: string[]) => Promise<ChooserQueue[]>;
  person: (id: string) => ChooserPerson | undefined;
  publish: (reader: string, state: ChooserState, event: 'show' | 'close' | 'play', queue?: ChooserQueue) => void;
  now?: () => number;
}) => {
  const selections = new Map<string, Selection>();
  const chains = new Map<string, Promise<void>>();
  const scans = new Map<string, number>();
  const emit = (reader: string, selection: Selection, event: 'show' | 'close' | 'play', queue?: ChooserQueue) => {
    const { timer: _timer, ...state } = selection;
    publish(reader, state, event, queue);
  };
  const close = (reader: string, event: 'close' | 'play' = 'close', queue?: ChooserQueue) => {
    const selection = selections.get(reader);
    if (!selection) return;
    clearTimeout(selection.timer);
    selections.delete(reader);
    emit(reader, { ...selection, isActive: false, expiresAt: now(), queues: [] }, event, queue);
  };
  const show = (reader: string, selection: Selection) => {
    clearTimeout(selection.timer);
    selection.expiresAt = now() + 60_000;
    selection.timer = setTimeout(() => close(reader), 60_000);
    selection.timer.unref?.();
    selections.set(reader, selection);
    emit(reader, selection, 'show');
  };
  const process = async (reader: string, input: Record<string, unknown>) => {
    const current = selections.get(reader);
    if (current && current.expiresAt <= now()) close(reader);
    const selection = selections.get(reader);
    if (input.action === 'scan') {
      const age = now() - Number(input.atMs);
      const personId = typeof input.personId === 'string' ? input.personId : '';
      const found = person(personId);
      if (!found || !Number.isFinite(age) || age < 0 || age > 30_000 || typeof input.eventId !== 'string' || !input.eventId) return;
      scans.forEach((timestamp, key) => { if (now() - timestamp > 60_000) scans.delete(key); });
      const key = `${reader}:${input.eventId}`;
      if (scans.has(key)) return;
      scans.set(key, now());
      const people = selection?.people.some((entry) => entry.id === found.id)
        ? selection.people : (selection?.people ?? []).concat(found);
      const next: Selection = {
        sessionId: selection?.sessionId ?? randomUUID(), revision: randomUUID(),
        isActive: true, expiresAt: now() + 60_000, people, queues: [],
      };
      clearTimeout(selection?.timer);
      try { next.queues = await catalog(people.map((entry) => entry.id)); }
      catch { next.message = 'Queues could not be loaded. Scan again to retry.'; }
      show(reader, next);
      return;
    }
    if (!selection) return;
    // The trusted room controller dismisses on a physical edge swipe. UI actions also
    // carry the session/revision so a delayed frame cannot operate a newer selection.
    if (input.action === 'dismiss' && input.sessionId === undefined) { close(reader); return; }
    if (input.sessionId !== selection.sessionId || input.revision !== selection.revision) return;
    if (input.action === 'dismiss' || input.action === 'reset') { close(reader); return; }
    if (input.action === 'touch') { show(reader, selection); return; }
    if (input.action === 'remove' && typeof input.personId === 'string') {
      selection.people = selection.people.filter((entry) => entry.id !== input.personId);
      if (!selection.people.length) { close(reader); return; }
      selection.revision = randomUUID();
      selection.queues = await catalog(selection.people.map((entry) => entry.id));
      if (selections.get(reader) !== selection || selection.expiresAt <= now()) return;
      show(reader, selection);
      return;
    }
    if (input.action === 'choose' && typeof input.queueId === 'string') {
      const queues = await catalog(selection.people.map((entry) => entry.id));
      // Re-check expiry after the async catalog read; no playback from an expired screen.
      if (selections.get(reader) !== selection || selection.expiresAt <= now()) return;
      const queue = queues.find((entry) => entry.id === input.queueId);
      if (!queue) {
        selection.queues = queues;
        selection.message = 'That queue is no longer available. Choose another queue.';
        show(reader, selection);
        return;
      }
      close(reader, 'play', queue);
    }
  };
  return {
    handle: (reader: string, input: Record<string, unknown>) => {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(reader) || (!selections.has(reader) && selections.size >= 64)) return Promise.resolve();
      const pending = (chains.get(reader) ?? Promise.resolve()).then(() => process(reader, input)).catch(() => {
        const selection = selections.get(reader);
        if (selection) {
          selection.message = 'Queues could not be loaded. Scan again to retry.';
          show(reader, selection);
        }
      });
      chains.set(reader, pending);
      void pending.then(() => { if (chains.get(reader) === pending) chains.delete(reader); });
      return pending;
    },
    clear: () => Array.from(selections.keys()).forEach((reader) => close(reader)),
  };
};
