// THE WP-9 PRESET GATE — a preset card lands on the RESULT CARD, never on an empty form.
//
// ## The claim
//
// The absorb decision's NFC table (`2026-08-22-tonight-picker-merge…` §5) has four rows. Three
// of them worked before WP-9: a kids rotation card and a curated-queue card are
// `{"set": "<id>"}` over MQTT (gated by `nfc-wire-contract-test.ts`), and a solo reading card
// is `/go/<setId>`. The fourth is a **Pick preset** — people and filters baked into the card —
// and §5's last line says where it has to land: *"Pick-preset NFC → land on result card (or
// announce), not an empty form."*
//
// `/what-to-watch-play/go?…` is that card's address. This suite drives it in a real browser and asserts
// the landing, because the failure it guards is invisible to every unit test: the parse can be
// perfect, the draw can succeed, and the screen can still paint the Who's-here form for a
// moment or land back on it — which from the couch reads as "the card did not work".
//
// ## And the row that is a RULE rather than a gap
//
// The fourth row's ❌ — *"bare board games needing live who's-here: use the app"* — is pinned
// here too. A card is a fixed string on plastic and cannot see who walked in, so a preset that
// names nobody is REFUSED. The temptation is to "fix" it by defaulting to everybody, which
// would pick for a table whose size nobody stated. The refusal landing on the form, with what
// the card DID say already filled in, is the correct behaviour and this is what stops somebody
// helpfully removing it.
//
// Self-contained: its own server over `fixtures/tonight.*`, an unroutable Plex, no token.
//
// Run:  PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
//         server/node_modules/.bin/tsx e2e/tonight-preset-test.ts   (repo root)
import { chromium } from './playwright.js';
import { startTonightServer, stopTonightServer } from './tonight-harness.js';

const PORT = 18845;
const ok = (name: string, isPass: boolean, extra = ''): void => {
  console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!isPass) process.exitCode = 1;
};

