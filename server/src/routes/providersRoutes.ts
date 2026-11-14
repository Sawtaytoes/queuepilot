import { Hono } from "hono"
import { errMessage } from "../errors.js"
import * as providers from "../providers/config.js"
import { providerFor } from "../providers/index.js"
import { parseSearchQuery } from "../searchQuery.js"
import { binaryResponse } from "./binaryResponse.js"
import { readBody } from "./readBody.js"

/**
 * --- App Connectors ----------------------------------------------------------- //
 * The provider surface. Definitions are plaintext and freely readable; TOKENS ARE
 * WRITE-ONLY — there is no route that returns one, and `configured` is a boolean rather
 * than a masked prefix, because a masked token is still a leak when the secret is short.
 */
export function providersRoutes(): Hono {
  const app = new Hono()

  app.get("/providers", (context) =>
    context.json({ providers: providers.publicList() }),
  )

  // Set or replace one provider's token. Write-only by design.
  //
  // Excluded from the undo snapshot (see routes/undoSnapshot.ts) — a credential copied into
  // the undo stack has escaped its file.
  app.post("/providers/:id/token", async (context) => {
    const { token } = await readBody(context)
    if (typeof token !== "string" || !token.trim()) {
      return context.json(
        { error: "a non-empty token is required" },
        400,
      )
    }
    try {
      const def = providers.definitionFor(
        context.req.param("id"),
      )
      if (!def)
        return context.json(
          { error: "unknown provider" },
          404,
        )
      await providers.writeSecret(def.id, token.trim())
      // Echo the PUBLIC view only. Never the token, not even the one just supplied.
      return context.json({
        ok: true,
        provider: providers.publicView(def),
      })
    } catch (error) {
      return context.json({ error: errMessage(error) }, 500)
    }
  })

  app.delete("/providers/:id/token", async (context) => {
    try {
      const def = providers.definitionFor(
        context.req.param("id"),
      )
      if (!def)
        return context.json(
          { error: "unknown provider" },
          404,
        )
      await providers.deleteSecret(def.id)
      return context.json({
        ok: true,
        provider: providers.publicView(def),
      })
    } catch (error) {
      return context.json({ error: errMessage(error) }, 500)
    }
  })

  // The libraries a provider offers, for the queue editor's provider block. Plex keeps its own
  // long-standing routes; this is the provider-scoped one a non-Plex block needs.
  app.get("/providers/:id/libraries", async (context) => {
    try {
      const provider = providerFor(context.req.param("id"))
      if (typeof provider.libraries !== "function") {
        return context.json({
          libraries: [],
          note: `${provider.label} does not enumerate libraries here`,
        })
      }
      return context.json({
        libraries: await provider.libraries(),
      })
    } catch (error) {
      return context.json({ error: errMessage(error) }, 503)
    }
  })

  // Provider-scoped series search — the non-Plex half of /api/search. Scoped to the libraries
  // the queue draws from, so it never offers something that queue could not play.
  //
  // A trailing `(YYYY)` is split off here too (searchQuery.ts). Kavita's series search carries
  // no year to rank on, but a query that still contains `(1992)` matches nothing at all — so
  // the strip is what makes the box behave the same on both providers.
  app.get("/providers/:id/search", async (context) => {
    const { text: query } = parseSearchQuery(
      context.req.query("q") ?? "",
    )
    if (!query) return context.json({ results: [] })
    try {
      const provider = providerFor(context.req.param("id"))
      if (typeof provider.search !== "function")
        return context.json({ results: [] })
      const libraries = (
        context.req.query("libraries") ?? ""
      )
        .split(",")
        .map((library) => library.trim())
        .filter(Boolean)
      return context.json({
        results: await provider.search(query, {
          libraries,
        }),
      })
    } catch (error) {
      return context.json({ error: errMessage(error) }, 503)
    }
  })

  // Cover proxy. The Kavita image endpoint REQUIRES the API key as a query parameter, so the
  // browser must never be handed one of its URLs — that would put a live credential in the
  // page source, the network tab and any screenshot (the hazard docs/kavita-feasibility.md
  // flags about /api/opds/<apiKey>). The key stays here; the browser gets bytes. Same shape as
  // /api/thumb for Plex.
  app.get(
    "/providers/:id/cover/:itemId",
    async (context) => {
      try {
        const provider = providerFor(
          context.req.param("id"),
        )
        if (typeof provider.cover !== "function")
          return context.body(null, 404)
        const { buffer, contentType } =
          await provider.cover(context.req.param("itemId"))
        return binaryResponse({
          buffer,
          // Covers change only when the series art does; a day is the same bet /api/thumb makes.
          cacheControl: "public, max-age=86400",
          contentType,
        })
      } catch {
        // A missing cover is normal (a series with no art). 404 rather than 500 so the tile
        // falls back to its placeholder instead of logging an error per render.
        return context.body(null, 404)
      }
    },
  )

  /**
   * Open this item in the provider's own UI — a 302, never the URL itself.
   *
   * A pull tile's title links HERE. Kavita's base URL is credential-adjacent (its image
   * endpoint takes the API key as a query parameter) and must not appear in a JSON body,
   * which `e2e/kavita-covers-test.ts` gates on; the browser gets a same-origin path and
   * learns the address only at the moment it navigates, exactly as `/go/<set>` already does.
   *
   * 404 — and no navigation — for a provider with no web UI and for an item it cannot
   * address. A dead link is worse than no link.
   */
  app.get(
    "/providers/:id/open/:itemId",
    async (context) => {
      try {
        const provider = providerFor(
          context.req.param("id"),
        )
        if (typeof provider.webUrl !== "function")
          return context.body(null, 404)
        const url = await provider.webUrl(
          context.req.param("itemId"),
        )
        if (!url) return context.body(null, 404)

        return context.redirect(url, 302)
      } catch {
        return context.body(null, 404)
      }
    },
  )

  /**
   * Record one unit consumed on the provider's side — "we played this" without opening the
   * picker. POST, because it WRITES.
   *
   * 404 for a provider that has no such method, which is every media server: Plex and
   * Kavita learn what was watched or read from the device that did it. A table has no
   * telemetry, so a board game's progress is a button someone presses.
   *
   * Marking the QUEUE entry done is deliberately not done here. Whether an entry is
   * finished is `buckets()`'s answer (plays owed vs plays since it was queued), and the
   * next launch or tile refresh asks it — one source of truth rather than two writers
   * racing over queues.yaml.
   */
  app.post(
    "/providers/:id/progress/:itemId",
    async (context) => {
      try {
        const provider = providerFor(
          context.req.param("id"),
        )
        if (typeof provider.logProgress !== "function")
          return context.json(
            { error: "not supported" },
            404,
          )
        return context.json(
          await provider.logProgress(
            context.req.param("itemId"),
          ),
        )
      } catch (error) {
        return context.json(
          { error: errMessage(error) },
          503,
        )
      }
    },
  )

  return app
}
