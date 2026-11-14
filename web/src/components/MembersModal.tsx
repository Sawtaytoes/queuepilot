import { Badge, Button } from "@charcuterie/ui"
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react"
import { useRowReorder } from "../hooks/useRowReorder"
import { api } from "../lib/api"
import { runtimeLabel, seLabel } from "../lib/tileFace"
import type {
  CollectionChild,
  EntryUnit,
  ProviderVocabulary,
  ShowEpisodes,
} from "../lib/types"
import { applyVocab, vocabForSet } from "../lib/vocab"
import {
  closeMembersModal,
  useOverlays,
} from "../state/overlays"
import {
  saveCollectionOrder,
  saveMemberSelection,
} from "../state/queueEntry"
import {
  fetchAll,
  setState,
  useStore,
} from "../state/store"
import {
  MemberListRow,
  type MemberRow,
} from "./MemberListRow"
import { Modal } from "./Modal"

/**
 * "What plays" — every item INSIDE one entry, with the ones this queue must never play
 * unticked.
 *
 * ## Why it exists
 *
 * `skipped` shipped as a tile-menu action that drops the one item the entry is ABOUT to
 * play, which answers "not tonight's episode" and nothing else. The owner hit the case it
 * cannot answer on 2026-08-26: a collection holding the same film three times, once per cut,
 * where the ask is "play this one, never those two". Through the tile menu that is three
 * round trips in a fixed order, each one waiting for the next-up to re-resolve, and the
 * Skipped panel then lists two rows with the identical title.
 *
 * So the list is the entry's whole inside, ticked = plays, and it SAVES AS ONE ANSWER. One
 * PATCH, one re-resolve, and the duplicate rows are told apart by the fields that actually
 * differ — the Plex edition and the runtime.
 *
 * ## What a row is
 *
 * A collection's rows are its MEMBERS (a film, or a whole member show — skipping one drops
 * it whole, which is what the engine already does with a skipped child). A show's rows are
 * its episodes, every season at once: the read-back has to see every row it is responsible
 * for, and a season picker would hide the ones it is about to save.
 *
 * A row with no id of its own carries no control — a provider that cannot name a leaf cannot
 * skip one either, and an inert checkbox is worse than none.
 *
 * ## Not a grid
 *
 * Rows, at every width. These are a title and a line of detail, which is a reading surface
 * and not a card (decision `2026-08-25-a-text-heavy-row-list-is-one-column`).
 */

const HINT =
  "Normal episodes play unless you untick them. Specials start unticked, and you can include only the ones you want. A skipped normal episode counts as dealt with."

/** A collection member's second line: the edition first, because that is the field two
 *  duplicate members differ by, then the runtime, then a show's progress. */
function memberDetail(
  child: CollectionChild,
  translate: (s: string) => string,
): string {
  const parts: string[] = []

  if (child.editionTitle) parts.push(child.editionTitle)
  if (child.year) parts.push(String(child.year))

  const runtime = runtimeLabel(child.duration)

  if (runtime) parts.push(runtime)

  if (child.type === "show" && child.leafCount) {
    parts.push(
      `${child.viewedLeafCount || 0}/${child.leafCount} ${translate("watched")}`,
    )
  }

  return parts.join(" · ")
}

function toMemberRows(
  children: CollectionChild[],
  translate: (s: string) => string,
): MemberRow[] {
  return children.map((child) => ({
    detail: memberDetail(child, translate),
    isDone:
      child.type === "show"
        ? Boolean(
            child.leafCount &&
              (child.viewedLeafCount || 0) >=
                child.leafCount,
          )
        : Boolean(child.watched),
    isSpecial: false,
    label: child.title,
    ratingKey: String(child.ratingKey),
    season: null,
  }))
}

function toEpisodeRows(
  data: ShowEpisodes,
  unit: EntryUnit,
  hasSpecials: boolean,
  plexServer: string | null = null,
): MemberRow[] {
  return data.seasons.flatMap((season) =>
    season.episodes.map((episode) => ({
      detail: episode.title || "",
      isDone: Boolean(episode.watched),
      isSpecial: hasSpecials && season.season === 0,
      label: seLabel(
        {
          episode: episode.episode,
          multiSeason: data.multiSeason,
          season: season.season,
        },
        unit,
      ),
      ratingKey: episode.ratingKey
        ? plexServer
          ? `server:${plexServer}:rk:${episode.ratingKey}`
          : String(episode.ratingKey)
        : null,
      season: data.multiSeason ? season.season : null,
    })),
  )
}

