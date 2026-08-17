// The BAKE-OFF that chose the reading-list cover: four candidate designs and a gallery page to
// serve over `devshare` so the owner can pick one. He picked A — Plate, 2026-08-17.
//
// This is not the production renderer. The shipping cover is built by
// `server/src/providers/kavita-cover.ts` with Satori, because the runtime image has no
// browser; this file is Chromium-rendered on purpose, so a design can be tried in ordinary CSS
// (blur, mosaics, real cover art) before anything is committed to the Satori subset. Keep the
// winning design in step with kavita-cover.ts by hand, or use this only to pick the next one.
//
//   /mnt/TrueNAS-Apps/Repos/mux-magic/node_modules/.bin/tsx e2e/shot-list-cover.ts
//
// Writes `__screenshots__/list-cover/cover-<id>.png` at 640x960 (Kavita covers are 2:3;
// its own generated ones are 320x455) and `__screenshots__/list-cover/index.html`.
//
// Why a real browser and not Satori/SVG: these are one-off ARTWORK, not a runtime tile, and
// the house rule for "make this look better" is mock → serve → let the owner pick → build
// (docs/runbooks/ui-design-previews.md in the workspace root). Chromium gets us the design
// system's own faces (Baloo 2 / Outfit, self-hosted in @charcuterie/tokens) with no font
// plumbing of our own.
//
// The mosaic art is REAL series covers from the `manga_webtoons` queue, downloaded next to
// the output as `art/<seriesId>.png` — see the header of that folder's README-less contents:
// they are fetched by hand with the Kavita apiKey, because embedding a key in a committed
// preview page is exactly the thing AGENTS.md forbids.
import { mkdirSync, copyFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { chromium } from './playwright.js';

const OUT = '__screenshots__/list-cover';
const ART = `${OUT}/art`;
const FONTS = '/mnt/TrueNAS-Apps/Repos/charcuterie/packages/tokens/fonts';

const SET_LABEL = process.env.COVER_SET_LABEL || 'Manga & Webtoons';

// Design C sets the name at poster scale, so it needs explicit line breaks — an ampersand
// hangs at the end of its line ("Manga &" / "Webtoons"), and anything else breaks before the
// last word. Automatic wrapping would strand the "&" on a line of its own.
const STACKED_LABEL = SET_LABEL.includes(' & ')
  ? SET_LABEL.replace(/ & /g, ' &<br>')
  : SET_LABEL.replace(/ (?=[^ ]+$)/, '<br>');

mkdirSync(OUT, { recursive: true });
mkdirSync(ART, { recursive: true });

for (const f of ['baloo2-1.woff2', 'outfit-1.woff2']) {
  if (existsSync(`${FONTS}/${f}`)) copyFileSync(`${FONTS}/${f}`, `${OUT}/${f}`);
}

// The mosaic wants nine 2:3 tiles for a 3x3 that lands on 640x960 exactly. Take whatever
// real covers were downloaded, in a stable order, so a re-run is deterministic.
const art = readdirSync(ART).filter((f) => f.endsWith('.png') && f !== 'current-153.png');
const mosaic = art.slice(0, 9);

/** The app icon, recoloured for the provider. Dark ink on the green solid is what
 *  `web/src/styles/app.css` already settled on for Kavita (#111 on #4AC694, 8.9:1). */
const mark = (size: number, solid: string, ink: string, radius = 5.5) => `
<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
  <rect width="24" height="24" rx="${radius}" fill="${solid}"/>
  <g transform="translate(12 12) scale(0.86) translate(-12 -12)" fill="none" stroke="${ink}"
     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 6.6 10.6 12 4 17.4Z"/>
    <line x1="13.6" y1="7.2" x2="20.6" y2="7.2"/>
    <line x1="13.6" y1="12" x2="20.6" y2="12"/>
    <line x1="13.6" y1="16.8" x2="20.6" y2="16.8"/>
  </g>
</svg>`;

const CSS = `
@font-face { font-family: "Baloo 2"; font-weight: 400 800; src: url(./baloo2-1.woff2) format("woff2"); }
@font-face { font-family: "Outfit";  font-weight: 100 900; src: url(./outfit-1.woff2) format("woff2"); }

:root {
  --kavita: #4AC694;      /* read live off kavita.example.com; see app.css */
  --kavita-deep: #1E7C5C;
  --ink: #111111;         /* Kavita's on-solid ink per app.css */
  --base: #0F141C;
}
* { box-sizing: border-box; margin: 0; }

.cover {
  width: 640px; height: 960px; position: relative; overflow: hidden;
  font-family: "Outfit", system-ui, sans-serif; color: #fff;
  background: var(--base);
}
.cover h1 {
  font-family: "Baloo 2", system-ui, sans-serif; font-weight: 700;
  line-height: 1.02; letter-spacing: -0.015em;
}
.kicker {
  font-weight: 600; letter-spacing: 0.34em; text-transform: uppercase;
}

/* --- A: plate ------------------------------------------------------------- */
.c-plate {
  background:
    radial-gradient(78% 46% at 50% 26%, rgba(74,198,148,.30) 0%, rgba(74,198,148,0) 70%),
    linear-gradient(180deg, #16211D 0%, #0F141C 58%, #0B0F16 100%);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 72px 64px; text-align: center;
}
.c-plate .mark { filter: drop-shadow(0 18px 40px rgba(74,198,148,.28)); }
.c-plate .kicker { margin-top: 54px; font-size: 25px; color: var(--kavita); }
.c-plate h1 { margin-top: 22px; font-size: 76px; }
.c-plate .rule { width: 92px; height: 4px; border-radius: 2px; background: var(--kavita); margin: 40px 0 26px; }
.c-plate .caption { font-size: 25px; letter-spacing: .04em; color: #8DA2AE; }

/* --- B: mosaic ------------------------------------------------------------ */
.c-mosaic .grid {
  position: absolute; inset: 0; display: grid;
  grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(3, 1fr);
}
.c-mosaic .grid img { width: 100%; height: 100%; object-fit: cover; display: block;
  filter: saturate(.9) brightness(.86); }
.c-mosaic .veil {
  position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(11,15,22,.34) 0%, rgba(11,15,22,.06) 30%,
              rgba(11,15,22,.46) 62%, rgba(11,15,22,.93) 86%, #0B0F16 100%);
}
.c-mosaic .foot {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 0 54px 56px;
  display: flex; flex-direction: column; gap: 18px;
}
.c-mosaic .row { display: flex; align-items: center; gap: 18px; }
.c-mosaic .kicker { font-size: 22px; color: var(--kavita); }
.c-mosaic h1 { font-size: 62px; text-shadow: 0 4px 26px rgba(0,0,0,.7); }

/* --- C: type -------------------------------------------------------------- */
.c-type {
  background: linear-gradient(158deg, #5BD3A2 0%, #34A97D 38%, #1B6E53 72%, #0E241C 100%);
  padding: 62px 58px; display: flex; flex-direction: column; justify-content: space-between;
}
.c-type .top { display: flex; align-items: center; justify-content: space-between; }
.c-type .kicker { font-size: 23px; color: rgba(6,26,19,.74); }
.c-type h1 { font-size: 116px; color: #08241A; letter-spacing: -0.035em; margin: 92px 0 0; }
.c-type .meta { font-size: 26px; color: rgba(255,255,255,.88); letter-spacing: .02em; }
.c-type .bar { height: 4px; width: 100%; background: rgba(255,255,255,.32); margin-bottom: 22px; }

/* --- D: blur -------------------------------------------------------------- */
/* The same real covers as B, but out of focus: the shelf as ATMOSPHERE rather than as a
 * list of titles, so a lineup that changes next launch does not date the artwork. */
/* Four tiles, not nine: nine colour fields averaged out to grey mud once blurred. */
.c-blur .grid {
  position: absolute; inset: -14%; display: grid;
  grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(2, 1fr);
  filter: blur(52px) saturate(1.7) brightness(.78); transform: scale(1.08);
}
.c-blur .grid img { width: 100%; height: 100%; object-fit: cover; display: block; }
.c-blur .veil {
  position: absolute; inset: 0;
  background:
    radial-gradient(74% 44% at 50% 34%, rgba(74,198,148,.26) 0%, rgba(74,198,148,0) 74%),
    linear-gradient(180deg, rgba(11,15,22,.52) 0%, rgba(11,15,22,.34) 40%, rgba(11,15,22,.88) 100%);
}
.c-blur .body {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; text-align: center; padding: 72px 58px;
}
.c-blur .mark { filter: drop-shadow(0 18px 44px rgba(0,0,0,.45)); }
.c-blur .kicker { margin-top: 46px; font-size: 24px; color: #EAF6F1; }
.c-blur h1 { margin-top: 20px; font-size: 74px; text-shadow: 0 6px 30px rgba(0,0,0,.55); }
.c-blur .caption { margin-top: 30px; font-size: 25px; color: rgba(234,246,241,.78); }
`;

const covers: { id: string; name: string; note: string; html: string }[] = [
  {
    id: 'plate',
    name: 'A — Plate',
    note: 'The app mark, in the queue’s provider colour. Set name in the design system’s '
      + 'own heading face. Never goes stale; reads at any size.',
    html: `
<div class="cover c-plate">
  <div class="mark">${mark(216, '#4AC694', '#111111', 5.0)}</div>
  <div class="kicker">QueuePilot</div>
  <h1>${SET_LABEL}</h1>
  <div class="rule"></div>
  <div class="caption">Reading queue</div>
</div>`,
  },
  {
    id: 'mosaic',
    name: 'B — Mosaic',
    note: 'Nine real covers from the queue behind a dark veil. Looks like the shelf it is — '
      + 'but it is a SNAPSHOT: the lineup is rebuilt every launch, so the art dates.',
    html: `
<div class="cover c-mosaic">
  <div class="grid">${mosaic.map((f) => `<img src="./art/${f}" alt="">`).join('')}</div>
  <div class="veil"></div>
  <div class="foot">
    <div class="row">${mark(46, '#4AC694', '#111111', 6.5)}<span class="kicker">QueuePilot</span></div>
    <h1>${SET_LABEL}</h1>
  </div>
</div>`,
  },
  {
    id: 'type',
    name: 'C — Type',
    note: 'Kavita green carrying the whole frame, set name as the artwork. Loudest of the '
      + 'four in a grid of muted manga covers.',
    html: `
<div class="cover c-type">
  <div class="top">
    <span class="kicker">QueuePilot</span>
    ${mark(72, 'rgba(8,36,26,.86)', '#5BD3A2', 6.5)}
  </div>
  <h1>${STACKED_LABEL}</h1>
  <div>
    <div class="bar"></div>
    <div class="meta">Reading queue · rebuilt on launch</div>
  </div>
</div>`,
  },
  {
    id: 'blur',
    name: 'D — Blur',
    note: 'B’s art, out of focus, under A’s plate. Keeps the shelf’s colour without naming '
      + 'any title — so a lineup that changes next launch does not date it.',
    html: `
<div class="cover c-blur">
  <div class="grid">${mosaic.slice(0, 4).map((f) => `<img src="./art/${f}" alt="">`).join('')}</div>
  <div class="veil"></div>
  <div class="body">
    <div class="mark">${mark(180, '#4AC694', '#111111', 5.0)}</div>
    <div class="kicker">QueuePilot</div>
    <h1>${SET_LABEL}</h1>
    <div class="caption">Reading queue</div>
  </div>
</div>`,
  },
];

const page = `<!doctype html><meta charset="utf-8"><title>cover render</title>
<style>${CSS} body { margin: 0; background: #222; display: flex; gap: 40px; padding: 40px; }</style>
${covers.map((c) => `<div id="${c.id}">${c.html}</div>`).join('\n')}`;

writeFileSync(`${OUT}/render.html`, page);

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 3200, height: 1100 }, deviceScaleFactor: 1 });
await p.goto(`file://${process.cwd()}/${OUT}/render.html`, { waitUntil: 'load' });
await p.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready);
await p.waitForTimeout(400);
for (const c of covers) {
  await p.locator(`#${c.id} .cover`).screenshot({ path: `${OUT}/cover-${c.id}.png` });
  console.log('wrote', `${OUT}/cover-${c.id}.png`);
}
await browser.close();

