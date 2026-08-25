import { Hono } from 'hono';

import { errMessage } from '../errors.js';
import { providerFor } from '../providers/index.js';
import { pullLineup } from '../providers/pullLineup.js';
import * as queues from '../queues.js';
import { groupMembership } from '../store/db/people.js';
import { membersByQueue } from '../store/db/queuePeople.js';
import * as sets from '../sets.js';
import * as engineRouting from '../engine/routing.js';
import { displayFor } from '../tiles.js';
import type { CandidateSet, TonightCandidate, TonightPick } from '../tonight/pick.js';
import {
  candidatesFor,
  drawQueues,
  firstUnfinishedEntry,
  playItemLabel,
} from '../tonight/pick.js';
import { isTonightTile, routeForTile, WHY_QUEUE_FIRST } from '../tonight/routing.js';
import { readBody } from './readBody.js';

/**
 * TONIGHT — the activity → provider routing, and the pick behind it (WP-7).
 *
 * ## What this door is for
 *
 * `POST /tonight/pick` answers the four tiles whose engine is `queue-first`: Movies, Shows,
 * Reading and Video Games. It draws ONE QUEUE for the activity and the people at the table,
 * and it says what that queue would come up with next when the answer can be had without
 * starting anything.
 *
 * ## The two tiles it refuses, and why refusing is the feature
 *
 *   * **Board Games** is a different engine and a different door. It draws from a SHELF, not
 *     from a queue, and `POST /api/board-games/pick` owns it. Routing it through here would
 *     mean two callers of one engine and no gain.
 *   * **Surprise Me** narrows before it picks, and the narrowings are **not settled**. The
 *     owner said "media" spans YouTube and Plex Movies/Shows, which is coarser than the tile
 *     row, and that is all that is known. So this refuses it by name. Filling in a plausible
 *     taxonomy is the one failure the decision spends a clause forbidding — it would read as
 *     settled and get built on.
 *
 * Both refusals are 400s that say what to do instead. A route that answered them with
 * something would be worse than one that will not.
 *
 * ## One session talks to one backend
 *
 * The draw binds a backend and then draws inside it, and `boundBackend` on the body is how a
 * reroll stays on the same one. A queue that draws from two providers never becomes a
 * candidate: `launchDescriptor` refuses a mixed queue with a 501, so a card drawn off one
 * would have a Go that cannot work.
 *
 * ## Nothing here writes
 *
 * A pick is a READ. The play log, the known-how claims and the queue's own progress are all
 * written by other doors, and this one is exempt from the `/api` mutation snapshot for the
 * same reason `GET` is.
 */
export function tonightRoutes(): Hono {
  const app = new Hono();

  app.post('/tonight/pick', async (c) => {
    try {
      const body = await readBody(c);
      const tile = body.activity;

      if (!isTonightTile(tile)) {
        return c.json({ error: `unknown activity '${String(tile)}'` }, 400);
      }

      const route = routeForTile(tile);

      if (route.engine === 'board-games') {
        return c.json(
          { error: 'board games are drawn from the shelf — POST /api/board-games/pick' },
          400,
        );
      }

      if (route.engine === 'narrow-first') {
        return c.json(
          {
            error:
              'Surprise Me narrows down first and chooses second, and what it narrows BY is '
              + 'not settled yet. There is nothing to pick from until the groupings arrive.',
          },
          400,
        );
      }

      const personIds = Array.isArray(body.personIds) ? body.personIds.map(String) : [];
      const excludedSetIds = Array.isArray(body.excludedSetIds)
        ? body.excludedSetIds.map(String)
        : [];
      const boundBackend = typeof body.boundBackend === 'string' && body.boundBackend
        ? body.boundBackend
        : null;

      const registry = await sets.getRegistry();
      const candidates = candidatesFor({
        boundBackend,
        excludedSetIds,
        membershipFor: (groupId) => groupMembership(groupId),
        membersByQueue: membersByQueue(),
        personIds,
        providerIdFor: (setId) => providerIdOf(registry.sets, setId),
        sets: registry.sets as unknown as CandidateSet[],
        tile,
      });

      const { backend, ordered } = drawQueues(candidates, Math.random);

      if (!backend || ordered.length === 0) {
        return c.json({
          backend: null,
          notes: notesFor(tile),
          pick: null,
          // Said in the words the screen can print, because the two reasons a draw comes back
          // empty are completely different problems: there is no queue for that evening at
          // all, or there is one and everybody has already turned it down.
          reason: excludedSetIds.length
            ? 'Nothing else for that tonight — every queue that matches has been turned down.'
            : 'No queue matches that activity and the people you ticked.',
          shortlist: [],
        });
      }

      // Only the three that are going to be SHOWN are resolved. One provider round trip per
      // queue in the house is what resolving every candidate would cost.
      const shortlist: TonightPick[] = [];
      for (const candidate of ordered.slice(0, 3)) {
        shortlist.push(await withUpNext(candidate));
      }

      return c.json({
        backend,
        notes: notesFor(tile),
        pick: shortlist[0] ?? null,
        shortlist,
      });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 500);
    }
  });

  return app;
}

