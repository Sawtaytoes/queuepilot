import { Hono } from "hono"

import { errMessage } from "../errors.js"
import {
  createGroup,
  deleteGroup,
  reorderGroups,
  resolveGroups,
  unassignedSetIds,
  updateGroup,
} from "../groups.js"
import * as sets from "../sets.js"
import { bookOfRecord } from "../store/db/open.js"
import {
  bumpPeopleVersion,
  deleteGroupMembership,
} from "../store/db/people.js"
import {
  bumpQueuePeopleVersion,
  forgetMember,
} from "../store/db/queuePeople.js"
import { readBody } from "./readBody.js"

/**
 * `GET /api/groups` — every QueuePilot group with its resolved membership.
 *
 * NOT `/api/profiles`, which is Plex's Home profile list and predates this by months. The
 * collision is the reason the concept is called a group at all; see `groups.ts`.
 *
 * Resolved SERVER-side rather than shipping the rules to the browser, because membership
 * reads a set's provider accounts (`requires_profile`, a rotation binding's `plex_user`, a
 * block's `profile`) and those are engine facts. A second implementation in TypeScript on
 * the client is a second answer to "whose is this", and the first thing that would drift is
 * the explicit-beats-derived ordering.
 *
 * `unassigned` rides along so the UI can say "these are filed nowhere" without asking a
 * second time or re-deriving anything.
 */
export function groupRoutes(): Hono {
  const app = new Hono()

  app.get("/groups", async (context) => {
    try {
      const reg = await sets.getRegistry()
      return context.json({
        groups: resolveGroups(reg.sets),
        unassigned: unassignedSetIds(reg.sets),
      })
    } catch (error) {
      return context.json({ error: errMessage(error) }, 500)
    }
  })

  // Create. Body: {label, accounts?, sets?}. Returns the generated (immutable) id.
  app.post("/groups", async (context) => {
    try {
      return context.json(
        await createGroup(await readBody(context)),
      )
    } catch (error) {
      // 400, not 500: every throw in the writer is a rejected INPUT (no label, a reserved
      // id, a label with nothing to slugify), and answering 500 would tell the editor to
      // retry something that can never succeed.
      return context.json({ error: errMessage(error) }, 400)
    }
  })

  // Edit one group. `id` is never writable — it is the URL, and a bookmark is a promise.
  app.patch("/groups/:id", async (context) => {
    try {
      return context.json(
        await updateGroup(
          context.req.param("id"),
          await readBody(context),
        ),
      )
    } catch (error) {
      return context.json({ error: errMessage(error) }, 400)
    }
  })

  app.delete("/groups/:id", async (context) => {
    const id = context.req.param("id")
    try {
      const result = await deleteGroup(id)
      if (result.deleted) {
        // `group_people` and `queue_people` intentionally have no group foreign key. Clean
        // both references after the YAML/SQLite group row is gone, or a deleted group would
        // remain selectable in old queue audiences and in the next roster read.
        const db = bookOfRecord()
        db.withTransaction(() => {
          deleteGroupMembership(id, db)
          forgetMember("group", id, db)
          bumpPeopleVersion(db)
          bumpQueuePeopleVersion(db)
        })
      }
      return context.json(result)
    } catch (error) {
      return context.json({ error: errMessage(error) }, 400)
    }
  })

  // Chip order. Body: {ids} — the new full order; anything omitted keeps its relative
  // position at the end rather than being dropped (see reorderGroups).
  app.patch("/groups-order", async (context) => {
    const { ids } = await readBody(context)
    if (!Array.isArray(ids))
      return context.json({ error: "ids[] required" }, 400)
    try {
      return context.json(
        await reorderGroups(ids.map(String)),
      )
    } catch (error) {
      return context.json({ error: errMessage(error) }, 500)
    }
  })

  return app
}
