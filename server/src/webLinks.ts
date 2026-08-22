// The link OUT of QueuePilot: where a tile's item lives in the app that owns it.
//
// A tile names something Plex or Kavita already has a page for, and until now the only way
// to that page was to search for the title again by hand. The tile carries the URL instead,
// so the frontend renders an anchor and never has to know a provider's URL shape.
//
// Two rules this file exists to keep:
//
//   * The link addresses the SHOW or the FILM, never the next episode. The tile's next-up
//     line already names the episode, and the line is a control (tap to set the start
//     point) — a second meaning on it is a second thing to explain.
//     (decision `2026-08-22-a-tile-links-to-its-item-in-plex-or-kavita`)
//   * `app.plex.tv` is Plex's own hosted client, and it is a HASH url. That is Plex's
//     shape, not ours — the "no `#/` routing" rule binds the apps we own, and this string
//     is an external address we are quoting.
import { machineIdentifier } from './playback.js';

/**
 * The item's page in Plex's hosted web client.
 *
 * `app.plex.tv` rather than `PLEX_URL/web`: the server URL is reachable on the LAN and
 * from the reverse proxy, and the household opens this from phones and tablets on
 * networks where neither answers. app.plex.tv resolves the server by machineIdentifier,
 * so one URL works everywhere the account is signed in.
 *
 * Returns null — and the tile then renders no link at all — when the id is missing or the
 * machine id could not be read. A dead link is worse than no link.
 */
export async function plexWebUrl(
  ratingKey: string | null | undefined,
): Promise<string | null> {
  if (!ratingKey) return null;

  const machineId = await machineIdentifier();
  if (!machineId) return null;

  const key = encodeURIComponent(`/library/metadata/${ratingKey}`);
  return `https://app.plex.tv/desktop/#!/server/${machineId}/details?key=${key}`;
}
