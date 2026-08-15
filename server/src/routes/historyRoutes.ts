import { Hono } from 'hono';
import * as history from '../history.js';

/**
 * The undo/redo stack's own surface. Deliberately separate from the snapshot middleware that
 * FEEDS the stack (`undoSnapshot.ts`): these three routes are excluded from it, because they
 * manage the stack rather than mutate the files behind its back.
 */
export function historyRoutes(): Hono {
  const app = new Hono();

  app.post('/undo', async (c) => c.json(await history.undo()));
  app.post('/redo', async (c) => c.json(await history.redo()));
  app.get('/history', (c) => c.json(history.counts()));

  return app;
}
