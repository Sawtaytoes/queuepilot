import { Badge, Card } from "@charcuterie/ui"
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
import type {
  BoardGameCard,
  KnownHowClaim,
  Person,
} from "../lib/types"

/**
 * One title on the shelf.
 *
 * A `Card` with the game's name as its heading, so each one is a named region — which is what
 * lets "the We played this button on Harbour Lantern" be a thing anybody, or any test, can
 * say without counting buttons down the page.
 */
export function GameCard({
  game,
  knownHow,
  onLogged,
  people,
}: {
  game: BoardGameCard
  knownHow: readonly KnownHowClaim[]
  onLogged: () => void
  people: readonly Person[]
}) {
  const known = knownHowFor(knownHow, game.id)
  const nameOf = (id: string) =>
    people.find((person) => person.id === id)
      ?.displayName ?? id
  const playtime = playtimeLabel(game)

  return (
    <Card
      className="bgcard"
      heading={game.name}
      headingLevel={3}
      id={`bg-${game.id}`}
      padding="md"
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
        <Badge intent="neutral" size="sm">
          {playCountLabel(game.playCount)}
        </Badge>
        {game.isExcluded ? (
          <Badge
            appearance="outline"
            intent="warning"
            size="sm"
          >
            Off the shelf
          </Badge>
        ) : null}
      </div>

      {/* The question the play log exists to answer, on the card. Silent when nobody has
          been recorded — which is what every historical play looks like. */}
      {game.playedBy.length > 0 ? (
        <p className="bgmeta" id={`bg-${game.id}-playedby`}>
          Played by {game.playedBy.map(nameOf).join(", ")}
        </p>
      ) : null}

      {known.length > 0 ? (
        <p className="bgmeta" id={`bg-${game.id}-knows`}>
          Knows the rules: {known.map(nameOf).join(", ")}
        </p>
      ) : null}

      <MarkPlayed
        activity="board-games"
        defaultPersonIds={[]}
        gameId={game.id}
        gameName={game.name}
        idPrefix={`bg-${game.id}`}
        knownHow={knownHow.filter(
          (claim) => claim.gameId === game.id,
        )}
        onLogged={onLogged}
        people={people}
      />
    </Card>
  )
}
