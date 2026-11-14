import { Hono } from "hono"
import { liveClient } from "../engine/plex-live.js"
import * as pending from "../pending.js"
import * as plex from "../plex.js"
import type { PlexMetadata } from "../types.js"
import { plexWebUrl } from "../webLinks.js"
import { readBody } from "./readBody.js"

/**
 * PENDING — what arrived that nothing is going to play.
 *
 * The listing is one container read per video library, which is the same read the pool engine
 * already does per scan. It is NOT cached here: the whole point of the screen is that it is
 * current, and it is opened by hand rather than polled.
 */
export function pendingRoutes(): Hono {
  const app = new Hono()

  const listSection = async (
    sectionId: number,
    type: 1 | 2,
  ): Promise<PlexMetadata[]> => {
    const json = await plex.plexGet(
      `/library/sections/${sectionId}/all?type=${type}&X-Plex-Container-Size=10000`,
    )
    const mc = (
      json as {
        MediaContainer?: { Metadata?: PlexMetadata[] }
      }
    ).MediaContainer
    return mc?.Metadata || []
  }

  /**
   * The collections in one library, for the pending pass.
   *
   * `plex.collections()` takes a query and title-filters client-side; an empty query is every
   * collection in the section, which is what this wants. Collections per library are few, so
   * this is one cheap read on top of the listing that was already happening.
   *
   * `isFresh` for the same reason the search route uses it: this pass answers "what is in the
   * library that no queue plays", and a cached listing would keep reporting a collection
   * somebody has since queued — or miss one they have just made. It is not on the page-load
   * path (decision `2026-08-26-a-provider-read-is-cached-and-the-page-revalidates-after-it-paints`).
   */
  const listCollections = async (sectionId: number) =>
    (
      await plex.collections([sectionId], "", {
        isFresh: true,
      })
    ).map((row) => ({
      childCount: row.childCount,
      ratingKey: row.ratingKey,
      sectionId: row.sectionId,
      title: row.title,
    }))

  app.get("/pending", async (context) => {
    try {
      const libs = (await plex.sections()).map(
        (section) => ({
          id: Number(section.id),
          title: String(section.title ?? ""),
          type: String(section.type ?? ""),
          video: Boolean(section.video),
          other: Boolean(section.other),
        }),
      )
      const { items, state } = await pending.pendingItems(
        liveClient(),
        libs,
        listSection,
        listCollections,
      )
      // Match queue tiles: the title is a direct link to the item in the configured Plex
      // web client. Resolve these in sequence so one request warms machineIdentifier's cache
      // before the rest reuse it.
      const linkedItems = []
      for (const item of items) {
        linkedItems.push({
          ...item,
          webUrl: await plexWebUrl(
            item.ratingKey,
            item.type,
          ),
        })
      }
      // The filter panel is drawn from THIS response rather than from `/api/sets`, and the
      // two differ in the way that matters: `libraries` here is every video library the
      // screen COULD draw from, and `selected` is the ids it did. Sending the resolved
      // selection — not the raw `state.libraries` — is what lets the panel show the default
      // as checked boxes instead of as an empty set the owner would read as "nothing".
      const choosable = libs.filter(
        (library) => library.video,
      )
      return context.json({
        items: linkedItems,
        seen_through: state.seen_through,
        dismissed: state.dismissed.length,
        libraries: choosable,
        selected: pending
          .selectedLibraries(libs, state)
          .map((selectedLibrary) => selectedLibrary.id),
        // Whether the selection is a real choice or the fallback, so the panel can offer
        // "back to default" only when there is something to go back from.
        isDefault: state.libraries === null,
      })
    } catch (error) {
      return context.json({ error: String(error) }, 500)
    }
  })

  /**
   * Choose the libraries. `{ libraries: null }` clears the choice and restores the default;
   * `{ libraries: [] }` is the deliberate blank page. They are different states and the
   * route keeps them apart.
   */
  app.post("/pending/libraries", async (context) => {
    const body = await readBody(context)
    const value = (body as { libraries?: unknown })
      .libraries
    if (value !== null && !Array.isArray(value)) {
      return context.json(
        {
          error:
            "libraries must be an array of section ids, or null",
        },
        400,
      )
    }
    try {
      const state = await pending.setLibraries(
        value === null
          ? null
          : (value as unknown[]).map(Number),
      )
      return context.json({
        ok: true,
        libraries: state.libraries,
      })
    } catch (error) {
      return context.json({ error: String(error) }, 500)
    }
  })

  // Say no to ONE item. Per-item rather than moving the watermark, or skipping one film would
  // also hide everything added after it.
  app.post("/pending/dismiss", async (context) => {
    const { ratingKey } = await readBody(context)
    if (!ratingKey)
      return context.json(
        { error: "ratingKey required" },
        400,
      )
    try {
      const state = await pending.dismiss(String(ratingKey))
      return context.json({
        ok: true,
        dismissed: state.dismissed.length,
      })
    } catch (error) {
      return context.json({ error: String(error) }, 500)
    }
  })

  // Clear the whole list in one gesture by moving the watermark.
  app.post("/pending/seen", async (context) => {
    try {
      const state = await pending.markSeen()
      return context.json({
        ok: true,
        seen_through: state.seen_through,
      })
    } catch (error) {
      return context.json({ error: String(error) }, 500)
    }
  })

  return app
}
