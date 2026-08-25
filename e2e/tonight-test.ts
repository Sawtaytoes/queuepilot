// THE WP-6 GATE — the Tonight surface, driven in a real browser over its own fixtures.
//
// Every assertion here is something the OWNER settled, and every one of them fails
// silently: a tile quietly reordered, a provider brand quietly added to a hint, a segment
// quietly defaulting the other way, a queue chooser that appears on Pick, a "Which queue?"
// that asks a question with one answer.
//
// ── Why these are here and not only in the unit tests ────────────────────────────────
//
// `web/src/lib/tonight.test.ts` pins the DATA — the list, its order, the two rules. It
// cannot say whether the tiles render, whether the segment's paint agrees with the
// component's state, or whether the queue chooser is on the page. The interesting failure
// mode is exactly that disagreement: `SegmentedControl` and `RadioGroup` seed their value
// on mount and a keyed remount does NOT fire `onChange`, so a control can paint one answer
// while the view believes another, with no error anywhere.
//
// Self-contained: its own server, its own temp copies of `fixtures/tonight.*`, an
// unroutable Plex. Needs no Plex token — every assertion is about the form.
//
// Run:  PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
//         server/node_modules/.bin/tsx e2e/tonight-test.ts   (repo root; non-zero on failure)
import { chromium } from './playwright.js';
import { startTonightServer, stopTonightServer } from './tonight-harness.js';

const PORT = 18843;
const ok = (name: string, isPass: boolean, extra = ''): void => {
  console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!isPass) process.exitCode = 1;
};

