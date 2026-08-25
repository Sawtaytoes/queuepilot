import { Hono } from 'hono';

import { errMessage } from '../errors.js';
import { listPeople } from '../store/db/people.js';

/**
 * `GET /api/people` — the roster, as a SCREEN needs it.
 *
 * WP-3 landed people as rows and nothing has read them over HTTP until now. The Tonight
 * surface's first step is a checklist of the household, so this is the smallest thing that
 * makes that step real rather than a stub.
 *
 * ## It projects, deliberately
 *
 * The stored `Person` also carries provider accounts, a birth year, a maximum game weight
 * and a beginner flag. None of those paints a checklist, and a birth year is household data
 * with no business crossing the wire to do it — this repo is public and the split it lives
 * by is "schema and code here, data in App-Configs". Three fields go out: the id, the
 * display name and the roster position. Widening that is a deliberate act with a reason,
 * not a convenience for the next caller.
 *
 * ## Read-only, on purpose
 *
 * There is no POST and no PATCH here. People arrive through the owner-confirmed mapping
 * file (`store/migrate/people.ts`), which writes nothing until a human sets
 * `confirmed: true`, and a create endpoint would be a second door into the same table with
 * none of that gate. People ADMIN is its own screen and its own change.
 *
 * ## Ordering
 *
 * `listPeople()` already answers in `position, id` order and the array order IS the
 * contract — a roster order is somebody's decision, and re-sorting it alphabetically in the
 * browser would silently throw that away.
 *
 * Under `STORE_BACKEND=yaml` the table is empty by design (people arrived after the SQLite
 * cutover and have never had a file), so this answers `{people: []}` there rather than
 * failing. An empty roster is a real state on a fresh install too — the import is gated and
 * may simply not have been run.
 */
export function peopleRoutes(): Hono {
  const app = new Hono();

  app.get('/people', (c) => {
    try {
      return c.json({
        people: listPeople().map((person) => ({
          displayName: person.displayName,
          id: person.id,
          position: person.position,
        })),
      });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 500);
    }
  });

  return app;
}
