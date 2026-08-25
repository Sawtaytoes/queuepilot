// THE WP-8 GATE — a logged play records WHO played, and a play never invents a claim.
//
// This suite exists because of a defect in the live data, not because of a design review.
// The absorbed app had three plays and ZERO participant rows: it logged a game id and a
// timestamp and asked nobody anything, so the play log could not answer the one question it
// exists to answer. Every assertion in section 2 fails against that behaviour.
//
// ── Why a browser and not only the unit tests ────────────────────────────────────────
//
// `store/db/boardgamePlays.test.ts` pins the WRITE — participants land, a claim is renewed
// and never invented, a backdated play cannot freshen one. It cannot say whether any screen
// ever calls it with a real list of people, and "the writer was fine, every caller passed
// `[]`" is precisely how the defect happened. So the gate drives the actual control and then
// reads the actual table.
//
// Self-contained: its own server, its own synthetic collection, its own confirmed people
// mapping, an unroutable Plex. Fixture data only — Ada, Grace, Linus, and four invented
// titles.
//
// Run:  PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
//         server/node_modules/.bin/tsx e2e/board-game-play-test.ts   (repo root)
import { DatabaseSync } from 'node:sqlite';

import {
  startBoardGameServer,
  stopBoardGameServer,
} from './board-game-play-harness.js';
import { chromium } from './playwright.js';

const PORT = 18847;
const ok = (name: string, isPass: boolean, extra = ''): void => {
  console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!isPass) process.exitCode = 1;
};

const server = await startBoardGameServer(PORT);
const browser = await chromium.launch();

