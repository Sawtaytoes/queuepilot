import { useParams } from "react-router"
import { Page } from "../components/Page"
import { WATCH_PLAY_PATH } from "../lib/routePaths"
import { ResultView } from "../views/ResultView"

export function ResultPage() {
  const { gameId } = useParams()

  return (
    <Page
      // BACK GOES TO WHAT TO WATCH/PLAY, not to the landing: this card is the end of that
      // form, and "change the answers" is the thing somebody wants next when the pick is
      // wrong.
      back={{
        label: "‹ What to Watch/Play",
        target: WATCH_PLAY_PATH,
      }}
      bodyClass="queue-view"
      documentTitle="Your pick — QueuePilot"
      editableSetId={null}
      heading="Your pick"
      isSubHidden={false}
      // WP-7: this card is now one of TWO answers — a game off the shelf, or a queue for the
      // evening — so the sentence says the half they share. It used to promise "say you
      // played it", which a queue card does not offer at all: a queue records its own
      // progress when it plays.
      sub="One answer. Reroll it, or start it."
    >
      <ResultView gameId={gameId ?? null} />
    </Page>
  )
}
