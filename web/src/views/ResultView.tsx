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
  type BoardGamePickSession,
  clearPickSession,
  type PickSession,
  type QueuePickSession,
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
  TonightPickResponse,
  TonightPickWire,
} from "../lib/types"
import { openPlayMenu } from "../state/overlays"
import { WATCH_PLAY_PATH } from "../state/route"
import { setStatus } from "../state/store"

/**
 * THE RESULT — one answer, and the two things you can do about it.
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
 * ## TWO KINDS OF ANSWER, and the difference is real (WP-7)
 *
 * A **board-game** session drew a GAME off the shelf: a box, a player count, a complexity, a
 * place to go and get it. A **queue** session drew a QUEUE for the evening — Movies, Shows,
 * Reading or Video Games — and the queue's own engine chooses the item when it starts. That
 * is why the queue card names what would come up next rather than claiming to have chosen it,
 * and why it has no Mark played: a queue records its own progress when it plays.
 *
 * The two share the evening (who is here, the reroll, the shortlist, the twelve-hour life) and
 * nothing else, so `session.kind` is a real discriminant and each card is its own component.
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
          kind: "board-game",
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

  /** Draw again, remembering everything already turned down. That memory is the durable half. */
  const reroll = async () => {
    if (!session) return
    setIsDrawing(true)
    try {
      const next =
        session.kind === "queue"
          ? await rerollQueue(session)
          : await rerollBoardGame(session)

      if (next) {
        setSession(next)
        setIsShortlistShown(false)
        writePickSession(next)
      }
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
    if (session?.kind !== "board-game") return
    const first = session.candidates[0]
    if (!first) return
    const answer = await api<BoardGameResponse>(
      "GET",
      `/api/board-games/${encodeURIComponent(first.game.id)}`,
    )
    setKnownHow(answer.knownHow ?? [])
  }

  const cards = cardsOf(session)
  const first = cards.first
  const rest = cards.rest

  return (
    <main className="view" hidden={isHidden} id="result">
      {error ? (
        <p className="subhint" role="alert">
          Could not read that: {error}
        </p>
      ) : isPending ? (
        <div className="cloading">
          <Spinner label="Reading your pick" />
        </div>
      ) : !first || !session ? (
        <section className="tsection" id="result-none">
          <EmptyState
            description="Nothing has been picked yet. Start a new pick from What to Watch/Play."
            headingLevel={2}
            heading="No pick to show"
          />
          <ButtonLink
            href={WATCH_PLAY_PATH}
            id="result-gotonight"
            intent="accent"
          >
            Go to What to Watch/Play
          </ButtonLink>
        </section>
      ) : (
        <>
          <section className="tsection" id="result-card">
            {session.kind === "queue" ? (
              <QueueCard
                idPrefix="result"
                pick={first as TonightPickWire}
              />
            ) : (
              <ResultCard
                activity={session.activity}
                candidate={first as PickCandidateWire}
                guestCount={session.guestCount}
                idPrefix="result"
                knownHow={knownHow}
                onLogged={refreshClaims}
                people={people}
                personIds={session.personIds}
              />
            )}
          </section>

          {/* The filters the form collected that no backend can act on yet. Said out loud on
              the answer rather than dropped, because a filter that quietly does nothing is
              worse than one that says it is waiting. */}
          {session.kind === "queue" &&
          session.notes.length > 0 ? (
            <section className="tsection" id="result-notes">
              {session.notes.map((note) => (
                <p className="subhint" key={note}>
                  {note}
                </p>
              ))}
            </section>
          ) : null}

          <section
            className="tsection tgo"
            id="result-actions"
          >
            {/* A QUEUE ARRIVAL HAS NO REROLL. The queue chose. */}
            {session.origin === "pick" ? (
              <Button
                id="result-reroll"
                isDisabled={isDrawing}
                onClick={() => void reroll()}
                size="lg"
              >
                Reroll
              </Button>
            ) : null}

            {session.origin === "pick" &&
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
              href={WATCH_PLAY_PATH}
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
              <h2 className="tlabel">
                {rest.length === 1
                  ? "The other one"
                  : "The other two"}
              </h2>
              <p className="subhint">
                Drawn with the first one, so looking at them
                cannot change it.
              </p>
              <ul className="bggrid">
                {session.kind === "queue"
                  ? (rest as TonightPickWire[]).map(
                      (pick) => (
                        <li key={pick.setId}>
                          <QueueCard
                            idPrefix={`shortlist-${pick.setId}`}
                            pick={pick}
                          />
                        </li>
                      ),
                    )
                  : (rest as PickCandidateWire[]).map(
                      (candidate) => (
                        <li key={candidate.game.id}>
                          <ResultCard
                            activity={session.activity}
                            candidate={candidate}
                            guestCount={session.guestCount}
                            idPrefix={`shortlist-${candidate.game.id}`}
                            knownHow={knownHow}
                            onLogged={refreshClaims}
                            people={people}
                            personIds={session.personIds}
                          />
                        </li>
                      ),
                    )}
              </ul>
            </section>
          ) : null}

          {/* Only for a pick. A queue arrival has nothing remembered to forget — the card
              came out of the URL, and a button offering to clear it would be lying. */}
          {session.origin === "pick" ? (
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
          ) : null}
        </>
      )}
    </main>
  )
}

