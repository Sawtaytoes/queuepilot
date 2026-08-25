import {
  Badge,
  Button,
  ButtonLink,
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
  knownHowFor,
  playCountLabel,
  playerCountLine,
  playtimeLabel,
  weightLabel,
} from "../lib/boardGames"
import {
  clearPickSession,
  type PickSession,
  readPickSession,
  writePickSession,
} from "../lib/pickSession"
import { rosterOrder } from "../lib/tonight"
import type {
  BoardGameResponse,
  KnownHowClaim,
  PeopleResponse,
  Person,
  PickCandidateWire,
  PickResponse,
} from "../lib/types"
import { setStatus } from "../state/store"

/**
 * THE RESULT — one game, and the two things you can do about it.
 *
 * ## One card. Not three
 *
 * > "One card, shortlist behind a control."
 *
 * The screen shows ONE result: reroll if you do not like it, confirm if you do. A shortlist of
 * three sits behind **Show me three** and is never the default, because choosing is the thing
 * this app exists to reduce — three cards is the shelf again, smaller.
 *
 * The shortlist arrives WITH the first card rather than being fetched when the control is
 * tapped. A second request would re-draw, so the card already on screen could change under the
 * finger that asked to see more of them.
 *
 * ## A queue arrival has NO reroll
 *
 * `/result/<gameId>` is the card a queue hands you, and the queue already chose. A reroll
 * there would be offering to overrule it. Same card, same finish step, one control missing —
 * and that is a rule, not an omission.
 *
 * ## It survives leaving the screen
 *
 * The pick and reroll's memory are written to `localStorage` (`lib/pickSession.ts`). Walking
 * away from this screen used to lose both, so a reroll afterwards drew from the whole shelf
 * again and a specific title could take a very long time to resurface. The session expires
 * after twelve hours — a pick is for an evening.
 */
