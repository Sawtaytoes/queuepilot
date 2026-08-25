// THE WP-7 GATE — the activity → backend map, and the pick that routes through it.
//
// ── Why this suite exists ────────────────────────────────────────────────────────────
//
// Two things here fail silently, and both of them are one wrong line in a table:
//
//   1. **The map is written TWICE** — once for the server (`server/src/tonight/routing.ts`)
//      and once for the browser (`web/src/lib/tonightRouting.ts`). Neither workspace can
//      import the other, so nothing but this file can notice the day they disagree. A drift
//      routes an evening at a backend the other half has never heard of, and the screen
//      looks fine.
//   1b. **So is the PEOPLE FILTER** — `server/src/queuePeople.ts queueMatchesSelection()` and
//      `web/src/lib/tonight.ts queueMatchesPeople()`. Pick draws through one and the Which
//      queue? list is built with the other, so a drift offers a queue Pick would never draw,
//      or hides one it would. §5b asks both the same questions over the same fixture.
//   2. **A session must talk to ONE backend.** Video Games genuinely has Steam queues and
//      MiSTer queues; a draw that hands back one of each produces a card whose reroll walks
//      between two machines. That is an assertion about a live draw, not about a table.
//
// Neither needs a browser, so this runs in the always-on half of CI beside
// `pick-contract-test.ts` rather than in the Plex-gated block.
//
// Self-contained: its own server, its own temp copies of `fixtures/tonight.*`, an
// unroutable Plex. The cast is Ada, Grace and Linus.
//
// Run:  server/node_modules/.bin/tsx e2e/tonight-routing-test.ts   (repo root)
import { TILE_ROUTES, TONIGHT_TILES } from '../server/src/tonight/routing.js';
import { startTonightServer, stopTonightServer } from './tonight-harness.js';

/**
 * The BROWSER's copy of the map, loaded at runtime rather than imported.
 *
 * `web/` compiles under bundler module resolution and writes extensionless relative imports;
 * this workspace is `nodenext` and refuses them. A static import would therefore fail
 * `yarn workspace queuepilot-e2e run typecheck` on the WEB file's own style, which is correct
 * for the web and is not this suite's to change. Building the specifier at runtime keeps
 * TypeScript out of it while `tsx` still loads the file — and it loads cleanly, because every
 * import in that module is `import type` and is erased.
 */
const webRouting = (await import(
  new URL('../web/src/lib/tonightRouting.ts', import.meta.url).href
)) as {
  ACTIVITY_ROUTES: Record<
    string,
    {
      queueActivity: string | null;
      engine: string;
      providerKinds: readonly string[];
      plannedProviderKinds: readonly string[];
    }
  >;
};
const { ACTIVITY_ROUTES } = webRouting;

/** The BROWSER's copy of the people filter, loaded the same way and for the same reason. */
const webTonight = (await import(
  new URL('../web/src/lib/tonight.ts', import.meta.url).href
)) as {
  queuesForTonight: (
    queues: readonly WebQueue[],
    activity: string | null,
    selectedPersonIds: readonly string[],
  ) => WebQueue[];
  tonightQueues: (
    sets: readonly unknown[],
    providerLabels: ReadonlyMap<string, string>,
    membersByQueue?: Readonly<Record<string, unknown[]>>,
    people?: readonly unknown[],
    groups?: readonly unknown[],
  ) => WebQueue[];
};

interface WebQueue {
  id: string;
  activity: string;
  hasRoster: boolean;
}

const PORT = 18847;

const ok = (name: string, isPass: boolean, extra = ''): void => {
  console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!isPass) process.exitCode = 1;
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface PickWire {
  setId: string;
  setLabel: string;
  tile: string;
  providerId: string;
  providerKind: string;
  delivery: string;
  upNext: { title: string; detail: string | null } | null;
  upNextReason: string | null;
  launchUrl: string | null;
}

interface PickAnswer {
  backend: string | null;
  pick: PickWire | null;
  shortlist: PickWire[];
  notes?: string[];
  reason?: string;
  error?: string;
}

// ── 1. The two copies of the map agree ─────────────────────────────────────────────── //