// --- the gallery the owner actually looks at --------------------------------------- //
// Two readings of the same four: at Kavita's real card size (which is the ONLY size that
// matters — that is where he sees it) and full-bleed for the detail.
const hasCurrent = existsSync(`${ART}/current-153.png`);
const card = (src: string, label: string, sub: string) => `
  <figure class="card">
    <img src="${src}" alt="">
    <figcaption><b>${label}</b><span>${sub}</span></figcaption>
  </figure>`;

const gallery = `<!doctype html><meta charset="utf-8"><title>Kavita list cover — options</title>
<style>
${CSS}
body { margin: 0; background: #202020; color: #e8e8e8;
       font-family: "Outfit", system-ui, sans-serif; padding: 40px 48px 96px; }
h2 { font-family: "Baloo 2", sans-serif; font-weight: 700; font-size: 30px; margin: 44px 0 6px; }
p.lede { color: #9aa4ad; max-width: 74ch; line-height: 1.55; margin-bottom: 24px; }
.shelf { display: flex; gap: 26px; flex-wrap: wrap; align-items: flex-start; }
.card { width: 160px; margin: 0; }
.card img { width: 160px; height: 240px; object-fit: cover; border-radius: 6px; display: block;
            background: #111; box-shadow: 0 6px 20px rgba(0,0,0,.45); }
.card figcaption { display: flex; flex-direction: column; gap: 2px; padding-top: 8px;
                   font-size: 14px; line-height: 1.3; }
.card figcaption span { color: #8b949d; font-size: 12.5px; }
.big { display: flex; gap: 34px; flex-wrap: wrap; }
.big figure { width: 320px; margin: 0; }
.big img { width: 320px; height: 480px; border-radius: 8px; display: block;
           box-shadow: 0 10px 34px rgba(0,0,0,.5); }
.big figcaption { padding-top: 12px; font-size: 14px; color: #9aa4ad; line-height: 1.5; }
.big figcaption b { color: #e8e8e8; display: block; font-size: 16px; margin-bottom: 4px; }
</style>
<h2 style="margin-top:0">Kavita reading list — cover options</h2>
<p class="lede">The list is <b>QueuePilot — manga_webtoons</b> (<code>/lists/153</code>). Today its
cover is whatever Kavita auto-generated from the first chapter in the lineup, so it changes
every launch and is usually an interior page. Pick one — or say what to change about it.</p>

<h2>At Kavita’s card size</h2>
<p class="lede">This is the size that decides it: the list grid at <code>/lists</code>.</p>
<div class="shelf">
${hasCurrent ? card('./art/current-153.png', 'Today', 'auto-generated') : ''}
${covers.map((c) => card(`./cover-${c.id}.png`, c.name, `${c.id}`)).join('')}
</div>

<h2>Full size</h2>
<div class="big">
${covers.map((c) => `<figure><img src="./cover-${c.id}.png" alt="">
  <figcaption><b>${c.name}</b>${c.note}</figcaption></figure>`).join('')}
</div>
`;
writeFileSync(`${OUT}/index.html`, gallery);
console.log('wrote', `${OUT}/index.html`);
