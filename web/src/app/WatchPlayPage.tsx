import { useParams } from "react-router"
import { Page } from "../components/Page"
import { TonightView } from "../views/TonightView"

/** `/what-to-watch-play/<step>` — one view, two steps, and neither is a view of its own. */
export function WatchPlayPage() {
  const { step } = useParams()

  return (
    <Page
      back={{ label: "‹ QueuePilot", target: "/" }}
      // `queue-view` is what HIDES the Queues toolbar — the same reuse Pending makes of it.
      bodyClass="queue-view"
      documentTitle="What to Watch/Play — QueuePilot"
      editableSetId={null}
      heading="What to Watch/Play"
      isSubHidden={false}
      sub="Choose who is here, what you want to do, and what to start."
    >
      <TonightView step={watchPlayStep(step)} />
    </Page>
  )
}

/** Anything else in that segment is the bare form, which is what an unknown step deserves. */
function watchPlayStep(
  step: string | undefined,
): "go" | "surprise" | null {
  return step === "go" || step === "surprise" ? step : null
}