function unitOf(
  item: { unit?: EntryUnit } | null,
  vocab: ProviderVocabulary,
): EntryUnit {
  return (
    item?.unit ??
    (vocab.unit === "chapter" ? "chapter" : "episode")
  )
}

export function MembersModal() {
  const { membersModal: entry } = useOverlays()
  const { reg } = useStore()
  const vocab = vocabForSet(reg?.sets, entry?.setId)
  const translate = useCallback(
    (text: string) => applyVocab(text, vocab),
    [vocab],
  )
  const item = entry?.item ?? null
  const setId = entry?.setId ?? null
  const ratingKey = item?.ratingKey ?? null
  const isCollection = item?.type === "collection"
  const accountUuid = entry?.accountUuid
  const hasSpecials =
    reg?.sets.find((set) => set.id === setId)
      ?.provider_kind === "plex"

  const [rows, setRows] = useState<MemberRow[] | null>(null)
  const [plexRows, setPlexRows] = useState<MemberRow[]>([])
  const [collectionOrder, setCollectionOrder] = useState<
    string[]
  >([])
  const [note, setNote] = useState("")
  const [isSaving, setIsSaving] = useState(false)
  /**
   * The re-read against Plex that runs AFTER the cached rows paint. See `recheck` below for
   * why it is a second pass rather than the only one.
   *
   * `null` = not running and nothing to say. The two strings are what the chip prints, and
   * the chip is the point: the owner asked that a list which is about to correct itself SAY
   * so, rather than re-ordering under him with no warning.
   */
  const [recheck, setRecheck] = useState<
    "checking" | "updated" | null
  >(null)
  /** The keys this panel will write as skipped. Seeded from the set the moment the rows land,
   *  then owned by the user until Save. */
  const [skips, setSkips] = useState<Set<string>>(
    () => new Set(),
  )
  const [includedSpecials, setIncludedSpecials] = useState<
    Set<string>
  >(() => new Set())

  /**
   * The set's live `skipped` list, for the seeding below — a REF, not the value itself.
   *
   * Charcuterie's `Checkbox` is uncontrolled: `isChecked` seeds the first paint and the
   * `<input>` is the store from then on. So the seed has to be right in the SAME render the
   * rows first paint in — an effect that fills it afterwards leaves the boxes ticked while the
   * state behind them says skipped, which is exactly what the first cut of this panel did
   * (caught in `e2e/shot-member-list.ts`: two rows badged "Skipped" with the box still on).
   * A ref rather than a dependency keeps the seeding out of the load's dependency list, so an
   * SSE refresh landing mid-edit cannot re-tick a box the user just unticked.
   */
  const skippedRef = useRef<readonly string[]>([])
  const includedSpecialsRef = useRef<readonly string[]>([])
  const collectionOrderRef = useRef<readonly string[]>([])
  const listRef = useRef<HTMLUListElement>(null)

  skippedRef.current =
    entry?.memberDraft?.skipped ??
    reg?.sets.find((set) => set.id === setId)?.skipped ??
    []
  includedSpecialsRef.current =
    entry?.memberDraft?.includedSpecials ??
    reg?.sets.find((set) => set.id === setId)
      ?.included_specials ??
    []
  collectionOrderRef.current = collectionOrder

  const reorderCollection = useCallback(
    (order: string[]) => {
      setRows((current) => {
        if (!current) return current
        const byKey = new Map(
          current
            .filter((row) => row.ratingKey)
            .map((row) => [row.ratingKey as string, row]),
        )
        const ordered = order
          .map((key) => byKey.get(key))
          .filter((row): row is MemberRow => Boolean(row))
        const unnamed = current.filter(
          (row) => !row.ratingKey,
        )
        const next = [...ordered, ...unnamed]

        setCollectionOrder(order)
        return next
      })
    },
    [],
  )

  useRowReorder(listRef, reorderCollection, isCollection)

  const applyCollectionOrder = useCallback(
    (source: MemberRow[], order: readonly string[]) => {
      if (!order.length) return source
      const rank = new Map(
        order.map((key, index) => [key, index]),
      )
      return source
        .map((row, plexIndex) => ({
          row,
          plexIndex,
          rank: row.ratingKey
            ? rank.get(row.ratingKey)
            : undefined,
        }))
        .sort(
          (left, right) =>
            (left.rank ?? order.length + left.plexIndex) -
            (right.rank ?? order.length + right.plexIndex),
        )
        .map(({ row }) => row)
    },
    [],
  )

  /**
   * Load one entry's rows. Only the five keys the effect below passes start a load: `item`,
   * `vocab` and the entry's draft are read for the unit, the wording and the stored order,
   * and all three are stable for as long as one entry's panel is open — the load is keyed on
   * WHICH entry, not on a fresh object identity arriving from an unrelated store refresh.
   */
  const loadMembers = useEffectEvent(
    ({
      accountUuid,
      hasSpecials,
      isCollection,
      ratingKey,
      setId,
    }: {
      accountUuid: string | null | undefined
      hasSpecials: boolean
      isCollection: boolean
      ratingKey: string
      setId: string | null
    }) => {
      let isStale = false

      setRows(null)
      setPlexRows([])
      const storedOrder = entry?.memberDraft
        ? entry.memberDraft.collectionOrder
        : isCollection && item && "collectionOrder" in item
          ? item.collectionOrder || []
          : []
      collectionOrderRef.current = storedOrder
      setCollectionOrder(storedOrder)
      setNote("")
      setRecheck(null)

      const qs = [
        setId ? `set=${encodeURIComponent(setId)}` : "",
        !isCollection ? "specials=choices" : "",
        accountUuid
          ? `uuid=${encodeURIComponent(accountUuid)}`
          : "",
        item && "plexServer" in item && item.plexServer
          ? `plex_server=${encodeURIComponent(item.plexServer)}`
          : "",
      ]
        .filter(Boolean)
        .join("&")
      const querySuffix = qs ? `?${qs}` : ""

      const load = async () => {
        if (isCollection) {
          const res = await api<{
            children: CollectionChild[]
          }>(
            "GET",
            `/api/collection/${ratingKey}/children${querySuffix}`,
          )

          return toMemberRows(res.children || [], translate)
        }

        const res = await api<ShowEpisodes>(
          "GET",
          `/api/show/${ratingKey}/episodes${querySuffix}`,
        )

        return toEpisodeRows(
          res,
          unitOf(item, vocab),
          hasSpecials,
          item && "plexServer" in item
            ? (item.plexServer ?? null)
            : null,
        )
      }

      /**
       * Pass 2, collections only: ask Plex again, with the cache row thrown away first.
       *
       * A collection's member order is Plex's own (`collectionSort`), and re-ordering one
       * moves nothing the derived cache can validate against — no timestamp, no count, no
       * member. So the cached copy can be wrong for up to its 24 h TTL, which is what the
       * owner hit: he put a fanedit first in Plex and the app kept the old order
       * (decision `2026-08-26-a-collection-re-order-is-invisible-so-the-panel-re-reads`).
       *
       * It runs after pass 1 has painted rather than instead of it: opening the panel must
       * not wait on a Plex round trip, and the correction is worth about a second when it
       * lands. A failure here is SILENT — pass 1's rows are the ones already on screen and
       * still the best answer available.
       */
      const recheckAgainstPlex = async () => {
        if (!isCollection) return

        setRecheck("checking")

        try {
          const res = await api<{
            children: CollectionChild[]
            isChanged?: boolean
          }>(
            "GET",
            `/api/collection/${ratingKey}/children${querySuffix ? `${querySuffix}&` : "?"}fresh=1`,
          )

          if (isStale) return

          const next = toMemberRows(
            res.children || [],
            translate,
          )
          const owned = new Set(
            next
              .map((row) => row.ratingKey)
              .filter((key): key is string => Boolean(key)),
          )

          setPlexRows(next)
          setRows(
            applyCollectionOrder(
              next,
              collectionOrderRef.current,
            ),
          )
          // The user's own ticks OUTRANK the seed on this pass — they may have been editing
          // while it was in flight. Only keys the re-read dropped leave the set; a member Plex
          // has since ADDED seeds from the set's stored list, exactly as pass 1 does.
          setSkips((prev) => {
            const kept = [...prev].filter((key) =>
              owned.has(key),
            )
            const added = skippedRef.current.filter(
              (key) => owned.has(key) && !prev.has(key),
            )

            return new Set([...kept, ...added])
          })
          setRecheck(res.isChanged ? "updated" : null)

          // The grid behind this panel names the next member BY POSITION, so a re-order makes
          // its tile wrong too. The server bumped the cache generation for the same reason;
          // this is the open page acting on it.
          if (res.isChanged) {
            const [data, reg] = await fetchAll()

            if (!isStale) setState({ data, reg })
          }
        } catch {
          if (!isStale) setRecheck(null)
        }
      }

      void load()
        .then((next) => {
          if (isStale) return

          // Both in one commit: the rows and which of them are already skipped. See the note
          // on `skippedRef` — the boxes read their seed on the render the rows arrive in.
          const owned = new Set(
            next
              .map((row) => row.ratingKey)
              .filter((key): key is string => Boolean(key)),
          )

          setPlexRows(next)
          setRows(applyCollectionOrder(next, storedOrder))
          setSkips(
            new Set(
              skippedRef.current.filter((key) =>
                owned.has(key),
              ),
            ),
          )
          setIncludedSpecials(
            new Set(
              includedSpecialsRef.current.filter((key) =>
                owned.has(key),
              ),
            ),
          )

          return recheckAgainstPlex()
        })
        .catch((error: Error) => {
          if (isStale) return

          setRows([])
          setNote(
            `Could not read what is inside this entry: ${error.message}`,
          )
        })

      return () => {
        isStale = true
      }
    },
  )

  useEffect(() => {
    if (!ratingKey) return

    return loadMembers({
      accountUuid,
      hasSpecials,
      isCollection,
      ratingKey,
      setId,
    })
  }, [
    accountUuid,
    hasSpecials,
    isCollection,
    ratingKey,
    setId,
  ])

  // What re-seeds a box from outside the user's own clicks: a different entry, or this
  // entry's rows arriving. Never `skips` itself, which changes on their click and would
  // remount the control under their finger
  // (decision `2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer`).
  const seedKey = `${setId}:${ratingKey}:${rows?.length ?? "loading"}`

  if (!entry || !item) return null

  const managed = (rows || [])
    .map((row) => row.ratingKey)
    .filter((key): key is string => Boolean(key))
  const managedSpecials = (rows || [])
    .filter((row) => row.isSpecial)
    .map((row) => row.ratingKey)
    .filter((key): key is string => Boolean(key))
  const specialKeys = new Set(managedSpecials)
  const managedNormal = managed.filter(
    (key) => !specialKeys.has(key),
  )
  const skippedNormal = managedNormal.filter((key) =>
    skips.has(key),
  ).length
  const playing =
    managedNormal.length -
    skippedNormal +
    managedSpecials.filter((key) =>
      includedSpecials.has(key),
    ).length
  const unitWord = isCollection
    ? managed.length === 1
      ? "item"
      : "items"
    : translate(
        managed.length === 1 ? "episode" : "episodes",
      )

  const onSave = () => {
    if (isSaving || !rows) return

    setIsSaving(true)
    void (async () => {
      if (entry.saveMembers) {
        await entry.saveMembers({
          collectionOrder,
          includedSpecials: [...includedSpecials],
          managed,
          managedSpecials,
          skipped: [...skips],
        })
        setIsSaving(false)
        closeMembersModal()
        return
      }
      const isSelectionOk = await saveMemberSelection(
        setId,
        {
          includedSpecials,
          // Own every row here so a special skipped under the legacy all-specials switch loses
          // that old exclusion when it moves to the explicit inclusion model.
          managed,
          managedSpecials,
          skipped: skips,
        },
      )
      if (!isSelectionOk) {
        setIsSaving(false)
        return
      }
      const isOrderOk =
        !isCollection ||
        !("key" in item) ||
        (await saveCollectionOrder(
          setId,
          item,
          collectionOrder,
        ))
      setIsSaving(false)
      if (isOrderOk) {
        const [data, reg] = await fetchAll()
        setState({ data, reg })
        closeMembersModal()
      }
    })().catch(() => setIsSaving(false))
  }

  return (
    <Modal
      footer={
        <>
          <Button
            appearance="outline"
            intent="neutral"
            onClick={closeMembersModal}
          >
            Cancel
          </Button>
          <Button
            intent="accent"
            isDisabled={isSaving || !rows}
            type="submit"
          >
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </>
      }
      // The sheet wears the queue's provider colour, like every other surface under
      // `#queue` — it is portalled to `document.body`, so it cannot inherit the
      // `data-provider` the view sets and has to be told.
      dataProvider={
        reg?.sets.find((set) => set.id === setId)
          ?.provider_kind || undefined
      }
      id="membersmodal"
      isOpen
      onClose={closeMembersModal}
      onSubmit={onSave}
      title={
        entry.saveMembers
          ? `Configure “${item.title}” — what plays`
          : `What plays in “${item.title}”`
      }
      titleId="membersmodal-title"
    >
      <p className="subhint">{translate(HINT)}</p>

      {rows === null ? (
        <p className="idnote">Loading…</p>
      ) : null}

      {rows?.length ? (
        <>
          <p className="memberscount">
            {playing} of {managed.length} {unitWord} play
            {playing === 1 ? "s" : ""}
            {recheck ? (
              <Badge
                intent={
                  recheck === "updated"
                    ? "accent"
                    : "neutral"
                }
                size="sm"
              >
                {recheck === "updated"
                  ? "Updated from Plex"
                  : "Checking Plex…"}
              </Badge>
            ) : null}
          </p>
          {isCollection ? (
            <div className="collectionorderbar">
              <span>
                {collectionOrder.length
                  ? "Custom order"
                  : "Plex order"}
              </span>
              <Button
                appearance="outline"
                intent="neutral"
                isDisabled={!collectionOrder.length}
                onClick={() => {
                  setCollectionOrder([])
                  setRows(plexRows)
                }}
                size="sm"
                type="button"
              >
                Reset to Plex order
              </Button>
            </div>
          ) : null}
          <ul
            className="memberlist"
            id="memberlist"
            ref={listRef}
          >
            {rows.map((row, index) => (
              <MemberListRow
                key={row.ratingKey || `row-${index}`}
                onToggle={(isPlaying) => {
                  const key = row.ratingKey

                  if (!key) return

                  if (row.isSpecial) {
                    setIncludedSpecials((prev) => {
                      const next = new Set(prev)

                      if (isPlaying) next.add(key)
                      else next.delete(key)

                      return next
                    })
                  } else {
                    setSkips((prev) => {
                      const next = new Set(prev)

                      if (isPlaying) next.delete(key)
                      else next.add(key)

                      return next
                    })
                  }
                }}
                previous={rows[index - 1] ?? null}
                row={row}
                position={index + 1}
                isCollection={isCollection}
                onMove={
                  isCollection && row.ratingKey
                    ? (offset) => {
                        const next = [...rows]
                        const nextIndex = index + offset
                        if (
                          nextIndex < 0 ||
                          nextIndex >= next.length
                        )
                          return
                        const [moved] = next.splice(
                          index,
                          1,
                        )
                        if (!moved) return
                        next.splice(nextIndex, 0, moved)
                        reorderCollection(
                          next
                            .map(
                              (member) => member.ratingKey,
                            )
                            .filter((key): key is string =>
                              Boolean(key),
                            ),
                        )
                      }
                    : undefined
                }
                seedKey={seedKey}
                t={translate}
                isSkipped={Boolean(
                  row.ratingKey &&
                    (row.isSpecial
                      ? !includedSpecials.has(row.ratingKey)
                      : skips.has(row.ratingKey)),
                )}
              />
            ))}
          </ul>
        </>
      ) : null}

      {rows && !rows.length && !note ? (
        <p className="idnote">
          {translate(
            "Nothing inside this entry to choose from.",
          )}
        </p>
      ) : null}

      <p className="idnote" id="members-note">
        {note}
      </p>
    </Modal>
  )
}