/**
 * The BACKEND behind a set — its provider id, or `null` when there is not exactly one.
 *
 * Read off the registry's own `providers:` blocks, which are always present (a set that
 * predates them reports the one implicit Plex block it has always meant). Two distinct
 * providers is a mixed queue and answers `null`, which drops it from the candidates.
 */
function providerIdOf(
  registrySets: readonly { id: string; providers?: readonly { provider: string }[] }[],
  setId: string,
): string | null {
  const set = registrySets.find((one) => one.id === setId);
  const ids = [...new Set((set?.providers ?? []).map((block) => block.provider).filter(Boolean))];
  return ids.length === 1 ? (ids[0] ?? null) : null;
}

/** The filters this tile collects that no backend can act on yet, said out loud. Empty for a
 *  tile whose form asks nothing the engine cannot answer. */
const notesFor = (tile: Parameters<typeof routeForTile>[0]): string[] => {
  const note = WHY_QUEUE_FIRST[tile];
  return note ? [note] : [];
};

/**
 * What this queue would come up with next.
 *
 * Three answers, and every one of them is either a fact or a named reason:
 *
 *   1. **A PULL queue** — the real head of `pullLineup()`, the same lineup `GET /go/<id>` is
 *      about to build. One provider round trip, and it is the round trip the launch was
 *      going to make anyway.
 *   2. **A CURATED push queue** — the first entry not marked done, read out of this app's own
 *      store with no Plex call at all. That is the ENTRY and not the leaf episode, and the
 *      card says "first in the queue" rather than claiming an episode number it has not
 *      looked up.
 *   3. **A RULES pool** — nothing, by name. Its lineup does not exist until it is drawn.
 *
 * A failure is the fourth answer and it is also named: a provider that is NOT CONFIGURED
 * reports itself here rather than producing a card whose Go dies later.
 */
async function withUpNext(candidate: TonightCandidate): Promise<TonightPick> {
  const launchUrl = candidate.delivery === 'pull'
    ? `/go/${encodeURIComponent(candidate.setId)}`
    : null;

  if (candidate.delivery === 'pull') {
    try {
      const cfg = engineRouting.loadSets()?.sets?.[candidate.setId];
      if (!cfg) {
        return {
          ...candidate,
          launchUrl,
          upNext: null,
          upNextReason: 'This queue is not in the engine registry.',
        };
      }
      const provider = providerFor(candidate.providerId);
      const play = await pullLineup(candidate.setId, cfg, provider);
      const head = play[0];
      if (!head) {
        return {
          ...candidate,
          launchUrl,
          upNext: null,
          upNextReason: `Nothing left in this queue — ${provider.label} says it is finished.`,
        };
      }
      return { ...candidate, launchUrl, upNext: playItemLabel(head), upNextReason: null };
    } catch (e) {
      // Named, and named as a REACH rather than as a crash. A provider that is down or NOT
      // CONFIGURED still leaves a queue you can try to start; a bare `fetch failed` on a card
      // says nothing a person can act on.
      return {
        ...candidate,
        launchUrl,
        upNext: null,
        upNextReason: `Could not ask ${candidate.providerLabel || candidate.providerId} what is next: ${errMessage(e)}`,
      };
    }
  }

  if (candidate.source === 'rotation') {
    return {
      ...candidate,
      launchUrl,
      upNext: null,
      upNextReason: 'This queue draws from the library when it starts, so there is no lineup yet.',
    };
  }

  try {
    const entries = await queues.listSet(candidate.setId);
    const display = firstUnfinishedEntry(
      entries.map((entry) => ({ display: displayFor(entry.value), done: Boolean(entry.done) })),
    );
    if (!display) {
      return {
        ...candidate,
        launchUrl,
        upNext: null,
        upNextReason: 'Every entry in this queue is finished.',
      };
    }
    // "First in the queue", not an episode number: this is the ENTRY, and the queue's own
    // resolver decides which episode of it plays.
    return {
      ...candidate,
      launchUrl,
      upNext: { detail: 'First in the queue', title: display },
      upNextReason: null,
    };
  } catch (e) {
    return { ...candidate, launchUrl, upNext: null, upNextReason: errMessage(e) };
  }
}
