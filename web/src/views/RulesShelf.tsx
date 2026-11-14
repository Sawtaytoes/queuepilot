import { getCategoricalIndex } from "@charcuterie/tokens"
import {
  Badge,
  Card,
  EmptyState,
  IconButton,
  Spinner,
} from "@charcuterie/ui"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { Link } from "react-router"
import { PeopleRow } from "../components/PeopleRow"
import { PosterTile } from "../components/PosterTile"
import { SeasonMark } from "../components/SeasonMark"
import { Tip } from "../components/Tip"
import { api } from "../lib/api"
import { activeBinding } from "../lib/channels"
import type {
  GroupWithRoster,
  Person,
  PreviewResponse,
  QueueMember,
  RegistrySet,
} from "../lib/types"
import { openDynModal } from "../state/overlays"
import { setStatus } from "../state/store"
import { ChevronDownIcon } from "./ChevronDownIcon"
import { SettingsIcon } from "./SettingsIcon"
import { shelfMatches } from "./shelfMatches"

type RulesPreviewItem = {
  cover?: string | null
  count?: number
  key: string
  ratingKey: string
  title: string
}

/**
 * A Rules queue uses the same collapsible shelf shape as a Picks queue. Its posters are a
 * read-only preview of the eligible titles: they can be opened, but they are not stored
 * entries and therefore never receive drag, lane, remove, or add controls.
 */