/** Read the book of record directly. The screen's own claim is not the evidence here. */
const rows = <T>(sql: string): T[] => {
  const db = new DatabaseSync(server.storePath, { readOnly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
};

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  const openCollection = async () => {
    await page.goto(`${server.base}/collection`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#collection:not([hidden]) #collection-grid', {
      timeout: 30000,
    });
    await page.waitForTimeout(400);
  };

  // ── 1. The migration arrived, and it did NOT back-fill ──────────────────────────── //
  {
    const plays = rows<{ c: number }>('SELECT COUNT(*) AS c FROM board_game_plays');
    const people = rows<{ c: number }>('SELECT COUNT(*) AS c FROM board_game_play_people');
    ok('the historical play came across', plays[0]?.c === 1, `plays=${plays[0]?.c}`);
    ok(
      'and nobody was invented for it',
      people[0]?.c === 0,
      `participants=${people[0]?.c}`,
    );
  }

  // ── 2. THE DEFECT: marking a game played from the Collection screen ─────────────── //
  await openCollection();

  {
    const cards = await page.$$eval('#collection-grid > li', (list) => list.length);
    ok('the shelf is a grid of cards', cards === 4, `cards=${cards}`);

    const columns = await page.$eval('#collection-grid', (el) =>
      getComputedStyle(el).gridTemplateColumns.split(' ').length,
    );
    ok(
      'and it is a GRID at this width, not a column of full-width rows',
      columns > 1,
      `columns=${columns}`,
    );
  }

  {
    await page.click('#bg-harbour-lantern-played');
    await page.waitForSelector('#bg-harbour-lantern-people', { timeout: 10000 });

    const names = await page.$$eval(
      '#bg-harbour-lantern-people input',
      (list) => list.map((el) => (el as HTMLInputElement).value),
    );
    ok(
      'it asks WHO played, and offers the whole roster',
      names.join(',') === 'ada,grace,linus',
      names.join(','),
    );

    const idleLabel = await page.$eval('#bg-harbour-lantern-log', (el) =>
      el.textContent?.trim() ?? '',
    );
    ok(
      'and the button says out loud that nobody is named yet',
      idleLabel.includes('nobody named'),
      idleLabel,
    );

    await page.click('#bg-harbour-lantern-people input[value="ada"]');
    await page.click('#bg-harbour-lantern-people input[value="grace"]');

    const twoLabel = await page.$eval('#bg-harbour-lantern-log', (el) =>
      el.textContent?.trim() ?? '',
    );
    ok('the button counts the table', twoLabel.includes('2 people'), twoLabel);

    await page.click('#bg-harbour-lantern-log');
    await page.waitForSelector('#bg-harbour-lantern-result', { timeout: 15000 });
  }

  // The whole package, in one query.
  {
    const attendance = rows<{ person_id: string }>(
      `SELECT person_id FROM board_game_play_people p
        JOIN board_game_plays y ON y.id = p.play_id
       WHERE y.game_id = 'harbour-lantern' ORDER BY person_id`,
    ).map((row) => row.person_id);

    ok(
      '🐞 A LOGGED PLAY RECORDS WHO PLAYED',
      attendance.join(',') === 'ada,grace',
      attendance.join(',') || '(nobody — the defect)',
    );
  }

  // ── 3. Known-how is marked by default, and undo takes back only what it created ── //
  {
    const claims = rows<{ person_id: string; game_id: string }>(
      'SELECT person_id, game_id FROM board_game_known_how ORDER BY game_id, person_id',
    );
    ok(
      'finishing marked the table as knowing the rules',
      claims.filter((c) => c.game_id === 'harbour-lantern').map((c) => c.person_id).join(',') ===
        'ada,grace',
      JSON.stringify(claims),
    );
    ok(
      'and the claim that predates all of this is untouched',
      claims.some((c) => c.game_id === 'quarry-duel' && c.person_id === 'ada'),
    );

    const line = await page.$eval('#bg-harbour-lantern-known-line', (el) =>
      el.textContent?.trim() ?? '',
    );
    ok(
      'the panel says which claim it just made, by name',
      line.includes('Knows the rules') && line.includes('Ada') && line.includes('Grace'),
      line,
    );

    await page.click('#bg-harbour-lantern-undo');
    await page.waitForTimeout(700);

    const after = rows<{ person_id: string; game_id: string }>(
      'SELECT person_id, game_id FROM board_game_known_how ORDER BY game_id, person_id',
    );
    ok(
      'UNDO takes back exactly the claims this finish created',
      !after.some((c) => c.game_id === 'harbour-lantern'),
      JSON.stringify(after),
    );
    ok(
      'and never a claim somebody stated months ago',
      after.some((c) => c.game_id === 'quarry-duel' && c.person_id === 'ada'),
      JSON.stringify(after),
    );

    const playsAfter = rows<{ c: number }>(
      "SELECT COUNT(*) AS c FROM board_game_plays WHERE game_id = 'harbour-lantern'",
    );
    ok(
      'the PLAY survives the undo — it is a separate fact',
      playsAfter[0]?.c === 1,
      `plays=${playsAfter[0]?.c}`,
    );
  }

  // ── 4. The pick: Tonight → one card, a shortlist behind a control ───────────────── //
  {
    await page.goto(`${server.base}/tonight`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tonight:not([hidden]) .actgrid', { timeout: 30000 });
    await page.waitForTimeout(600);

    await page.click('#tonight-activity [role="radio"]:has-text("Board Games")');
    await page.waitForTimeout(400);

    const blocked = await page.$eval('#tonight-go', (el) =>
      (el as HTMLButtonElement).disabled,
    );
    ok('Go is refused until somebody is at the table', blocked === true);

    await page.click('#tonight-roster input[value="ada"]');
    await page.click('#tonight-roster input[value="grace"]');
    await page.click('#tonight-roster input[value="linus"]');
    await page.waitForTimeout(300);

    // "Knows the rules: Any" — the shelf's only stated claim was withdrawn by the undo two
    // sections above, so `Someone` (the default) would leave one eligible game and there
    // would be no shortlist to hide. Setting it here also exercises the filter mapping.
    await page.click('#tonight-filters [role="radio"]:has-text("Any")');
    await page.waitForTimeout(300);

    await page.click('#tonight-go');
    await page.waitForSelector('#result:not([hidden]) #result-card', { timeout: 20000 });
    await page.waitForTimeout(500);

    const cardCount = await page.$$eval('#result [id$="-game"]', (list) => list.length);
    ok('ONE card, not three', cardCount === 1, `cards=${cardCount}`);

    ok(
      'a pick has a reroll',
      (await page.$('#result-reroll')) !== null,
    );
    ok(
      'and the shortlist is behind a control',
      (await page.$('#result-shortlist')) === null &&
        (await page.$('#result-shortlist-toggle')) !== null,
    );

    await page.click('#result-shortlist-toggle');
    await page.waitForSelector('#result-shortlist', { timeout: 10000 });
    const shortlist = await page.$$eval('#result-shortlist > ul > li', (l) => l.length);
    ok('the control reveals the other two', shortlist === 2, `revealed=${shortlist}`);
  }

  // ── 5. The pick survives leaving the screen ─────────────────────────────────────── //
  {
    const before = await page.$eval('#result-card h2', (el) => el.textContent?.trim() ?? '');

    await page.goto(`${server.base}/collection`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#collection:not([hidden])', { timeout: 20000 });
    await page.goto(`${server.base}/result`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#result:not([hidden]) #result-card', { timeout: 20000 });
    await page.waitForTimeout(400);

    const after = await page.$eval('#result-card h2', (el) => el.textContent?.trim() ?? '');
    ok(
      'leaving the screen and coming back keeps the same card',
      before === after && before !== '',
      `${before} → ${after}`,
    );
  }

  // ── 6. A QUEUE ARRIVAL HAS NO REROLL. The queue chose ───────────────────────────── //
  {
    await page.goto(`${server.base}/result/tidewright`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#result:not([hidden]) #result-card', { timeout: 20000 });
    await page.waitForTimeout(400);

    const name = await page.$eval('#result-card h2', (el) => el.textContent?.trim() ?? '');
    ok('the queue’s own game is the card', name === 'Tidewright', name);
    ok('and there is NO reroll', (await page.$('#result-reroll')) === null);
    ok(
      'nor a shortlist control',
      (await page.$('#result-shortlist-toggle')) === null,
    );
    ok(
      'but you can still say you played it',
      (await page.$('#result-played')) !== null,
    );
  }

  // ── 7. The Narrow View ──────────────────────────────────────────────────────────── //
  {
    await page.setViewportSize({ width: 390, height: 900 });
    await openCollection();
    await page.waitForTimeout(400);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    ok('the Narrow View does not scroll sideways', overflow <= 0, `overflow=${overflow}px`);

    const columns = await page.$eval('#collection-grid', (el) =>
      getComputedStyle(el).gridTemplateColumns.split(' ').length,
    );
    ok('and the shelf is one column there', columns === 1, `columns=${columns}`);
  }
} finally {
  await browser.close();
  stopBoardGameServer(server);
}

console.log(process.exitCode ? 'FAILURES' : 'ALL PASS');
