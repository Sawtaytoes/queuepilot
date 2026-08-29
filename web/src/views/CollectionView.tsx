import {
  Badge,
  Button,
  Card,
  EmptyState,
  Spinner,
} from "@charcuterie/ui"
import { useEffect, useState } from "react"

import { MarkPlayed } from "../components/MarkPlayed"
import { Poster } from "../components/Poster"
import { api } from "../lib/api"
import {
  boxArtUrl,
  filterCollection,
  knownHowFor,
  playCountLabel,
  playerCountLine,
  playtimeLabel,
  weightLabel,
} from "../lib/boardGames"
import { rosterOrder } from "../lib/tonight"
import type {
  BoardGameCard,
  BoardGamesResponse,
  KnownHowClaim,
  PeopleResponse,
  Person,
} from "../lib/types"

/**
 * THE COLLECTION — the shelf, and the place to say a game was played when nobody asked the
 * app first.
 *
 * ## Why this screen exists
 *
 * > "I'd like to be able to go to the Collection screen (if I forget), and mark a game played
 * > for the night."
 *
 * Two things, and the second is the one that makes it more than a convenience. Tonight's pick
 * used to live in component state with nothing behind it, so leaving the screen lost the card
 * and there was no way back to "we played that one". This screen does not care how the game
 * was chosen or how long ago, so it routes around that failure entirely — and it stays the
 * right answer even now that the pick is durable, because most evenings nobody opens the
 * picker at all.
 *
 * ## A GRID, never a column of rows
 *
 * The column count comes from THIS container's width, not the window's, so the same list is
 * one column in the Narrow View and five on a wide monitor. A hundred-odd forty-character
 * titles down the left of a 2560px window is what this rule exists to stop.
 *
 * ## What it does when there are no people
 *
 * It still works, and it says why. The roster arrives through an owner-confirmed mapping file
 * and nothing may run that import on his behalf, so an empty `people` table is a normal state
 * here rather than a fault. A play logged with nobody named is a real answer that the log
 * stores as it is given — what is NOT allowed is logging one that quietly means nobody while
 * looking like it means everybody, which is the defect this whole package is about.
 */
export function CollectionView() {
  const [games, setGames] = useState<
    BoardGameCard[] | null
  >(null)
  const [knownHow, setKnownHow] = useState<KnownHowClaim[]>(
    [],
  )
  const [people, setPeople] = useState<Person[]>([])
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [isExcludedShown, setIsExcludedShown] =
    useState(false)
  const [reloadCount, setReloadCount] = useState(0)

  // Loaded on mount, which is when this page is opened: the route table mounts a view only
  // on its own route, so no other page pays for the whole shelf.
  useEffect(() => {
    let isCancelled = false

    void Promise.all([
      api<BoardGamesResponse>("GET", "/api/board-games"),
      api<PeopleResponse>("GET", "/api/people"),
    ])
      .then(([collection, roster]) => {
        if (isCancelled) return
        setGames(collection.games ?? [])
        setKnownHow(collection.knownHow ?? [])
        setPeople(rosterOrder(roster.people ?? []))
        setError(null)
      })
      .catch((e: unknown) => {
        if (isCancelled) return
        setGames([])
        setError(e instanceof Error ? e.message : String(e))
      })

    return () => {
      isCancelled = true
    }
  }, [reloadCount])

  const shelf = filterCollection(games ?? [], {
    isExcludedShown,
    query,
  })

  return (
    <div className="view" id="collection">
      <section className="tsection" id="collection-find">
        <h2 className="tlabel">The collection</h2>
        <p className="subhint">
          Every title on the shelf. Mark one played and it
          records who was at the table — that is the whole
          point of the log.
        </p>

        <div className="cfind">
          <label
            className="cfindlbl"
            htmlFor="collection-search"
          >
            <span className="tfilterlbl">Find a game</span>
            <input
              autoComplete="off"
              className="cfindbox"
              id="collection-search"
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type part of a name"
              type="search"
              value={query}
            />
          </label>
          <Button
            id="collection-excluded"
            onClick={() =>
              setIsExcludedShown((prev) => !prev)
            }
            size="sm"
          >
            {isExcludedShown
              ? "Hide the ones taken off the shelf"
              : "Show the ones taken off the shelf"}
          </Button>
        </div>
      </section>

      <section className="tsection" id="collection-shelf">
        {error ? (
          <p className="subhint" role="alert">
            Could not read the collection: {error}
          </p>
        ) : games === null ? (
          <div className="cloading">
            <Spinner label="Reading the shelf" />
          </div>
        ) : shelf.length === 0 ? (
          <EmptyState
            description={
              query
                ? `Nothing on the shelf matches “${query}”.`
                : "There is no board-game collection here yet. It arrives with the absorb."
            }
            headingLevel={3}
            heading="Nothing here"
            size="sm"
          />
        ) : (
          <ul className="bggrid" id="collection-grid">
            {shelf.map((game) => (
              <li key={game.id}>
                <GameCard
                  game={game}
                  knownHow={knownHow}
                  onLogged={() =>
                    setReloadCount((n) => n + 1)
                  }
                  people={people}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/**
 * One title on the shelf.
 *
 * A `Card` with the game's name as its heading, so each one is a named region — which is what
 * lets "the We played this button on Harbour Lantern" be a thing anybody, or any test, can
 * say without counting buttons down the page.
 */
function GameCard({
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
