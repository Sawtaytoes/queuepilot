# Android reading handoff

On Android, launching a Kavita queue prepares the reading list once, then displays
**Open Kavita** and **Open Kavita website**. Other devices retain the existing HTTP
redirect. The queue's Read link remains a document navigation through `/go/:setId`;
removing `isExternal` would let the SPA router intercept the rebuild route.

The first link uses Chrome's Android intent syntax with the complete reader URL and
an encoded HTTPS/HTTP fallback. It does not guess an installed package or force a
particular browser. The fresh tap occurs after the asynchronous rebuild, avoiding
reliance on the original redirect's gesture window. The website link opens the same
prepared chapter and reading list without another rebuild.

Android and Chrome still decide which application receives the URL. The installed
Kavita web app must cover the destination address, and its supported web addresses
must be enabled. A package-less intent can still resolve to Chrome. This page offers
an explicit handoff, not a guarantee of app selection; actual device acceptance is
required before calling that issue resolved.

This small server-rendered navigation document deliberately has no SPA bundle or
client-side JavaScript. It uses standard links, a restrictive CSP, no caching, HTML
attribute escaping, and no referrer. Provider addresses appear only at navigation
time, never in catalog JSON. The exact `readingListId`, chapter, and `?only=` behavior
is retained. It does not add a custom scheme to Kavita or change its installation.

## Verification

- Server route regression: `pnpm --filter queuepilot-server test`.
- Browser document gate: `server/node_modules/.bin/tsx e2e/reader-handoff-test.ts`.
  Runs phone, portrait, desktop, and ultrawide windows, checks layout and full website
  fallback, and writes fixture screenshots under `docs/images/android-reader-handoff/`.
  The before images show a stub reader destination, not Android's browser controls.
- The browser gate cannot verify WebAPK resolution, Android task switching, custom-tab
  chrome, or an installed Kavita session. Test the installed QueuePilot Read action on
  an Android phone, including a slow rebuild and a device without Kavita installed.

References: [Chrome Android intents](https://developer.chrome.com/docs/android/intents)
and [Chromium external navigation rules](https://chromium.googlesource.com/chromium/src/+/main/components/external_intents/README.md).
