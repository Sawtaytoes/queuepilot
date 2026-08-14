import { QueryProvider } from "@charcuterie/logic/query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import { queryClient } from "./lib/queryClient"
import "./styles/app.css"

const rootElement = document.getElementById("root")

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <QueryProvider client={queryClient}>
        <App />
      </QueryProvider>
    </StrictMode>,
  )
}