/**
 * The first answer and the rest of the shortlist, whichever engine drew them.
 *
 * One function so the two branches cannot drift on what "the first one" means — the shortlist
 * control's label counts off `rest.length + 1` and would be wrong by one the moment they did.
 */
function cardsOf(session: PickSession | null): {
  first: PickCandidateWire | TonightPickWire | null
  rest: (PickCandidateWire | TonightPickWire)[]
} {
  if (!session) return { first: null, rest: [] }
  const all =
    session.kind === "queue"
      ? session.picks
      : session.candidates
  return { first: all[0] ?? null, rest: all.slice(1) }
}

/** Draw another game, remembering every one already turned down. */
async function rerollBoardGame(
  session: BoardGamePickSession,
): Promise<BoardGamePickSession | null> {
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

  if (answer.shortlist.length === 0) {
    // Nothing left that fits. The session stays as it was rather than being replaced by an
    // empty one — the card on screen is still the answer, and the reason is said out loud
    // instead of blanking the screen.
    setStatus(
      answer.result?.outcome === "empty"
        ? (answer.result.suggestion ??
            "Nothing else fits those choices.")
        : "Nothing else fits those choices.",
      "err",
    )
    return null
  }

  return {
    ...session,
    candidates: answer.shortlist,
    excludedGameIds: excluded,
    savedAt: new Date().toISOString(),
  }
}

/**
 * Draw another queue, remembering every one already turned down.
 *
 * `boundBackend` goes back with the request: one session talks to one backend, so a reroll on
 * a Steam evening draws another Steam queue rather than wandering onto the MiSTer.
 */
async function rerollQueue(
  session: QueuePickSession,
): Promise<QueuePickSession | null> {
  const excluded = [
    ...new Set([
      ...session.excludedSetIds,
      ...session.picks.map((pick) => pick.setId),
    ]),
  ]

  const answer = await api<TonightPickResponse>(
    "POST",
    "/api/tonight/pick",
    {
      activity: session.activity,
      boundBackend: session.backend,
      excludedSetIds: excluded,
      guestCount: session.guestCount,
      personIds: session.personIds,
    },
  )

  if (!answer.pick || answer.shortlist.length === 0) {
    setStatus(
      answer.reason ?? "Nothing else for those choices.",
      "err",
    )
    return null
  }

  return {
    ...session,
    backend: answer.backend ?? session.backend,
    excludedSetIds: excluded,
    notes: answer.notes ?? session.notes,
    picks: answer.shortlist,
    savedAt: new Date().toISOString(),
  }
}

/**
 * ONE QUEUE, as a card.
 *
 * What it says and what it deliberately does not:
 *
 *   - The **queue** is the answer. It is named, and the provider it runs on is a badge
 *     beside it — the one place a provider brand belongs on this surface.
 *   - **Up next** is what would come up, when that could be answered without starting
 *     anything. When it could not, the card says WHY in the same place, because a blank space
 *     where a title should be reads as a bug.
 *   - There is **no Mark played**. A queue records its own progress when it plays; a button
 *     here would be a second writer of the same fact.
 *
 * Go is the queue's own launch, and it is the same two shapes the shelf and the Tonight form
 * already use: a PULL queue is an anchor to `/go/<id>`, a PUSH queue opens the device menu.
 *
 * ⚠️ `.playbtn` is LOAD-BEARING and paints nothing — `PlayMenu`'s outside-click handler asks
 * `t.closest(".playbtn")`, so a control that opens that menu without the class opens a menu
 * that shuts on the same click.
 */
function QueueCard({
  idPrefix,
  pick,
}: {
  idPrefix: string
  pick: TonightPickWire
}) {
  return (
    <Card
      className="bgcard"
      heading={pick.setLabel}
      headingLevel={2}
      id={`${idPrefix}-queue`}
      padding="lg"
      surface="raised"
    >
      <div className="bgbadges">
        {pick.providerLabel ? (
          <Badge
            appearance="outline"
            intent="neutral"
            size="sm"
          >
            {pick.providerLabel}
          </Badge>
        ) : null}
        <Badge intent="neutral" size="sm">
          {pick.delivery === "pull"
            ? "Opens on the device you are holding"
            : "Sent to a device"}
        </Badge>
      </div>

      {pick.upNext ? (
        <p className="bgmeta" id={`${idPrefix}-upnext`}>
          Up next: {pick.upNext.title}
          {pick.upNext.detail
            ? ` · ${pick.upNext.detail}`
            : ""}
        </p>
      ) : (
        <p className="bgmeta" id={`${idPrefix}-upnext`}>
          {pick.upNextReason ??
            "This queue has not said what comes next."}
        </p>
      )}

      <p className="bgmeta">
        The queue chooses what plays when it starts.
      </p>

      <div className="bglinks">
        {pick.launchUrl ? (
          <ButtonLink
            href={pick.launchUrl}
            id={`${idPrefix}-go`}
            intent="accent"
            isExternal
            size="lg"
          >
            Start it
          </ButtonLink>
        ) : (
          <Button
            className="playbtn"
            id={`${idPrefix}-go`}
            intent="accent"
            onClick={(e) =>
              openPlayMenu({
                anchor:
                  e.currentTarget.getBoundingClientRect(),
                setId: pick.setId,
              })
            }
            size="lg"
          >
            Start it
          </Button>
        )}
      </div>
    </Card>
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
