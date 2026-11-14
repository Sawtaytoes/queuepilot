import { usePageChrome } from "../components/Page"
import { ModeLandingView } from "../views/ModeLandingView"

/** The task-based front door: two starts, five management links, and no work-page shell. */
export function ModeLandingPage() {
  usePageChrome({
    bodyClass: "mode-view",
    documentTitle: "QueuePilot",
  })

  return <ModeLandingView />
}