export function RulesShelf({
  channel,
  filter,
  groups,
  isCollapsed,
  onToggle,
  members,
  people,
  title,
}: {
  channel: RegistrySet
  filter: string
  groups: readonly GroupWithRoster[]
  isCollapsed: boolean
  onToggle: () => void
  members: readonly QueueMember[]
  people: readonly Person[]
  /** `queueTitle`'s answer — the Picks shelves and the native TV catalog say the same. */
  title: string
}) {
  const [items, setItems] = useState<
    RulesPreviewItem[] | null
  >(null)
  const [isLoading, setIsLoading] = useState(false)
  const stripRef = useRef<HTMLUListElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const leftRef = useRef<HTMLButtonElement>(null)
  const rightRef = useRef<HTMLButtonElement>(null)

  const updateArrows = useCallback(() => {
    const strip = stripRef.current
    const wrap = wrapRef.current

    if (!strip || !wrap) return

    const hasMoreLeft = strip.scrollLeft > 2
    const hasMoreRight =
      strip.scrollLeft <
      strip.scrollWidth - strip.clientWidth - 2

    if (leftRef.current)
      leftRef.current.hidden = !hasMoreLeft
    if (rightRef.current)
      rightRef.current.hidden = !hasMoreRight
    wrap.classList.toggle("more-left", hasMoreLeft)
    wrap.classList.toggle("more-right", hasMoreRight)
  }, [])

  useLayoutEffect(() => {
    requestAnimationFrame(updateArrows)
  })

  useEffect(() => {
    window.addEventListener("resize", updateArrows)

    return () =>
      window.removeEventListener("resize", updateArrows)
  }, [updateArrows])

  useEffect(() => {
    if (isCollapsed || items !== null) return

    let isCancelled = false
    const run = async () => {
      setIsLoading(true)

      try {
        const qs = new URLSearchParams()

        if (channel.has_explicit_profiles) {
          const profile =
            activeBinding(channel, null).plex_user || ""

          if (profile) qs.set("profile", profile)
        }

        const query = qs.toString()
        const preview = await api<PreviewResponse>(
          "GET",
          `/api/generic/${channel.id}/preview${query ? `?${query}` : ""}`,
        )

        if (isCancelled) return
        if (preview.error) throw new Error(preview.error)

        const next: RulesPreviewItem[] = []

        for (const bucket of preview.buckets ?? []) {
          if (bucket.items) {
            for (const item of bucket.items) {
              next.push({
                key: `${bucket.ratingKey}:${item.ratingKey}`,
                ratingKey: item.ratingKey,
                title: item.title,
              })
            }
          } else {
            next.push({
              count: bucket.unwatched,
              cover: bucket.cover,
              key: String(bucket.ratingKey),
              ratingKey: String(bucket.ratingKey),
              title: bucket.show,
            })
          }
        }

        for (const movie of preview.movie_pool ?? []) {
          next.push({
            count: movie.count,
            key: `movie:${movie.ratingKey}`,
            ratingKey: movie.ratingKey,
            title: movie.title,
          })
        }

        setItems(next)
      } catch (error) {
        if (!isCancelled) {
          setStatus(
            `Preview failed: ${(error as Error).message}`,
            "err",
          )
        }
      } finally {
        if (!isCancelled) setIsLoading(false)
      }
    }

    void run()

    return () => {
      isCancelled = true
    }
  }, [channel, isCollapsed, items])

  const isHiddenByFilter = !shelfMatches(
    filter,
    [title, channel.label],
    items ?? [],
  )

  return (
    <Card
      accentEdge={{
        categorical: getCategoricalIndex(channel.id),
      }}
      className={`shelf rules-shelf${isCollapsed ? " collapsed" : ""}`}
      data-provider={channel.provider_kind || undefined}
      data-set={channel.id}
      footer={
        <div className="queue-card-meta">
          <Badge
            appearance="soft"
            intent="neutral"
            size="sm"
          >
            Rules
          </Badge>
          <span className="lanes-sec">Eligible titles</span>
          <span className="shelfactions">
            <Tip label="Edit queue">
              <IconButton
                appearance="ghost"
                className="shelfedit"
                intent="neutral"
                label="Edit queue"
                onClick={() => openDynModal(channel.id)}
                size="sm"
              >
                <SettingsIcon />
              </IconButton>
            </Tip>
          </span>
        </div>
      }
      hidden={isHiddenByFilter}
      aria-label={title}
    >
      <h2>
        <IconButton
          appearance="ghost"
          className="collapse-toggle"
          intent="neutral"
          aria-expanded={!isCollapsed}
          label={
            isCollapsed ? "Preview queue" : "Collapse queue"
          }
          onClick={onToggle}
          size="sm"
        >
          <ChevronDownIcon />
        </IconButton>
        <Link
          className="open"
          to={`/channels/${encodeURIComponent(channel.id)}`}
        >
          <span className="lbl">{title}</span>
          {items ? (
            <span className="sec">{items.length}</span>
          ) : null}
        </Link>
        <SeasonMark set={channel} />
        <PeopleRow
          groups={groups}
          members={members}
          people={people}
        />
      </h2>

      <div className="strip-wrap" ref={wrapRef}>
        <button
          aria-label="scroll left"
          className="scroll left"
          onClick={() =>
            stripRef.current?.scrollBy({
              left: -stripRef.current.clientWidth * 0.85,
            })
          }
          ref={leftRef}
          type="button"
        >
          ‹
        </button>
        <ul
          aria-busy={isLoading || undefined}
          className="strip"
          onScroll={updateArrows}
          ref={stripRef}
        >
          {isLoading ? (
            <li className="empty">
              <Spinner
                label="Loading eligible titles…"
                size="sm"
              />
            </li>
          ) : items?.length ? (
            items.map((item) => (
              <PosterTile
                badges={
                  item.count != null ? (
                    <Badge
                      appearance="outline"
                      className="badge show"
                      intent="neutral"
                      size="sm"
                    >
                      {channel.behavior === "rewatch"
                        ? `${item.count} watches`
                        : `${item.count} unwatched`}
                    </Badge>
                  ) : null
                }
                dataKey={item.key}
                key={item.key}
                posterCover={item.cover}
                posterRatingKey={item.ratingKey}
                title={item.title}
              />
            ))
          ) : (
            <li className="empty">
              <EmptyState
                description="No titles match this queue's eligibility filters."
                heading="No eligible titles"
                headingLevel={3}
                size="sm"
              />
            </li>
          )}
        </ul>
        <button
          aria-label="scroll right"
          className="scroll right"
          onClick={() =>
            stripRef.current?.scrollBy({
              left: stripRef.current.clientWidth * 0.85,
            })
          }
          ref={rightRef}
          type="button"
        >
          ›
        </button>
      </div>
    </Card>
  )
}
