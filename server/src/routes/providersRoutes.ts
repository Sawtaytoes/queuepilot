import { Hono } from 'hono';
import { errMessage } from '../errors.js';
import * as providers from '../providers/config.js';
import { providerFor } from '../providers/index.js';
import { binaryResponse } from './binaryResponse.js';
import { readBody } from './readBody.js';

/**
 * --- App Connectors ----------------------------------------------------------- //
 * The provider surface. Definitions are plaintext and freely readable; TOKENS ARE
 * WRITE-ONLY — there is no route that returns one, and `configured` is a boolean rather
 * than a masked prefix, because a masked token is still a leak when the secret is short.
 */
export function providersRoutes(): Hono {
  const app = new Hono();

  app.get('/providers', (c) => c.json({ providers: providers.publicList() }));

  // Set or replace one provider's token. Write-only by design.
  //
  // Excluded from the undo snapshot (see routes/undoSnapshot.ts) — a credential copied into
  // the undo stack has escaped its file.
  app.post('/providers/:id/token', async (c) => {
    const { token } = await readBody(c);
    if (typeof token !== 'string' || !token.trim()) {
      return c.json({ error: 'a non-empty token is required' }, 400);
    }
    try {
      const def = providers.definitionFor(c.req.param('id'));
      if (!def) return c.json({ error: 'unknown provider' }, 404);
      await providers.writeSecret(def.id, token.trim());
      // Echo the PUBLIC view only. Never the token, not even the one just supplied.
      return c.json({ ok: true, provider: providers.publicView(def) });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 500);
    }
  });

  app.delete('/providers/:id/token', async (c) => {
    try {
      const def = providers.definitionFor(c.req.param('id'));
      if (!def) return c.json({ error: 'unknown provider' }, 404);
      await providers.deleteSecret(def.id);
      return c.json({ ok: true, provider: providers.publicView(def) });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 500);
    }
  });

  // The libraries a provider offers, for the queue editor's provider block. Plex keeps its own
  // long-standing routes; this is the provider-scoped one a non-Plex block needs.
  app.get('/providers/:id/libraries', async (c) => {
    try {
      const p = providerFor(c.req.param('id'));
      if (typeof p.libraries !== 'function') {
        return c.json({ libraries: [], note: `${p.label} does not enumerate libraries here` });
      }
      return c.json({ libraries: await p.libraries() });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 503);
    }
  });

  // Provider-scoped series search — the non-Plex half of /api/search. Scoped to the libraries
  // the queue draws from, so it never offers something that queue could not play.
  app.get('/providers/:id/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (!q) return c.json({ results: [] });
    try {
      const p = providerFor(c.req.param('id'));
      if (typeof p.search !== 'function') return c.json({ results: [] });
      const libraries = (c.req.query('libraries') ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      return c.json({ results: await p.search(q, { libraries }) });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 503);
    }
  });

  // Cover proxy. The Kavita image endpoint REQUIRES the API key as a query parameter, so the
  // browser must never be handed one of its URLs — that would put a live credential in the
  // page source, the network tab and any screenshot (the hazard docs/kavita-feasibility.md
  // flags about /api/opds/<apiKey>). The key stays here; the browser gets bytes. Same shape as
  // /api/thumb for Plex.
  app.get('/providers/:id/cover/:itemId', async (c) => {
    try {
      const p = providerFor(c.req.param('id'));
      if (typeof p.cover !== 'function') return c.body(null, 404);
      const { buffer, contentType } = await p.cover(c.req.param('itemId'));
      return binaryResponse({
        buffer,
        // Covers change only when the series art does; a day is the same bet /api/thumb makes.
        cacheControl: 'public, max-age=86400',
        contentType,
      });
    } catch {
      // A missing cover is normal (a series with no art). 404 rather than 500 so the tile
      // falls back to its placeholder instead of logging an error per render.
      return c.body(null, 404);
    }
  });

  return app;
}
