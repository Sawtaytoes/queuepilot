// The Pending screen's two decisions, as rows: the watermark in a singleton `pending_state`,
// the per-item dismissals in `pending_dismissed`.
//
// Same interface as `store/pending.ts` (PendingStore) — `read`/`write` over a plain state
// object, not a `Document`. That asymmetry is the seam's and is deliberate: `pending.yaml` is
// written whole every time and has no hand-authored structure to preserve.
//
// The one distinction the schema has to keep is `libraries: null` versus `libraries: []`.
// `null` means nobody has chosen and the screen falls back to every video library; `[]` is a
// real answer meaning no libraries at all, and is a page the owner can pick on purpose. A
// column that collapsed the two would hand him the wrong screen and give him no way to say so.
import { STORE_YAML_MIRROR } from '../../config.js';
import { errMessage } from '../../errors.js';
import * as yamlPending from '../pending.js';
import type { PendingState } from '../pending.js';
import type { PendingStore } from '../index.js';
import { bumpVersion } from './common.js';
import { bookOfRecord, prepareChecked } from './open.js';
import { ensureImported, noteMirrorWrite } from '../migrate/yaml.js';

export const path = yamlPending.path;

interface StateRow {
  seen_through: number;
  libraries: string | null;
}

export async function read(): Promise<PendingState> {
  try {
    ensureImported();
    const db = bookOfRecord();
    const state = prepareChecked<StateRow>(
      db,
      'SELECT seen_through, libraries FROM pending_state WHERE id = 1',
    ).get();
    const dismissed = prepareChecked<{ rating_key: string }>(
      db,
      'SELECT rating_key FROM pending_dismissed ORDER BY position',
    ).all();

    return {
      seen_through: Number(state?.seen_through) || 0,
      dismissed: dismissed.map((row) => String(row.rating_key)),
      libraries:
        state?.libraries == null
          ? null
          : (JSON.parse(state.libraries) as unknown[])
              .map(Number)
              .filter((id) => Number.isFinite(id)),
    };
  } catch (e) {
    // The file store logs and returns the empty state rather than throwing, because the
    // Pending screen is not worth a 500. Same policy.
    console.log(`[pending] could not read the store: ${errMessage(e)}`);
    return { seen_through: 0, dismissed: [], libraries: null };
  }
}

export async function write(next: PendingState): Promise<void> {
  const db = bookOfRecord();

  db.withTransaction(() => {
    prepareChecked(
      db,
      'INSERT INTO pending_state (id, seen_through, libraries) VALUES (1, :seen_through, :libraries) ' +
        'ON CONFLICT (id) DO UPDATE SET seen_through = excluded.seen_through, libraries = excluded.libraries',
    ).run({
      seen_through: Math.trunc(Number(next.seen_through) || 0),
      libraries: next.libraries === null ? null : JSON.stringify(next.libraries),
    });

    prepareChecked(db, 'DELETE FROM pending_dismissed').run();
    const insert = prepareChecked(
      db,
      'INSERT OR REPLACE INTO pending_dismissed (rating_key, position) VALUES (:rating_key, :position)',
    );
    next.dismissed.forEach((ratingKey, position) => {
      insert.run({ rating_key: String(ratingKey), position });
    });

    bumpVersion(db, 'pending');
  });

  if (STORE_YAML_MIRROR) {
    await yamlPending.write(next);
    // The files now hold what the rows hold. Recording that here is what stops the next
    // read treating our own mirror write as somebody else's hand-edit.
    noteMirrorWrite();
  }
}

export const store: PendingStore = { path, read, write };
