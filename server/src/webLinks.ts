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
//   * The Plex URL is a HASH url (`/web/index.html#!/server/…`). That is Plex's shape, not
//     ours — the "no `#/` routing" rule binds the apps we own, and this string is an
//     external address we are quoting.
import { PLEX_URL } from './config.js';
import { machineIdentifier } from './playback.js';

/**
 * The item's page in the household's Plex web client (`PLEX_API_SERVER_URL`).
 *
 * Built from `PLEX_URL` rather than `app.plex.tv`: the owner wants the tile to open the
 * reverse-proxied server he already runs, not Plex's hosted client
 * (decision `2026-08-25-plex-tile-links-use-the-server-url-not-app-plex-tv`). The
 * `machineIdentifier` still belongs in the hash — that is how Plex's own web client
 * addresses a library item on a named server.
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
  return `${PLEX_URL}/web/index.html#!/server/${machineId}/details?key=${key}`;
}
