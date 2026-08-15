import { Hono } from 'hono';
import * as plex from '../plex.js';
import * as providerBlocks from '../providers/blocks.js';
import { coverUrl, providerFor } from '../providers/index.js';
import * as sets from '../sets.js';
import { parseSearchQuery, rankByYear } from '../searchQuery.js';
import { binaryResponse } from './binaryResponse.js';

/**
 * The read-only Plex-facing lookups: search, the profile/rating facets, the "Start from…"
 * pickers, and the two binary proxies that keep the Plex token server-side.
 */
export function plexMetadataRoutes(): Hono {
  const app = new Hono();

  // --- search ------------------------------------------------------------------ //
  // With ?set= : scoped to that set's sections (the in-queue add box).
  // Without    : the Home header's add-to-ANY-queue search — spans every section any set
  //              draws from, deduped; each result carries its sectionId so the UI can
  //              offer only the queues whose libraries include it.
  // `?collections=1` also returns Plex Collections (type=18) in the same sections, tagged
  // {type:'collection', ratingKey, title, sectionId, childCount}. Movie/show results carry
  // type:'movie'|'show'. Default (no flag) is unchanged — items only.
  // `?scope=all` searches EVERY video library, ignoring the set's own sections — the member
  // picker uses it because a curated member is a manual INCLUDE, not bound to the channel's
  // pool libraries (e.g. adding an Anime show to a Shows-only channel).
  //
  // A trailing `(YYYY)` is split off before matching and used to RANK the hits, never to
  // filter them — see searchQuery.ts. `Title (Year)` is this app's own entry format, so the
  // box has to accept the string the tiles print.
  app.get('/search', async (c) => {
    const setId = c.req.query('set') ?? '';
    const raw = (c.req.query('q') ?? '').trim();
    const { text: q, year } = parseSearchQuery(raw);
    const withCollections = c.req.query('collections') === '1' || c.req.query('collections') === 'true';
    const allLibraries = c.req.query('scope') === 'all';
    if (!q) return c.json({ results: [] });
    try {
      // A PULL set searches ITS provider, not Plex. Routed here rather than at the four call
      // sites so every existing caller (queue add, channel members, channel filters) gets
      // provider-correct results without knowing providers exist — searching Plex for a Kavita
      // queue is what made "dungeon port" return nothing while the series sat in Webtoons.
      if (setId) {
        const s = await sets.getSet(setId);
        if (!s) return c.json({ error: 'unknown set' }, 400);
        if (s.delivery === 'pull') {
          // Spread, not `s`: see the note in providers/launcher.ts — `BlockSourceCfg`'s index
          // signature is satisfied by an anonymous object type but never by an interface.
          const block = providerBlocks.resolveSingle({ ...s });
          const p = providerFor(block.provider);
          if (typeof p.search !== 'function') return c.json({ results: [] });
          // Scoped to the queue's own libraries unless the caller explicitly asked to see
          // everything (the members picker's `scope=all`).
          const libraries = allLibraries ? [] : block.libraries;
          const found = await p.search(q, { libraries });
          return c.json({
            results: found.map((r) => ({
              // `ratingKey` is the shape every caller already stores and renders; here it
              // carries the provider's own item id, which is unambiguous because a queue draws
              // from exactly one provider.
              ratingKey: r.id,
              title: r.title,
              type: 'show',
              librarySectionTitle: r.libraryTitle,
              librarySectionID: r.libraryId,
              // The dropdown's artwork. It must be sent, not derived: the frontend's only other
              // move is /api/thumb/<id>, which is PLEX's proxy and answers 502 for a Kavita
              // seriesId — the broken-image row the owner hit on 2026-08-15.
              cover: coverUrl(block.provider, r.id),
            })),
          });
        }
      }

      let sections;
      let collectionSections;
      if (allLibraries) {
        // Every video library (movie + show), regardless of any set's configured sections —
        // so a manual include can come from a library no channel's rule pool draws from.
        let libs: Awaited<ReturnType<typeof plex.sections>> = [];
        try { libs = await plex.sections(); } catch { /* Plex down: empty search */ }
        sections = libs.filter((l) => l.video).map((l) => l.id);
        collectionSections = sections;
      } else if (setId) {
        const s = await sets.getSet(setId);
        if (!s) return c.json({ error: 'unknown set' }, 400);
        // Every section the set draws from: a rotation channel's members can be shorts/movies
        // out of its item_sections, not just shows (queue sets have item_sections: [] — no change).
        sections = [...new Set([...s.sections, ...s.item_sections])];
        // Collections can live in either the show sections OR the item (shorts/movie) sections.
        collectionSections = sections;
      } else {
        const reg = await sets.getRegistry();
        sections = [...new Set(reg.sets.flatMap((s) => [...s.sections, ...s.item_sections]))];
        collectionSections = sections;
      }
      // Deliberately the UNION of both hit shapes: `plex.search()` returns `PosterFields` and
      // `plex.collections()` returns `CollectionHit`, and this route has always emitted them in
      // one `results` array (the frontend branches on `type`). Declaring the union here is what
      // makes the `unshift` below honest instead of a cast.
      const results: (
        Awaited<ReturnType<typeof plex.search>>[number]
        | Awaited<ReturnType<typeof plex.collections>>[number]
      )[] = rankByYear(await plex.search(sections, q), year);
      if (withCollections) {
        try {
          // Collections lead the list: typing a franchise name ("Mobile Suit Gundam") turns up
          // dozens of individual show/movie hits, and the frontend caps the dropdown — so a
          // collection appended AFTER the items was pushed past the cap and never shown. The
          // collection is usually the higher-level thing the user wants, so it goes first.
          results.unshift(...(await plex.collections(collectionSections, q)));
        } catch {
          /* collections are additive — a Plex hiccup there never fails item search */
        }
      }
      return c.json({ results });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Plex Home users (the channel form's profile dropdown) -------------------- //
  // Lists the account's Plex Home users so the dynamic-channel form offers a dropdown that
  // fills plex_user/account_id/user_uuid, instead of three hand-typed fields (workstream #1,
  // Bob: "Gimme a dropdown"). Best-effort: an empty list means the form falls back to the
  // manual advanced inputs (so a plex.tv hiccup never blocks channel authoring).
  app.get('/profiles', async (c) => {
    try {
      return c.json({ profiles: await plex.homeUsers() });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- content ratings (per-account facet) ------------------------------------- //
  // The contentRating values actually present in a set's libraries, scoped to that set's
  // ACCOUNT (a managed user sees only its allowed libraries; admin sees all). Feeds the
  // rating checkboxes so each channel offers only the ratings its account can pick. Falls
  // back to a small static list when Plex/plex.tv is unreachable.
  app.get('/ratings', async (c) => {
    const setId = c.req.query('set') ?? '';
    // Pre-save scoping for the channel form (no set exists yet): the form passes the picked
    // profile's uuid + the currently-checked libraries so the ratings reflect that profile's
    // restricted view of those sections, matching the decision that the picker is scoped to a
    // profile's Plex-available ratings (2026-07-21-channels-function-first-generalized-members).
    const uuidQ = (c.req.query('uuid') ?? '').trim();
    const sectionsQ = (c.req.query('sections') ?? '').trim();
    try {
      let sections: number[] = [];
      let token = null;
      if (setId) {
        const s = await sets.getSet(setId);
        if (!s) return c.json({ error: 'unknown set' }, 400);
        sections = [...new Set([...(s.sections || []), ...(s.item_sections || [])])];
        if (s.user_uuid) {
          try {
            token = await plex.accountToken(s.user_uuid);
          } catch {
            token = null; // managed-token mint failed → admin token / static fallback
          }
        }
      } else if (sectionsQ) {
        sections = [...new Set(sectionsQ.split(',').map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n)))];
        if (uuidQ) {
          try {
            token = await plex.accountToken(uuidQ);
          } catch {
            token = null;
          }
        }
      }
      let ratings: string[] = [];
      try {
        ratings = await plex.contentRatings(sections, token);
      } catch {
        ratings = [];
      }
      if (!ratings.length) ratings = STATIC_RATINGS;
      return c.json({ ratings });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- the "Start from…" editor's pickers -------------------------------------- //
  // A series' playable episodes grouped by season, and a collection's members in play order.
  // Both are read-only lookups the start modal fills its dropdowns from, so a start point is
  // PICKED (season + real episode title) instead of typed blind into a tiny number box.
  app.get('/show/:ratingKey/episodes', async (c) => {
    try {
      // `uuid` (a Plex Home profile's user_uuid) scopes the `watched` marks to that profile, so
      // a per-profile channel's start editor reflects that profile's history, not the admin's.
      // Absent (queues/members/admin) => admin token, unchanged. A mint failure degrades to admin.
      const uuidQ = (c.req.query('uuid') ?? '').trim();
      let scope = {};
      if (uuidQ) {
        try { scope = { token: await plex.accountToken(uuidQ), account: uuidQ }; } catch { scope = {}; }
      }
      const out = await plex.showEpisodes(c.req.param('ratingKey'), scope);
      if (!out) return c.json({ error: 'no episodes' }, 404);
      return c.json(out);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.get('/collection/:ratingKey/children', async (c) => {
    try {
      const children = await plex.collectionChildren(c.req.param('ratingKey'));
      if (!children) return c.json({ error: 'no collection' }, 404);
      return c.json({ children });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Minimal metadata for one ratingKey — the blocklist chips need display titles.
  app.get('/item/:ratingKey', async (c) => {
    try {
      const md = await plex.resolveValue([], { ratingKey: c.req.param('ratingKey') });
      if (!md) return c.json({ error: 'not found' }, 404);
      return c.json(md);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Poster proxy — the Plex token stays server-side, never handed to the browser.
  app.get('/thumb/:ratingKey', async (c) => {
    try {
      const t = await plex.thumb(c.req.param('ratingKey'));
      if (!t) return c.body(null, 404);
      return binaryResponse({
        buffer: t.buffer,
        cacheControl: 'public, max-age=86400',
        contentType: t.contentType,
      });
    } catch {
      return c.body(null, 502);
    }
  });

  return app;
}

const STATIC_RATINGS = [
  'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'G', 'TV-PG', 'PG', 'PG-13', 'TV-14', 'R', 'TV-MA', 'NC-17',
];
