import { QueryProvider } from "@charcuterie/logic/query"
import { ReactRouterAdapter } from "@charcuterie/ui/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router"

import { App } from "./App"
import { queryClient } from "./lib/queryClient"
import "./styles/app.css"

const rootElement = document.getElementById("root")

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <QueryProvider client={queryClient}>
        {/* Real paths, not `#/…` — the server serves index.html for any unmatched
            extensionless path (`hasSpaFallback: true` in `server/src/buildServer.ts`),
            and the two have to stay in step or a reload on `/picks` 404s. */}
        <BrowserRouter>
          {/* Both of Charcuterie's router seams, wired once.

              The LINK seam. A `ButtonLink` renders a plain `<a href>` unless the app
              injects its router, and a plain `<a>` to an in-app path is a FULL RELOAD —
              the SPA boots again, the query cache is thrown away and the scroll position
              with it. `getIsRoutedHref` still sends another origin, `mailto:` and `#frag`
              to the browser, which is why the Plex/Kavita launchers keep working.

              The SCROLL seam. `Main` remembers where each history entry was scrolled to,
              so Back returns a long queue to where the reader left it. No browser does
              that for an inner scrollport, and `Shell` makes `<main>` this app's one
              vertical scroll region.

              Inside `BrowserRouter`, because it reads `useLocation()`. It lives behind
              `@charcuterie/ui/react-router`, an optional peer, so the base package stays
              router-free. */}
          <ReactRouterAdapter>
            <App />
          </ReactRouterAdapter>
        </BrowserRouter>
      </QueryProvider>
    </StrictMode>,
  )
}
