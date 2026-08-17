// The artwork QueuePilot puts on the Reading List it builds in Kavita.
//
// Without this, a list's cover is whatever Kavita generated from the first chapter of the
// lineup — an interior page of whichever webtoon happened to come up, which changes on every
// launch because the list is REBUILT on every launch
// (docs/decisions/2026-08-15-the-reading-list-is-rebuilt-not-appended.md). The owner picked
// this design out of four rendered options on 2026-08-17; see
// docs/decisions/2026-08-17-queuepilot-gives-its-reading-lists-a-cover.md.
//
// SVG OUT, NOT PNG. Kavita's upload endpoint rasterizes what it is given (libvips), and
// verified live: a Satori SVG comes back as its own 213x320 cover PNG, correct glyphs and
// gradients. That is why nothing here depends on resvg/sharp — the only raster step happens
// on Kavita's side, where it was going to happen anyway.
//
// SATORI, NOT A HAND-WRITTEN <text> SVG. Kavita's rasterizer ignores an `@font-face` with a
// data-URI src (probed: the text came back in the container's DejaVu), so a `<text>` element
// would silently be set in whatever font that container has. Satori converts glyphs to PATHS,
// so the cover is set in the app's own Baloo 2 / Outfit no matter what the far side has
// installed — and it brings flex layout, which is what wraps a long set label without this
// file measuring text by hand.
import satori from 'satori';
import { BALOO_2_BOLD_TTF_BASE64, OUTFIT_REGULAR_TTF_BASE64, OUTFIT_SEMIBOLD_TTF_BASE64 } from './kavita-cover-fonts.js';

/** Kavita stores list covers at 213x320. Rendering at 3x keeps the type crisp after it downsizes. */
const WIDTH = 640;
const HEIGHT = 960;

/** Kavita's own green, and the ink it puts on it — the same pair `web/src/styles/app.css`
 *  uses for a `[data-provider="kavita"]` queue, so the cover and the card that launches it
 *  are the same colour. */
const GREEN = '#4AC694';
const INK = '#111111';

const decode = (base64: string) => Buffer.from(base64, 'base64');

/**
 * The app icon (`icon.svg`), in the provider's colour rather than QueuePilot's amber.
 *
 * Inlined as an `<img>` data URI because Satori renders SVG images but does not take an SVG
 * element tree in the layout: `icon.svg` is the source of this geometry and the two must be
 * kept in step by hand.
 */
function markDataUri(size: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">`
    + `<rect width="24" height="24" rx="5" fill="${GREEN}"/>`
    + `<g transform="translate(12 12) scale(0.86) translate(-12 -12)" fill="none" stroke="${INK}"`
    + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M4 6.6 10.6 12 4 17.4Z"/>'
    + '<line x1="13.6" y1="7.2" x2="20.6" y2="7.2"/>'
    + '<line x1="13.6" y1="12" x2="20.6" y2="12"/>'
    + '<line x1="13.6" y1="16.8" x2="20.6" y2="16.8"/>'
    + '</g></svg>';
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * Title size by label length. Satori wraps, so nothing here prevents overflow of the WIDTH —
 * it prevents a four-line title from pushing the rule and caption off the bottom of a fixed
 * 960px frame. Three steps, measured against the longest labels in sets.yaml
 * ("Older Kids — Shorts & Shows" is the worst case at 27).
 */
function titleFontSize(label: string): number {
  if (label.length > 30) return 52;
  if (label.length > 18) return 64;
  return 76;
}

/**
 * The cover for one queue, as SVG markup.
 *
 * `label` is the set's human label ("Manga & Webtoons"), never its id — the id is a slug and
 * the list title already carries it.
 */
export async function readingListCoverSvg(label: string): Promise<string> {
  const title = label.trim() || 'Reading queue';
  const element = {
    type: 'div',
    props: {
      style: {
        width: WIDTH,
        height: HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '72px 64px',
        backgroundColor: '#0F141C',
        backgroundImage:
          `radial-gradient(78% 46% at 50% 26%, rgba(74,198,148,0.30) 0%, rgba(74,198,148,0) 70%)`,
        color: '#ffffff',
        fontFamily: 'Outfit',
      },
      children: [
        { type: 'img', props: { src: markDataUri(216), width: 216, height: 216 } },
        {
          type: 'div',
          props: {
            style: {
              marginTop: 54, fontSize: 25, fontWeight: 600, letterSpacing: 8.5, color: GREEN,
            },
            children: 'QUEUEPILOT',
          },
        },
        {
          type: 'div',
          props: {
            style: {
              marginTop: 22,
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              textAlign: 'center',
              fontFamily: 'Baloo 2',
              fontWeight: 700,
              fontSize: titleFontSize(title),
              lineHeight: 1.02,
            },
            children: title,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              width: 92, height: 4, borderRadius: 2, backgroundColor: GREEN,
              marginTop: 40, marginBottom: 26,
            },
          },
        },
        {
          type: 'div',
          props: { style: { fontSize: 25, color: '#8DA2AE' }, children: 'Reading queue' },
        },
      ],
    },
  };

  return satori(element, {
    width: WIDTH,
    height: HEIGHT,
    fonts: [
      { name: 'Baloo 2', data: decode(BALOO_2_BOLD_TTF_BASE64), weight: 700, style: 'normal' },
      { name: 'Outfit', data: decode(OUTFIT_SEMIBOLD_TTF_BASE64), weight: 600, style: 'normal' },
      { name: 'Outfit', data: decode(OUTFIT_REGULAR_TTF_BASE64), weight: 400, style: 'normal' },
    ],
  });
}

/**
 * The same cover in the shape Kavita's upload endpoint wants: RAW base64, no `data:` prefix.
 *
 * The prefixed spelling is a 400 ("Unable to save cover image to Reading List") — probed live
 * on a throwaway list, both ways, 2026-08-17. Kavita's own web UI sends the prefixed form for
 * some upload endpoints, which is exactly why this is worth a function and a comment rather
 * than an inline `toString('base64')` at the call site.
 */
export async function readingListCoverBase64(label: string): Promise<string> {
  return Buffer.from(await readingListCoverSvg(label)).toString('base64');
}