const server = await startTonightServer(PORT);
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1420, height: 1100 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  /** Open a card's address and wait for the app to finish deciding where it lands. */
  const tap = async (href: string): Promise<void> => {
    await page.goto(`${server.base}${href}`, { waitUntil: 'domcontentloaded' });
    // The preset draws before it navigates, so wait for the URL to stop being the card's.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!new URL(page.url()).pathname.startsWith('/what-to-watch-play/go')) break;
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(500);
  };

  const path = (): string => new URL(page.url()).pathname;
  const isVisible = async (selector: string): Promise<boolean> =>
    page.locator(selector).isVisible().catch(() => false);

  // ── 1. A VALID PRESET LANDS ON THE RESULT CARD ──────────────────────────────────── //
  //
  // "Ada · Reading" — the example the absorb brief §2 gives for a preset somebody would
  // actually use. Reading is queue-first, so the draw picks one queue for the activity and
  // the people the card names; `manga_webtoons` is the fixture's Kavita queue and Ada is the
  // one person filed on it.
  {
    await tap('/what-to-watch-play/go?activity=reading&people=ada');

    ok('a valid preset card lands on /result', path() === '/result', page.url());
    ok('…and a result CARD is on the screen', await isVisible('#result-card'));
    ok(
      '…not the empty state that says there is no pick',
      !(await isVisible('#result-none')),
    );
    ok(
      '…and never the Who’s-here form the card exists to skip',
      !(await isVisible('#tonight-people')),
    );

    const card = (await page.locator('#result-card').textContent()) ?? '';
    ok(
      '…naming the queue the CARD’s people resolved to',
      card.includes('Manga'),
      card.replace(/\s+/g, ' ').slice(0, 120),
    );

    // A preset is a PICK, so it keeps its reroll. (`/result/<gameId>` is the other origin —
    // a queue arrival — and that one has no reroll because the queue already chose.)
    ok('…with a reroll, because a preset picked and a queue did not', await isVisible('#result-reroll'));
  }

  // ── 1b. GUESTS ALONE ARE ALSO "WHO'S HERE" ──────────────────────────────────────── //
  //
  // An anonymous seat is somebody at the table. A card for a room whose occupants have no
  // roster rows still draws — which is what stops the who's-here rule from meaning "only
  // people the app already knows about".
  {
    await tap('/what-to-watch-play/go?activity=movies&guests=2');

    ok('a card carrying only guests still draws', path() === '/result', page.url());
    ok('…and lands on a card', await isVisible('#result-card'));
  }


  // ── 2. THE CARD'S ADDRESS DOES NOT SURVIVE IN THE HISTORY ───────────────────────── //
  //
  // A card is a one-shot instruction. Left in the history, Back re-runs the draw and the
  // pick changes under somebody who only wanted to look at the previous screen.
  {
    await page.goBack();
    await page.waitForTimeout(600);
    ok(
      'Back does not return to the card’s address and re-draw',
      !path().startsWith('/what-to-watch-play/go'),
      page.url(),
    );
  }

  // ── 3. A CARD THAT NAMES NOBODY IS REFUSED ──────────────────────────────────────── //
  //
  // Brief §5's fourth row, and a RULE rather than a gap: a card cannot see the room.
  {
    await tap('/what-to-watch-play/go?activity=board-games&light=on');

    ok('a card that names nobody lands on the form', path() === '/what-to-watch-play', page.url());
    ok('…and the form is really there', await isVisible('#tonight-people'));
    ok('…rather than on a result', !(await isVisible('#result-card')));

    const note = (await page.locator('#tonight-preset-note').textContent()) ?? '';
    ok('…and it says WHY, in one sentence', /who is here/i.test(note), note);

    // What the card DID say is applied, so the one missing answer is the only thing left.
    const chosen = await page
      .locator('#tonight-activity [role="radio"][aria-checked="true"]')
      .textContent()
      .catch(() => '');
    ok(
      '…with the activity the card asked for already chosen',
      (chosen ?? '').includes('Board Games'),
      chosen ?? '',
    );
  }

  // ── 4. SURPRISE ME CANNOT BE BAKED INTO A CARD ──────────────────────────────────── //
  //
  // It narrows on a second screen before it picks, and what it narrows BY is not settled.
  {
    await tap('/what-to-watch-play/go?activity=surprise&people=ada');

    ok(
      'a Surprise Me card lands on the narrowing screen, not on a result',
      path() === '/what-to-watch-play/surprise',
      page.url(),
    );
    ok('…and not on a result card', !(await isVisible('#result-card')));
  }

  // ── 5. A CARD THAT NAMES SOMETHING THAT IS NOT A TILE ───────────────────────────── //
  //
  // A card is written once and read for years, so the failure to design for is a typo. It
  // must say what the card asked for rather than silently picking something else.
  {
    await tap('/what-to-watch-play/go?activity=retro-games&people=ada');

    ok('an unknown activity lands on the form', path() === '/what-to-watch-play', page.url());
    const note = (await page.locator('#tonight-preset-note').textContent()) ?? '';
    ok('…quoting what the card actually said', note.includes('retro-games'), note);
  }

  // ── 6. A DRAW THAT COMES BACK EMPTY SAYS SO ─────────────────────────────────────── //
  //
  // The card is valid and the draw is real; there is simply nothing that matches. The
  // landing is the form carrying the queue engine's OWN sentence — never a result card with
  // nothing on it, and never a silent bounce to the landing page.
  {
    await tap('/what-to-watch-play/go?activity=movies&people=ada');

    ok('an empty draw lands on the form', path() === '/what-to-watch-play', page.url());
    ok('…and not on an empty result card', !(await isVisible('#result-card')));

    const note = (await page.locator('#tonight-preset-note').textContent()) ?? '';
    ok(
      '…carrying the draw’s own reason rather than an invented one',
      /No queue matches that activity/i.test(note),
      note,
    );
  }

  // ── 7. A QUEUE ARRIVAL IS STILL A DIFFERENT CARD ────────────────────────────────── //
  //
  // `/result/<gameId>` reads its game out of the URL and needs no stored session, which is
  // what makes it reachable cold from a card or a provider hand-off. The fixture has no
  // collection behind it, so the game is unknown — and the assertion is that the route is
  // ALIVE and answers with the card's own empty state rather than 404ing or falling through
  // to the landing.
  {
    await page.goto(`${server.base}/result/no-such-game`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    ok('/result/<gameId> is a live address', path() === '/result/no-such-game', page.url());
    ok(
      '…and it does not offer a reroll — the queue already chose',
      !(await isVisible('#result-reroll')),
    );
  }
} finally {
  await browser.close();
  stopTonightServer(server);
}
