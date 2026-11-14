import { BadgeButton } from "@charcuterie/ui"
import { Tip } from "../components/Tip"

export function ExcludeButton({
  label,
  onExclude,
  title,
}: {
  label: string
  title: string
  onExclude: () => Promise<void>
}) {
  return (
    // Neutral at rest and red on hover — "quiet until you mean it". `intent="danger"`
    // would paint the resting chip red on every tile in the pool, which is a warning
    // about nothing; the hover half stays in `app.css` as a STATE, the same exception
    // `.b-remove` keeps.
    <Tip label={title}>
      <BadgeButton
        appearance="outline"
        className="exclude"
        intent="neutral"
        onClick={() => void onExclude()}
        size="sm"
      >
        {label}
      </BadgeButton>
    </Tip>
  )
}
