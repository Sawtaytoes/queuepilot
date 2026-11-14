import { Badge, ButtonLink, Card } from "@charcuterie/ui"
import { MarkPlayed } from "../components/MarkPlayed"
import { Poster } from "../components/Poster"
import {
  boxArtUrl,
  knownHowFor,
  playCountLabel,
  playerCountLine,
  playtimeLabel,
  weightLabel,
} from "../lib/boardGames"
import type { PickSession } from "../lib/pickSession"
import type {
  KnownHowClaim,
  Person,
  PickCandidateWire,
} from "../lib/types"

/** One candidate, as a card. The same shape whether it is the answer or one of the other two. */
export function ResultCard({
  activity,
  candidate,
  guestCount,
  idPrefix,
  knownHow,
  onLogged,
  people,
  personIds,
}: {
  activity: PickSession["activity"]
  candidate: PickCandidateWire
  guestCount: number
  idPrefix: string
  knownHow: readonly KnownHowClaim[]
  onLogged: () => Promise<void>
  people: readonly Person[]
  personIds: readonly string[]
}) {
  const { game } = candidate
  const known = knownHowFor(knownHow, game.id)
  const nameOf = (id: string) =>
    people.find((person) => person.id === id)
      ?.displayName ?? id
  const playtime = playtimeLabel(game)
  const box =
    game.boxes.find((one) => one.kind === "standalone") ??
    game.boxes[0]

  return (
    <Card
      className="bgcard"
      heading={game.name}
      headingLevel={2}
      id={`${idPrefix}-game`}
      padding="lg"
      surface="raised"
    >
      <div className="bgart">
        <Poster
          className="bgartimg"
          cover={boxArtUrl(game.imagePath)}
          fallback={
            <span className="bgartnone">
              No box photo yet
            </span>
          }
        />
      </div>

      <p className="bgmeta">{playerCountLine(game)}</p>
      <p className="bgmeta">
        {[weightLabel(game.weight), playtime]
          .filter(Boolean)
          .join(" · ")}
      </p>

      <div className="bgbadges">
        {candidate.verdict === "best" ? (
          <Badge intent="success" size="sm">
            Best at this count
          </Badge>
        ) : candidate.verdict === "recommended" ? (
          <Badge intent="neutral" size="sm">
            Plays well at this count
          </Badge>
        ) : null}
        <Badge intent="neutral" size="sm">
          {playCountLabel(game.playCount)}
        </Badge>
      </div>

      {/* Where to go and get it. The one thing a card at a shelf is actually for. */}
      {box?.locationText ? (
        <p className="bgmeta" id={`${idPrefix}-where`}>
          {box.label} — {box.locationText}
        </p>
      ) : null}

      {game.links.length > 0 ? (
        <div className="bglinks">
          {game.links.map((link) => (
            <ButtonLink
              href={link.url}
              isExternal
              key={link.id}
              size="sm"
            >
              {link.label}
            </ButtonLink>
          ))}
        </div>
      ) : null}

      {known.length > 0 ? (
        <p className="bgmeta" id={`${idPrefix}-knows`}>
          Knows the rules: {known.map(nameOf).join(", ")}
        </p>
      ) : null}

      <MarkPlayed
        activity={activity}
        defaultPersonIds={personIds}
        gameId={game.id}
        gameName={game.name}
        guestCount={guestCount}
        idPrefix={idPrefix}
        knownHow={knownHow.filter(
          (claim) => claim.gameId === game.id,
        )}
        onLogged={onLogged}
        people={people}
      />
    </Card>
  )
}
