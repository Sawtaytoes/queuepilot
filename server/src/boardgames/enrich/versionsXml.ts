/**
 * Every edition of a title, from XML API `thing?versions=1`.
 *
 * One request, every version's image. The geekdo parent item only has names; this is what the
 * cover picker uses when a token is configured so opening the dialog is not dozens of serial
 * fetches.
 *
 * Nested `<item type="boardgameversion">` blocks do not contain further items, so a non-greedy
 * match is safe here. The sibling `parseThings` regex is *not* — it would stop at the first
 * version's `</item>`.
 */

export interface ThingVersion {
  id: number;
  name: string;
  year: number | null;
  languages: string[];
  publishers: string[];
  imageUrl: string | null;
  thumbnailUrl: string | null;
}

const decodeEntities = (text: string): string =>
  text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&apos;', "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));

const numberOrNull = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const parseThingVersions = (xml: string): ThingVersion[] => {
  const versions: ThingVersion[] = [];

  for (const match of xml.matchAll(
    /<item type="boardgameversion" id="(\d+)">([\s\S]*?)<\/item>/g,
  )) {
    const id = Number(match[1]);
    const body = match[2] ?? '';
    if (!Number.isInteger(id) || id <= 0) continue;

    const name = /<name\b[^>]*value="([^"]+)"/.exec(body)?.[1] ?? '';
    if (name === '') continue;

    const image = /<image>([^<]+)<\/image>/.exec(body)?.[1] ?? null;
    const thumbnail = /<thumbnail>([^<]+)<\/thumbnail>/.exec(body)?.[1] ?? null;
    const year = numberOrNull(/<yearpublished\b[^>]*value="([^"]*)"/.exec(body)?.[1]);
    const languages = [
      ...body.matchAll(/<link\b[^>]*type="language"[^>]*value="([^"]+)"/g),
    ].map((link) => decodeEntities(link[1] ?? ''));
    const publishers = [
      ...body.matchAll(/<link\b[^>]*type="boardgamepublisher"[^>]*value="([^"]+)"/g),
    ].map((link) => decodeEntities(link[1] ?? ''));

    versions.push({
      id,
      imageUrl: image,
      languages,
      thumbnailUrl: thumbnail,
      name: decodeEntities(name),
      publishers,
      year,
    });
  }

  return versions;
};
