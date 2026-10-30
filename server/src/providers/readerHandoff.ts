import { html } from 'hono/html';

/** Navigation-only document: never expose these destinations in catalog JSON. */
export function readerHandoff(destination: string) {
  const url = new URL(destination);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Unsupported reader address');
  }
  // A fresh tap after the rebuild avoids depending on a possibly expired redirect
  // gesture. No package is guessed: Android still decides which installed app handles it.
  const intent = `intent:${url.href.slice(url.protocol.length)}#Intent;scheme=${url.protocol.slice(0, -1)};action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;S.browser_fallback_url=${encodeURIComponent(url.href)};end`;
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Open Kavita · QueuePilot</title>
<style>
:root { color-scheme: light dark; font: 18px/1.5 system-ui, sans-serif; }
body { margin: 0; padding: 24px; } main { max-width: 36rem; margin: 10vh auto; }
h1 { font-size: 1.6rem; } a { display: block; padding: 16px 0; overflow-wrap: anywhere; }
</style></head><body><main>
<h1>Your reading list is ready</h1>
<p>Tap to open Kavita. Android chooses whether to use the installed app or the browser.</p>
<a href="${intent}" rel="noreferrer noopener">Open Kavita</a>
<a href="${url.href}" rel="noreferrer noopener">Open Kavita website</a>
<a href="/play">Return to QueuePilot</a>
</main></body></html>`;
}