export function ResultView({
  gameId,
  isHidden,
}: {
  gameId: string | null
  isHidden: boolean
}) {
  const [session, setSession] =
    useState<PickSession | null>(null)
  const [people, setPeople] = useState<Person[]>([])
  const [knownHow, setKnownHow] = useState<KnownHowClaim[]>(
    [],
  )
  const [isShortlistShown, setIsShortlistShown] =
    useState(false)
  const [isDrawing, setIsDrawing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(true)

  useEffect(() => {
    if (isHidden) return

    let isCancelled = false
    setIsPending(true)
    setIsShortlistShown(false)

    const load = async () => {
      const roster = await api<PeopleResponse>(
        "GET",
        "/api/people",
      )
      if (isCancelled) return
      setPeople(rosterOrder(roster.people ?? []))

      // A queue arrival names its game in the URL, so there is nothing to remember and
      // nothing to re-draw. It reads the one title and stops.
      if (gameId) {
        const answer = await api<BoardGameResponse>(
          "GET",
          `/api/board-games/${encodeURIComponent(gameId)}`,
        )
        if (isCancelled) return
        setKnownHow(answer.knownHow ?? [])
        setSession({
          activity: "board-games",
          candidates: [
            {
              game: answer.game,
              playCount: answer.game.playCount,
              verdict: "unknown",
            },
          ],
          criteria: {
            excludedGameIds: [],
            fitness: "bestOrRecommended",
            maxWeight: null,
            personIds: [],
            playerCount: 1,
            rulesKnown: "any",
          },
          excludedGameIds: [],
          guestCount: 0,
          origin: "queue",
          personIds: [],
          savedAt: new Date().toISOString(),
        })
        return
      }

      setSession(readPickSession())
    }

    void load()
      .then(() => {
        if (!isCancelled) setError(null)
      })
      .catch((e: unknown) => {
        if (isCancelled) return
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!isCancelled) setIsPending(false)
      })

    return () => {
      isCancelled = true
    }
  }, [gameId, isHidden])

  /** Draw again, remembering every game already turned down. That memory is the durable half. */
  const reroll = async () => {
    if (!session) return
    setIsDrawing(true)
    try {
      const excluded = [
        ...new Set([
          ...session.excludedGameIds,
          ...session.candidates.map(
            (candidate) => candidate.game.id,
          ),
        ]),
      ]

      const answer = await api<PickResponse>(
        "POST",
        "/api/board-games/pick",
        { ...session.criteria, excludedGameIds: excluded },
      )

      const next: PickSession = {
        ...session,
        candidates: answer.shortlist,
        excludedGameIds: excluded,
        savedAt: new Date().toISOString(),
      }

      if (answer.shortlist.length === 0) {
        // Nothing left that fits. The session stays as it was rather than being replaced by
        // an empty one — the card on screen is still the answer, and the reason is said out
        // loud instead of blanking the screen.
        const reason =
          answer.result?.outcome === "empty"
            ? (answer.result.suggestion ??
              "Nothing else fits tonight.")
            : "Nothing else fits tonight."
        setStatus(reason, "err")
        return
      }

      setSession(next)
      setIsShortlistShown(false)
      writePickSession(next)
    } catch (e) {
      setStatus(
        `Could not reroll: ${(e as Error).message}`,
        "err",
      )
    } finally {
      setIsDrawing(false)
    }
  }

  const refreshClaims = async () => {
    const first = session?.candidates[0]
    if (!first) return
    const answer = await api<BoardGameResponse>(
      "GET",
      `/api/board-games/${encodeURIComponent(first.game.id)}`,
    )
    setKnownHow(answer.knownHow ?? [])
  }

  const first = session?.candidates[0] ?? null
  const rest = session?.candidates.slice(1) ?? []

  return (
    <main className="view" hidden={isHidden} id="result">
      {error ? (
        <p className="subhint" role="alert">
          Could not read that: {error}
        </p>
      ) : isPending ? (
        <div className="cloading">
          <Spinner label="Reading tonight's pick" />
        </div>
      ) : !first ? (
        <section className="tsection" id="result-none">
          <EmptyState
            description="Nothing has been picked tonight — or the last pick was long enough ago that it was somebody else's evening. Start one from Tonight."
            headingLevel={2}
            heading="No pick to show"
          />
          <ButtonLink
            href="/tonight"
            id="result-gotonight"
            intent="accent"
          >
            Go to Tonight
          </ButtonLink>
        </section>
      ) : (
        <>
          <section className="tsection" id="result-card">
            <ResultCard
              activity={session?.activity ?? "board-games"}
              candidate={first}
              guestCount={session?.guestCount ?? 0}
              idPrefix="result"
              knownHow={knownHow}
              onLogged={refreshClaims}
              people={people}
              personIds={session?.personIds ?? []}
            />
          </section>

          <section
            className="tsection tgo"
            id="result-actions"
          >
            {/* A QUEUE ARRIVAL HAS NO REROLL. The queue chose. */}
            {session?.origin === "pick" ? (
              <Button
                id="result-reroll"
                isDisabled={isDrawing}
                onClick={() => void reroll()}
                size="lg"
              >
                Reroll
              </Button>
            ) : null}

            {session?.origin === "pick" &&
            rest.length > 0 ? (
              <Button
                id="result-shortlist-toggle"
                onClick={() =>
                  setIsShortlistShown((prev) => !prev)
                }
                size="lg"
              >
                {isShortlistShown
                  ? "Just the one"
                  : `Show me ${rest.length + 1}`}
              </Button>
            ) : null}

            <ButtonLink
              href="/tonight"
              id="result-back"
              size="lg"
            >
              Change the answers
            </ButtonLink>
          </section>

          {isShortlistShown && rest.length > 0 ? (
            <section
              className="tsection"
              id="result-shortlist"
            >
              <h2 className="tlabel">The other two</h2>
              <p className="subhint">
                Drawn with the first one, so looking at them
                cannot change it.
              </p>
              <ul className="bggrid">
                {rest.map((candidate) => (
                  <li key={candidate.game.id}>
                    <ResultCard
                      activity={
                        session?.activity ?? "board-games"
                      }
                      candidate={candidate}
                      guestCount={session?.guestCount ?? 0}
                      idPrefix={`shortlist-${candidate.game.id}`}
                      knownHow={knownHow}
                      onLogged={refreshClaims}
                      people={people}
                      personIds={session?.personIds ?? []}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="tsection" id="result-clear">
            <Button
              id="result-forget"
              onClick={() => {
                clearPickSession()
                setSession(null)
              }}
              size="sm"
            >
              Forget this pick
            </Button>
          </section>
        </>
      )}
    </main>
  )
}

/** One candidate, as a card. The same shape whether it is the answer or one of the other two. */
function ResultCard({
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