ok(
  'both maps carry the same six tiles',
  same(Object.keys(TILE_ROUTES).sort(), Object.keys(ACTIVITY_ROUTES).sort()),
  `${Object.keys(TILE_ROUTES).length} server / ${Object.keys(ACTIVITY_ROUTES).length} web`,
);

for (const tile of TONIGHT_TILES) {
  const server = TILE_ROUTES[tile];
  const web = ACTIVITY_ROUTES[tile] ?? null;
  ok(
    `${tile}: the server's row and the browser's row are the same row`,
    web !== null
      && same(
        [server.queueActivity, server.engine, server.providerKinds, server.plannedProviderKinds],
        [web.queueActivity, web.engine, web.providerKinds, web.plannedProviderKinds],
      ),
    JSON.stringify({ server, web }),
  );
}

const server = await startTonightServer(PORT);

const post = async (body: unknown): Promise<{ status: number; body: PickAnswer }> => {
  const res = await fetch(`${server.base}/api/tonight/pick`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  return { body: (await res.json()) as PickAnswer, status: res.status };
};

try {
  // ── 2. The four queue-first tiles produce a REAL pick ────────────────────────────── //
  for (const tile of ['movies', 'shows', 'reading', 'video-games'] as const) {
    const { body, status } = await post({ activity: tile, personIds: [] });
    ok(
      `${tile}: Pick draws a queue`,
      status === 200 && Boolean(body.pick) && body.pick?.tile === tile,
      `${status} ${JSON.stringify(body.pick ?? body.reason ?? body.error)}`,
    );
    ok(
      `${tile}: the queue it drew is one this build can start`,
      Boolean(body.pick?.providerId),
      String(body.pick?.providerId),
    );
    // A null `upNext` always carries a reason. A blank space where a title should be reads
    // as a bug, and that is the whole point of the field.
    ok(
      `${tile}: nothing is left unexplained — a missing up-next says why`,
      Boolean(body.pick?.upNext) !== Boolean(body.pick?.upNextReason),
      JSON.stringify({ upNext: body.pick?.upNext, why: body.pick?.upNextReason }),
    );
  }

  // ── 2b. A CURATED queue names its head, off our own store and with no Plex call ───── //
  // Forced rather than drawn: `shows` has a rotation channel and a curated queue in the
  // fixture, and which one comes up is a real draw. Excluding the rotation leaves one answer.
  {
    const { body } = await post({
      activity: 'shows',
      excludedSetIds: ['after_dinner'],
      personIds: [],
    });
    ok(
      'a curated queue names its first unfinished entry',
      body.pick?.setId === 'linus_shows'
        && body.pick.upNext?.title === 'A Series (2019)'
        && body.pick.upNext.detail === 'First in the queue',
      JSON.stringify(body.pick?.upNext),
    );
  }

  // ── 2c. A finished queue is SKIPPED, not offered ─────────────────────────────────── //
  // `game_night` is the board-game queue and holds no entries, so it is the one set in the
  // fixture that reports itself finished. Board games do not come through this door, so the
  // rule is asserted on the closest thing that does: a queue whose provider says there is
  // nothing left never becomes the answer, because its Start would 409.
  {
    const { body } = await post({
      activity: 'shows',
      excludedSetIds: ['after_dinner', 'linus_shows'],
      personIds: [],
    });
    ok(
      'with every shows queue turned down there is no pick, and it says which empty this is',
      body.pick === null && String(body.reason).includes('turned down'),
      `${JSON.stringify(body.pick)} ${body.reason}`,
    );
  }

  // ── 3. ONE SESSION TALKS TO ONE BACKEND ──────────────────────────────────────────── //
  // The fixture has a Steam queue AND a MiSTer queue under Video Games, which is exactly the
  // condition this rule exists for.
  {
    const backends = new Set<string>();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const { body } = await post({ activity: 'video-games', personIds: [] });
      backends.add(String(body.backend));
      ok(
        'video-games: every queue in one draw is on the drawn backend',
        body.shortlist.every((one) => one.providerId === body.backend),
        JSON.stringify(body.shortlist.map((one) => `${one.setId}:${one.providerId}`)),
      );
    }
    // …and over enough draws it does reach both, so the binding is a BINDING and not a
    // hard-coded preference for whichever provider sorts first.
    ok(
      'video-games: the backend is drawn, not fixed',
      backends.size === 2,
      [...backends].join(', '),
    );
  }

  // ── 4. The reroll's memory, and the bound backend ────────────────────────────────── //
  {
    const first = await post({ activity: 'video-games', personIds: [] });
    const backend = first.body.backend;
    const drawn = first.body.pick?.setId ?? '';
    const again = await post({
      activity: 'video-games',
      boundBackend: backend,
      excludedSetIds: [drawn],
      personIds: [],
    });
    ok(
      'a turned-down queue is never offered again',
      !again.body.shortlist.some((one) => one.setId === drawn),
      JSON.stringify(again.body.shortlist.map((one) => one.setId)),
    );
    ok(
      'a reroll stays on the backend the session bound to',
      again.body.pick === null || again.body.backend === backend,
      `${backend} -> ${again.body.backend}`,
    );
  }

  // ── 5. The people filter is the SERVER's, groups and all ─────────────────────────── //
  // `queueMatchesSelection` is what this draw goes through, and it is the only one of the two
  // copies that can answer "at least one of them" — a group stays ONE member carrying its own
  // count rather than being flattened into its people.
  //
  // The two PUTs restate what `TONIGHT_TRAYS` already filed, so this block reads on its own
  // and stops depending on a table in another file for the assertions right under it.
  {
    const put = async (setId: string, members: unknown[]) =>
      fetch(`${server.base}/api/sets/${setId}/people`, {
        body: JSON.stringify({ members }),
        headers: { 'content-type': 'application/json' },
        method: 'PUT',
      });

    await put('manga_webtoons', [{ id: 'ada', kind: 'person', role: 'required' }]);
    await put('grace_comics', [{ id: 'grace', kind: 'person', role: 'required' }]);

    const ada = await post({ activity: 'reading', personIds: ['ada'] });
    ok(
      'ticking Ada draws only the queue Ada is on',
      ada.body.shortlist.every((one) => one.setId === 'manga_webtoons'),
      JSON.stringify(ada.body.shortlist.map((one) => one.setId)),
    );

    // Ada and Grace together is on NEITHER queue — each names only one of them, so "every
    // selected person is on the queue" fails for both. The decision's own worked example.
    const both = await post({ activity: 'reading', personIds: ['ada', 'grace'] });
    ok(
      'ticking two people hides a queue only one of them is on',
      both.body.pick === null,
      JSON.stringify(both.body.shortlist.map((one) => one.setId)),
    );
    ok(
      '…and says which of the two empty answers it is',
      typeof both.body.reason === 'string' && both.body.reason.length > 0,
      String(both.body.reason),
    );

    // Nobody ticked is NO FILTER AT ALL — the correction at the end of the queue decision.
    const nobody = await post({ activity: 'reading', personIds: [] });
    ok(
      'nobody ticked draws from both reading queues',
      nobody.body.shortlist.length === 2,
      JSON.stringify(nobody.body.shortlist.map((one) => one.setId)),
    );
  }

  // ── 5b. THE TWO COPIES OF THE FILTER ANSWER THE SAME ─────────────────────────────── //
  //
  // Pick has been people-aware server-side since WP-7; the Which queue? list was not, and
  // that gap is what this block exists to stop coming back. Both are asked the same question
  // over the same fixture: the server through a real draw, the browser through
  // `queuesForTonight()` over `/api/sets` + `/api/queue-people` + `/api/people`.
  //
  // Two tiles, on purpose. `reading` is two Kavita queues and `shows` is two Plex queues, so
  // every candidate is on one backend and the draw's own one-backend binding cannot remove a
  // queue the browser kept — that would be a real disagreement about something else.
  {
    const registry = (await (await fetch(`${server.base}/api/sets`)).json()) as {
      sets: { id: string; provider_kind: string; vocabulary?: { name?: string } }[];
    };
    const trays = (await (await fetch(`${server.base}/api/queue-people`)).json()) as {
      queues: Record<string, unknown[]>;
    };
    const roster = (await (await fetch(`${server.base}/api/people`)).json()) as {
      people: unknown[];
      groups: unknown[];
    };

    const browserQueues = webTonight.tonightQueues(
      registry.sets,
      new Map(registry.sets.map((one) => [one.provider_kind, one.vocabulary?.name ?? ''])),
      trays.queues,
      roster.people,
      roster.groups,
    );

    // `after_dinner` has nobody on it. The list must offer it whoever is ticked — a queue no
    // group claimed comes up empty by design, and hiding it makes it unreachable.
    ok(
      'a queue nobody is filed on reports itself rosterless',
      browserQueues.find((one) => one.id === 'after_dinner')?.hasRoster === false,
      JSON.stringify(browserQueues.map((one) => `${one.id}:${one.hasRoster}`)),
    );

    for (const tile of ['reading', 'shows'] as const) {
      for (const personIds of [[], ['ada'], ['grace'], ['linus'], ['ada', 'grace']]) {
        const drawn = await post({ activity: tile, personIds });
        const server_ = [...drawn.body.shortlist.map((one) => one.setId)].sort();
        const browser = webTonight
          .queuesForTonight(browserQueues, tile, personIds)
          .map((one) => one.id)
          .sort();

        ok(
          `${tile} + [${personIds.join(', ')}]: both copies of the filter answer the same`,
          same(server_, browser),
          `server ${JSON.stringify(server_)} / browser ${JSON.stringify(browser)}`,
        );
      }
    }

    // …and the GROUP, which is the case a flattened copy gets wrong. `game_night` is "at
    // least one of Ada and Grace", so either of them alone is enough and both together still
    // is. Board games are refused at this door, so the browser's answer is the whole
    // assertion — the rule it reads is the one §5's draws just went through.
    const boardGames = (ids: string[]) =>
      webTonight.queuesForTonight(browserQueues, 'board-games', ids).map((one) => one.id);

    ok('a group is at least one of them — Ada alone', same(boardGames(['ada']), ['game_night']));
    ok('…Grace alone', same(boardGames(['grace']), ['game_night']));
    ok('…and both together', same(boardGames(['ada', 'grace']), ['game_night']));
    // Linus is the group's "may join", which is not on the queue. A flattened copy that
    // unioned the whole roster would answer this one wrong in the other direction.
    ok('…but the group\'s spare is not on the queue', same(boardGames(['linus']), []));
  }

  // ── 6. The two tiles this door REFUSES, by name ──────────────────────────────────── //
  {
    const board = await post({ activity: 'board-games', personIds: [] });
    ok(
      'board games are refused here — they are drawn from the shelf, at their own door',
      board.status === 400 && String(board.body.error).includes('/api/board-games/pick'),
      `${board.status} ${board.body.error}`,
    );

    // ⚠️ THE ONE THIS SUITE EXISTS TO PROTECT. Surprise Me narrows BEFORE it picks and the
    // narrowings are not settled. A route that answered it with something would look settled
    // and get built on.
    const surprise = await post({ activity: 'surprise', personIds: [] });
    ok(
      'Surprise Me is refused until the narrowings arrive — it is never faked',
      surprise.status === 400 && String(surprise.body.error).toLowerCase().includes('narrow'),
      `${surprise.status} ${surprise.body.error}`,
    );

    const nonsense = await post({ activity: 'retro-games', personIds: [] });
    ok(
      'there is no Retro Games tile, and asking for one is a 400',
      nonsense.status === 400,
      `${nonsense.status} ${nonsense.body.error}`,
    );
  }

  // ── 7. The filters that go nowhere yet SAY SO ────────────────────────────────────── //
  {
    const movies = await post({ activity: 'movies', personIds: [] });
    ok(
      'movies reports the filters no backend can act on yet',
      (movies.body.notes ?? []).some((note) => note.toLowerCase().includes('runtime')),
      JSON.stringify(movies.body.notes),
    );
    const games = await post({ activity: 'video-games', personIds: [] });
    ok(
      'video games says the known-how table does not exist',
      (games.body.notes ?? []).some((note) => note.toLowerCase().includes('known-how')),
      JSON.stringify(games.body.notes),
    );
    const reading = await post({ activity: 'reading', personIds: [] });
    ok(
      'reading has nothing to apologise for and says nothing',
      (reading.body.notes ?? []).length === 0,
      JSON.stringify(reading.body.notes),
    );
  }
} finally {
  stopTonightServer(server);
}
