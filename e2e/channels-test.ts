import { chromium } from './playwright.js';
import { pickValue, readOptions } from './pick.js';

/** The slice of `GET /api/sets` this suite asserts on. `Response.json()` hands back `any`,
 * so without a shape the `.sets.find(...)` walks below all collapse to implicit-any. */
interface ProfileBinding {
  plex_user: string;
  allowed_ratings: string[];
  movie_ratings: string[];
}
interface SetsResponse {
  sets: { id: string; profiles?: ProfileBinding[] }[];
}
const ok = (name: string, isPass: boolean) => { console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}`); if (!isPass) process.exitCode = 1; };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:18768/queues', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.shelf');
ok('no Refresh button', !(await page.$('#refresh')));

// Channels navigation: channel picker (2 generic + 3 anime channels) + tier picker.
await page.click('#channelslink');
await page.waitForSelector('#channels:not([hidden])');
const channels = await readOptions(page, '[data-testid="chchannel"]');
ok(`channel dropdown: 2 function channels + 3 curated (${channels.length})`,
  channels.length === 5 && channels[0] === 'Shows & Shorts' && channels[1] === 'Movies');
// The tier picker lists ONLY the selected channel's own bindings — no cross-channel
// duplicates (the split-channels bug: every progress channel folded into one dropdown).
const profiles = await readOptions(page, '[data-testid="chprofile"]');
ok('tier dropdown has both tiers, once each', profiles.join(',') === 'Younger Kids,Older Kids');
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Preview failed'), undefined, { timeout: 15000 });
ok('preview fails gracefully without MQTT', true);
const ratings = await page.$$eval<string[], HTMLInputElement>('#ch-ratings input', (is) => is.filter((i) => i.checked).map((i) => i.value));
ok('younger ratings prefilled', ratings.includes('G') && ratings.includes('TV-Y') && !ratings.includes('PG'));
const showlibs = await page.$$eval<string[], HTMLInputElement>('#ch-showlibs input', (is) => is.filter((i) => i.checked).map((i) => i.value));
ok('show libs prefilled (Shows=5)', showlibs.join(',') === '5');

// Item libraries split the way Plex styles them: Movie libraries vs Other videos.
// Shorts (15) is a REAL movie library — it must sit in the Movie group, checked.
const movieLabels = await page.$$eval('#ch-movielibs label', (ls) => ls.map((l) => (l.textContent ?? '').trim()));
const otherLabels = await page.$$eval('#ch-otherlibs label', (ls) => ls.map((l) => (l.textContent ?? '').trim()));
ok('Shorts under Movie libraries, not Other', movieLabels.includes('Shorts') && !otherLabels.includes('Shorts'));
ok('Other videos holds the Personal-Media libs', otherLabels.includes('Demos') && !movieLabels.includes('Demos'));
const shortsChecked = await page.$eval<boolean, HTMLInputElement>('#ch-movielibs input[value="15"]', (i) => i.checked);
ok('Shorts prefilled in Movie group', shortsChecked);

// Edit filters: add PG to the Younger binding of Shows & Shorts, save. It must land on
// that channel's Younger profile binding (not a legacy set), and the binding's
// movie_ratings must NOT follow (movie_ratings decoupled from allowed_ratings).
await page.check('#ch-ratings input[value="PG"]');
await page.click('#ch-save');
await page.waitForFunction(async () => {
  const r: SetsResponse = await fetch('/api/sets').then((x) => x.json());
  const b = r.sets.find((s) => s.id === 'shows_shorts')?.profiles?.find((p) => p.plex_user === 'Younger Kids');
  return b?.allowed_ratings.includes('PG');
}, undefined, { timeout: 15000 });
ok('filters saved to the Younger binding (persisted to sets.yaml)', true);
const movieRatings = await page.evaluate(() =>
  fetch('/api/sets').then((x) => x.json()).then((r: SetsResponse) =>
    r.sets.find((s) => s.id === 'shows_shorts')?.profiles?.find((p) => p.plex_user === 'Younger Kids')?.movie_ratings ?? null));
// `!== null` and not `?? []`: a binding that went MISSING must fail this assertion, not
// sail through it on an empty list.
ok('movie_ratings NOT dragged along by the shows save', movieRatings !== null && !movieRatings.includes('PG'));

// Movies channel: ratings prefilled from movie_ratings, and the LIBRARY pickers show —
// the rewatch pool follows them now (it used to be hardwired to the Movies section).
await pickValue(page, '[data-testid="chchannel"]', 'movies');
await page.waitForFunction(() => document.body.classList.contains('movies-channel'), undefined, { timeout: 15000 });
ok('movies channel hides the shows-only blocklist',
  await page.$eval('#chfilters .showsonly', (e) => getComputedStyle(e).display === 'none'));
ok('movies channel shows the library pickers',
  await page.$eval('#ch-movielibs', (e) => getComputedStyle(e).display !== 'none'));
ok('movies channel prefills its own library (Movies=1)',
  await page.$eval<boolean, HTMLInputElement>('#ch-movielibs input[value="1"]', (i) => i.checked));
const mratings = await page.$$eval<string[], HTMLInputElement>('#ch-ratings input', (is) => is.filter((i) => i.checked).map((i) => i.value));
ok('movies ratings prefilled from movie_ratings (no PG)', mratings.includes('G') && !mratings.includes('PG'));

// An anime channel in the picker opens the grid editor in channel mode: no ordering UI.
await pickValue(page, '[data-testid="chchannel"]', 'q:bob_anime');
await page.waitForSelector('#queue:not([hidden])');
ok('anime channel opens grid editor in channel mode',
  await page.evaluate(() => document.body.classList.contains('channel-mode')));
ok('channel mode: no top/bottom picker',
  await page.$eval('#queue .addpos', (e) => getComputedStyle(e).display === 'none'));
ok('channel mode: random-order note shown', /random order/.test(await page.textContent('#sub') ?? ''));
await page.click('#back');
await page.waitForSelector('#channels:not([hidden])');
ok('channel editor backs out to Channels', true);

// Play menu degrades without MQTT
await page.click('#chplay');
await page.waitForFunction(() => /MQTT/i.test(document.querySelector('.playmenu p')?.textContent || ''), undefined, { timeout: 15000 });
ok('play menu shows MQTT-down message', true);
await page.click('#heading');

// Back to the Play landing; rows have play buttons; queue view has one too.
await page.click('#back');
await page.waitForSelector('#play:not([hidden]) .playcard');
ok('channels back out to Play landing', true);
ok('landing rows have play buttons', (await page.$$('.playcard .playbtn')).length >= 5);
await page.click('#goqueues');
await page.waitForSelector('#home:not([hidden]) .shelf');
ok('shelf play button present', Boolean(await page.$('.shelf .shelfplay')));
await page.click('.shelf .open');
await page.waitForSelector('#queue:not([hidden])');
ok('queue play button present', Boolean(await page.$('#qplay:not([hidden])')));
await browser.close();
console.log('done');