const server = await startTonightServer(PORT);
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1420, height: 1100 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  const open = async (path = '/tonight') => {
    await page.goto(`${server.base}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tonight-activity [role="radiogroup"]', { timeout: 30000 });
    await page.waitForTimeout(900);
  };

  const tile = (label: string) => `#tonight-activity [role="radio"]:has-text("${label}")`;

  /** A choice tile's NAME, without its hint.
   *
   * Charcuterie draws a tile as the radio's ring and then a label column, with the name at
   * the top of that column — so this is a structural query rather than the `.actname` the
   * app used to paint, which went with the CSS block the library replaced. What it asserts
   * is unchanged: six names, in order. */
  const TILE_NAME = ':scope > span:nth-child(2) > span:first-child';
  const mode = (label: string) => `#tonight-mode [role="radio"]:has-text("${label}")`;

  /** Which option a radiogroup PAINTS as chosen — the answer that has to agree with the
   * view's own state, and the one a keyed remount can silently disagree with. */
  const checkedIn = (scope: string) =>
    page.$eval(`${scope} [role="radio"][aria-checked="true"]`, (el) => el.textContent?.trim() ?? '')
      .catch(() => '');

  await open();

  // ── 1. `GET /api/people` is the roster, in POSITION order ───────────────────────── //
  {
    const body = (await (await fetch(`${server.base}/api/people`)).json()) as {
      people: { id: string; displayName: string; position: number }[];
    };
    ok(
      'GET /api/people answers the roster in position order',
      JSON.stringify(body.people.map((p) => p.id)) === JSON.stringify(['ada', 'grace', 'linus']),
      JSON.stringify(body.people.map((p) => p.id)),
    );
    // It PROJECTS: a birth year and a provider account paint no checklist and this repo is
    // public. A widening is a deliberate act, so it gets to fail here first.
    ok(
      '…and carries only id / displayName / position',
      body.people.every((p) => JSON.stringify(Object.keys(p).sort()) === '["displayName","id","position"]'),
      JSON.stringify(Object.keys(body.people[0] ?? {})),
    );
  }

  // ── 2. The tiles: SIX, in order, Surprise Me last, no brand anywhere ─────────────── //
  {
    const labels = await page.$$eval(
      '#tonight-activity [role="radio"]',
      (els, sel) => els.map((el) => el.querySelector(sel)?.textContent?.trim() ?? ''),
      TILE_NAME,
    );
    ok(
      'six activity tiles, in the settled order',
      JSON.stringify(labels) ===
        JSON.stringify(['Video Games', 'Board Games', 'Movies', 'Shows', 'Reading', 'Surprise Me']),
      JSON.stringify(labels),
    );
    ok('Surprise Me is last', labels.at(-1) === 'Surprise Me');
    ok('there is no Retro Games tile — MiSTer is Video Games', !labels.includes('Retro Games'));

    // The rule is "a tile names the evening, never the backend", and a brand in a hint
    // reads as helpful, which is why it needs a gate rather than a reviewer.
    const tileText = await page.$eval('#tonight-activity', (el) => el.textContent ?? '');
    const brands = ['Plex', 'Kavita', 'Steam', 'MiSTer', 'YouTube', 'Jellyfin', 'Emby'];
    const found = brands.filter((brand) => tileText.includes(brand));
    ok('no provider brand appears on any tile', found.length === 0, found.join(', '));
  }

  // ── 3. The segment is defaulted BY the activity, and its paint agrees ────────────── //
  {
    await page.click(tile('Board Games'));
    await page.waitForTimeout(300);
    ok('board games start on Pick', (await checkedIn('#tonight-mode')) === 'Pick');
    ok('…so the filters render', Boolean(await page.$('#tonight-filters')));
    ok('…and there is NO queue chooser on Pick', !(await page.$('#tonight-queue')));

    await page.click(tile('Reading'));
    await page.waitForTimeout(300);
    ok('reading starts on Queues', (await checkedIn('#tonight-mode')) === 'Queues');
    ok('…so the queue chooser renders', Boolean(await page.$('#tonight-queue')));
    // The second "Mode" row the decision spends a clause forbidding. Pick | Queues IS the
    // mode control, so on Queues there is no filter block at all.
    ok('…and there is NO filter row on Queues', !(await page.$('#tonight-filters')));
  }

  // ── 4. Which queue?: zero / one / two or more ────────────────────────────────────── //
  {
    // TWO reading queues in the fixture, so the host has to choose.
    const readingCards = await page.$$eval(
      '#tonight-queue [role="radiogroup"] [role="radio"]',
      (els, sel) => els.map((el) => el.querySelector(sel)?.textContent?.trim() ?? ''),
      TILE_NAME,
    );
    ok('two matches force a choice', readingCards.length === 2, JSON.stringify(readingCards));

    // ONE movies queue, so the question is not put — it is shown and implied.
    await page.click(tile('Movies'));
    await page.click(mode('Queues'));
    await page.waitForTimeout(400);
    ok('one match is implied rather than asked', Boolean(await page.$('#tonight-queue-only')));
    ok('…and is not a chooser', !(await page.$('#tonight-queue [role="radiogroup"]')));

    // The provider badge, which is the ONE place a brand belongs on this screen: two
    // backends serving one activity is exactly the condition the decision names.
    await page.click(tile('Video Games'));
    await page.click(mode('Queues'));
    await page.waitForTimeout(400);
    // `.qcardprov` and not `.qcardmeta`: the meta row carries the queue's PEOPLE as well
    // now, and reading the whole row back would compare "AdaLinusMiSTer" against "MiSTer".
    const badges = await page.$$eval('#tonight-queue .qcardprov', (els) =>
      els.map((el) => el.textContent?.trim() ?? '').filter(Boolean),
    );
    ok(
      'a queue card names its provider once two of them serve one activity',
      badges.includes('Steam') && badges.includes('MiSTer'),
      JSON.stringify(badges),
    );
  }

  // ── 4b. THE PEOPLE FILTER, on the list and not only in the draw ──────────────────── //
  //
  // The defect this block exists for: Pick was people-aware server-side and the Which queue?
  // list was not, so ticking two people narrowed the draw and left the list beside it
  // offering queues those people are not on.
  //
  // Every assertion here moves a queue between the three branches of step 5 — one match is
  // implied, two or more force a choice, zero is an empty state — so the branch is asserted
  // alongside the count rather than instead of it.
  {
    await open();

    const tick = async (id: string) => {
      await page.click(`input[value="${id}"]`);
      await page.waitForTimeout(250);
    };

    /** What the Which queue? step is showing: the branch, and the queues in it. */
    const which = async (label: string) => {
      await page.click(tile(label));
      await page.click(mode('Queues'));
      await page.waitForTimeout(400);

      return {
        cards: await page.$$eval(
          '#tonight-queue [role="radiogroup"] [role="radio"]',
          (els, sel) => els.map((el) => el.querySelector(sel)?.textContent?.trim() ?? ''),
          TILE_NAME,
        ),
        isEmpty: Boolean(await page.$('#tonight-queue [role="alert"], #tonight-queue h3')),
        isImplied: Boolean(await page.$('#tonight-queue-only')),
      };
    };

    // NOBODY TICKED IS NO FILTER AT ALL. A filter with nothing in it matches everything, and
    // the strict reading of the rule gets this backwards — an empty form would otherwise hide
    // every queue that names anybody, which is nearly all of them.
    {
      const reading = await which('Reading');
      ok(
        'nobody ticked offers every queue for the activity',
        reading.cards.length === 2,
        JSON.stringify(reading.cards),
      );
      const games = await which('Video Games');
      ok(
        '…for every activity, not just the one that happens to open',
        games.cards.length === 2,
        JSON.stringify(games.cards),
      );
    }

    // ONE PERSON: the list narrows, and drops to the branch that does not ask.
    await tick('ada');
    {
      const reading = await which('Reading');
      ok(
        'ticking one person narrows two matches down to one',
        reading.isImplied && reading.cards.length === 0,
        `implied=${reading.isImplied} cards=${JSON.stringify(reading.cards)}`,
      );
      ok(
        '…and the one it kept is the queue that person is on',
        (await page.$eval('#tonight-queue-only', (el) => el.textContent ?? '')).includes('Manga'),
        await page.$eval('#tonight-queue-only', (el) => (el.textContent ?? '').slice(0, 80)),
      );
    }

    // A QUEUE NOBODY IS FILED ON IS NEVER FILTERED OUT. `after_dinner` has no members, and a
    // queue no group claimed comes up empty by design — hiding it makes it unreachable.
    {
      const shows = await which('Shows');
      ok(
        'a queue nobody is filed on is still offered',
        shows.isImplied
          && (await page.$eval('#tonight-queue-only', (el) => el.textContent ?? '')).includes(
            'Anybody',
          ),
        await page.$eval('#tonight-queue-only', (el) => (el.textContent ?? '').slice(0, 80)),
      );
    }

    // TWO PEOPLE: the list narrows again, and this is the case the decision works through —
    // "Ada — Manga" goes because Grace is not on it, and "Grace — Comics" goes because Ada is
    // not on it. Nothing is left, and the empty state has to say something useful.
    await tick('grace');
    {
      const reading = await which('Reading');
      ok(
        'ticking two people hides a queue only one of them is on',
        reading.isEmpty && reading.cards.length === 0 && !reading.isImplied,
        `empty=${reading.isEmpty} cards=${JSON.stringify(reading.cards)}`,
      );
      // A filter that silently drops to zero is worse than an over-inclusive list.
      const words = await page.$eval('#tonight-queue', (el) => el.textContent ?? '');
      ok(
        '…and the empty state says what to do about it',
        words.includes('Untick') && words.includes('Pick'),
        words.slice(0, 200),
      );

      // …while the peopleless queue survives BOTH ticks, which is the whole of that rule.
      const shows = await which('Shows');
      ok(
        'a queue nobody is filed on survives a two-person selection',
        shows.isImplied,
        JSON.stringify(shows.cards),
      );
    }

    // A GROUP IS NOT FLATTENED TO ITS PEOPLE. `game_night` is "at least one of Ada and
    // Grace", so Ada alone brings it up — a copy that unioned the group into two required
    // people would need both, which is the rule inverted.
    {
      await open();
      await tick('ada');
      const board = await which('Board Games');
      ok(
        'a group counts by its own number — either of them is enough',
        board.isImplied,
        JSON.stringify(board.cards),
      );
    }

    await open();
  }

  // ── 5. Go does the real thing, per delivery ──────────────────────────────────────── //
  {
    await page.click(tile('Reading'));
    await page.waitForTimeout(400);
    const go = await page.$eval('#tonight-go', (el) => ({
      href: el.getAttribute('href'),
      tag: el.tagName,
      text: el.textContent?.trim() ?? '',
    }));
    // Reading is PULL — it hands back a URL — so Go is the stable `/go/<id>` launcher the
    // queue's own page already uses, and it is a real anchor so it can be middle-clicked.
    ok('Go on a pull queue is an anchor to /go/<id>', go.tag === 'A' && go.href?.startsWith('/go/') === true,
      `${go.tag} → ${go.href}`);

    // Movies is PUSH, so there is no URL to follow: Go opens the device menu instead.
    await page.click(tile('Movies'));
    await page.click(mode('Queues'));
    await page.waitForTimeout(400);
    const push = await page.$eval('#tonight-go', (el) => ({
      hasHandle: el.classList.contains('playbtn'),
      tag: el.tagName,
    }));
    ok('Go on a push queue is a button, not a link', push.tag === 'BUTTON');
    // ⚠️ `.playbtn` is a DOM HANDLE that paints nothing: `PlayMenu`'s outside-click handler
    // asks `t.closest('.playbtn')`, so a Go without it opens a menu that shuts on the same
    // click. Nothing else in the app can catch that.
    ok('…and wears .playbtn, or the device menu shuts on its own opening click', push.hasHandle);

    // ── PICK, since WP-7 ─────────────────────────────────────────────────────────── //
    // Every tile except Surprise Me now reaches a backend. The one remaining disabled Go is
    // Board Games with nobody at the table, and that is a HEAD COUNT and not a missing
    // engine: this screen's people are a filter, so an empty answer is "you have not said"
    // rather than "nought players".
    await page.click(tile('Board Games'));
    await page.waitForTimeout(400);
    ok(
      'Go on a board-game pick waits for a head count, and says so',
      await page.$eval('#tonight-go', (el) => el.hasAttribute('disabled')),
    );

    // The four queue-first tiles are LIVE. A disabled Go here is the WP-7 regression.
    for (const label of ['Video Games', 'Movies', 'Shows', 'Reading']) {
      await page.click(tile(label));
      await page.click(mode('Pick'));
      await page.waitForTimeout(400);
      ok(
        `Pick is connected for ${label}`,
        !(await page.$eval('#tonight-go', (el) => el.hasAttribute('disabled'))),
      );
    }

    // …and it goes somewhere real. Shows has a curated queue in the fixture, so its card can
    // name what would come up next without a single Plex call.
    await page.click(tile('Shows'));
    await page.click(mode('Pick'));
    await page.waitForTimeout(300);
    await page.click('#tonight-go');
    await page.waitForSelector('#result-queue', { timeout: 15000 });
    ok(
      'a shows pick lands on a result card naming the queue it drew',
      (await page.$eval('#result-queue', (el) => el.textContent ?? '')).includes('Shows'),
      await page.$eval('#result-queue', (el) => (el.textContent ?? '').slice(0, 120)),
    );
    // Either a title or a stated reason, never a blank line. WHICH of the two shows queues
    // it drew is a real draw, so the gate asserts the invariant rather than the outcome; the
    // outcome is pinned deterministically in `tonight-routing-test.ts`.
    ok(
      '…and always says what would come up next, or why it cannot',
      (await page.$eval('#result-upnext', (el) => (el.textContent ?? '').trim())).length > 0,
      await page.$eval('#result-upnext', (el) => el.textContent ?? ''),
    );
    // A queue card has NO Mark played. A queue records its own progress when it plays, and a
    // button here would be a second writer of the same fact.
    ok(
      '…and offers no Mark played, because a queue logs itself',
      (await page.$$('#result-log')).length === 0,
    );
    await open();
  }

  // ── 6. The guests stepper ────────────────────────────────────────────────────────── //
  {
    const value = () => page.$eval('#guests', (el) => (el as HTMLInputElement).value);
    ok('guests start at zero', (await value()) === '0');
    await page.click('#guests-up');
    await page.click('#guests-up');
    ok('the + step counts up', (await value()) === '2', await value());
    await page.click('#guests-down');
    ok('the − step counts down', (await value()) === '1', await value());
    // A guest is a SEAT, not a person: it joins the count and gets no roster row.
    await page.click('input[value="ada"]');
    await page.waitForTimeout(200);
    const label = await page.$eval('#tonight-go', (el) => el.textContent?.trim() ?? '');
    ok('a guest counts as a seat on Go', label === 'Go · 2 people', label);
    const rosterRows = await page.$$eval('#tonight-roster input', (els) => els.length);
    ok('…and adds no roster row', rosterRows === 3, String(rosterRows));
  }

  // ── 7. Surprise Me is a SECOND SCREEN ────────────────────────────────────────────── //
  {
    await page.click(tile('Surprise Me'));
    await page.waitForTimeout(400);
    ok('the Surprise Me tile routes to its narrowing step',
      new URL(page.url()).pathname === '/tonight/surprise', page.url());
    ok('…and renders that step', Boolean(await page.$('#tonight-surprise')));
    // It chooses NOTHING on the way there. A Go that had already picked would be the
    // one-tap random pick the owner rejected.
    ok('…with no Go on it', !(await page.$('#tonight-go')));

    // Any other tile leaves the step.
    await page.click(tile('Movies'));
    await page.waitForTimeout(400);
    ok('another tile leaves the step', new URL(page.url()).pathname === '/tonight');
  }
} finally {
  await browser.close();
  stopTonightServer(server);
}

console.log('done');
