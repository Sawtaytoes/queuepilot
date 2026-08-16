import { QueryProvider } from "@charcuterie/logic/query"
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
            and the two have to stay in step or a reload on `/queues` 404s. */}
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryProvider>
    </StrictMode>,
  )
}
