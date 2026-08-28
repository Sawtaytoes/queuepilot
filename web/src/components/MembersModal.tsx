import { Badge, Button, Checkbox } from "@charcuterie/ui"
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"

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
import { saveMemberSelection } from "../state/queueEntry"
import {
  fetchAll,
  setState,
  useStore,
} from "../state/store"
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

/** One row, whatever it came from — a collection member or an episode. */
type MemberRow = {
  /** The leaf key, or null when the provider names none (no control on that row). */
  ratingKey: string | null
  label: string
  /** The second line: the edition, the runtime, how far through it you are. */
  detail: string
  /** Fully watched / read — a chip, not a word buried in `detail`. */
  isDone: boolean
  /** Season 0: absent from playback until its leaf id is explicitly included. */
  isSpecial: boolean
  /** The season this row sits in, for the group headings. Null on a collection member. */
  season: number | null
}

const HINT =
  "Normal episodes play unless you untick them. Specials start unticked, and you can include only the ones you want. A skipped normal episode counts as dealt with."

/** A collection member's second line: the edition first, because that is the field two
 *  duplicate members differ by, then the runtime, then a show's progress. */
function memberDetail(
  child: CollectionChild,
  t: (s: string) => string,
): string {
  const parts: string[] = []

  if (child.editionTitle) parts.push(child.editionTitle)
  if (child.year) parts.push(String(child.year))

  const runtime = runtimeLabel(child.duration)

  if (runtime) parts.push(runtime)

  if (child.type === "show" && child.leafCount) {
    parts.push(
      `${child.viewedLeafCount || 0}/${child.leafCount} ${t("watched")}`,
    )
  }

  return parts.join(" · ")
}

function toMemberRows(
  children: CollectionChild[],
  t: (s: string) => string,
): MemberRow[] {
  return children.map((child, i) => ({
    detail: memberDetail(child, t),
    isDone:
      child.type === "show"
        ? Boolean(
            child.leafCount &&
              (child.viewedLeafCount || 0) >=
                child.leafCount,
          )
        : Boolean(child.watched),
    isSpecial: false,
    label: `${i + 1}. ${child.title}`,
    ratingKey: String(child.ratingKey),
    season: null,
  }))
}

function toEpisodeRows(
  data: ShowEpisodes,
  unit: EntryUnit,
  hasSpecials: boolean,
): MemberRow[] {
  return data.seasons.flatMap((s) =>
    s.episodes.map((e) => ({
      detail: e.title || "",
      isDone: Boolean(e.watched),
      isSpecial: hasSpecials && s.season === 0,
      label: seLabel(
        {
          episode: e.episode,
          multiSeason: data.multiSeason,
          season: s.season,
        },
        unit,
      ),
      ratingKey: e.ratingKey ? String(e.ratingKey) : null,
      season: data.multiSeason ? s.season : null,
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
  const t = useCallback(
    (s: string) => applyVocab(s, vocab),
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

  skippedRef.current =
    reg?.sets.find((s) => s.id === setId)?.skipped || []
  includedSpecialsRef.current =
    reg?.sets.find((s) => s.id === setId)
      ?.included_specials || []

  useEffect(() => {
    if (!ratingKey) return

    let isStale = false

    setRows(null)
    setNote("")
    setRecheck(null)

    const qs = [
      setId ? `set=${encodeURIComponent(setId)}` : "",
      !isCollection ? "specials=choices" : "",
      accountUuid
        ? `uuid=${encodeURIComponent(accountUuid)}`
        : "",
    ]
      .filter(Boolean)
      .join("&")
    const q = qs ? `?${qs}` : ""

    const load = async () => {
      if (isCollection) {
        const res = await api<{
          children: CollectionChild[]
        }>(
          "GET",
          `/api/collection/${ratingKey}/children${q}`,
        )

        return toMemberRows(res.children || [], t)
      }

      const res = await api<ShowEpisodes>(
        "GET",
        `/api/show/${ratingKey}/episodes${q}`,
      )

      return toEpisodeRows(
        res,
        unitOf(item, vocab),
        hasSpecials,
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
          `/api/collection/${ratingKey}/children${q ? `${q}&` : "?"}fresh=1`,
        )

        if (isStale) return

        const next = toMemberRows(res.children || [], t)
        const owned = new Set(
          next
            .map((r) => r.ratingKey)
            .filter((k): k is string => Boolean(k)),
        )

        setRows(next)
        // The user's own ticks OUTRANK the seed on this pass — they may have been editing
        // while it was in flight. Only keys the re-read dropped leave the set; a member Plex
        // has since ADDED seeds from the set's stored list, exactly as pass 1 does.
        setSkips((prev) => {
          const kept = [...prev].filter((k) => owned.has(k))
          const added = skippedRef.current.filter(
            (k) => owned.has(k) && !prev.has(k),
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
            .map((r) => r.ratingKey)
            .filter((k): k is string => Boolean(k)),
        )

        setRows(next)
        setSkips(
          new Set(
            skippedRef.current.filter((k) => owned.has(k)),
          ),
        )
        setIncludedSpecials(
          new Set(
            includedSpecialsRef.current.filter((k) =>
              owned.has(k),
            ),
          ),
        )

        return recheckAgainstPlex()
      })
      .catch((e: Error) => {
        if (isStale) return

        setRows([])
        setNote(
          `Could not read what is inside this entry: ${e.message}`,
        )
      })

    return () => {
      isStale = true
    }
    // `item`/`vocab` are read for the unit and the wording only, and both are stable for as
    // long as one entry's panel is open — the load is keyed on WHICH entry, not on a fresh
    // object identity arriving from an unrelated store refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    .map((r) => r.ratingKey)
    .filter((k): k is string => Boolean(k))
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
    : t(managed.length === 1 ? "episode" : "episodes")

  const onSave = () => {
    if (isSaving || !rows) return

    setIsSaving(true)
    void saveMemberSelection(setId, {
      includedSpecials,
      // Own every row here so a special skipped under the legacy all-specials switch loses
      // that old exclusion when it moves to the explicit inclusion model.
      managed,
      managedSpecials,
      skipped: skips,
    })
      .then((isOk) => {
        setIsSaving(false)

        if (isOk) closeMembersModal()
      })
      .catch(() => setIsSaving(false))
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
        reg?.sets.find((s) => s.id === setId)
          ?.provider_kind || undefined
      }
      id="membersmodal"
      isOpen
      onClose={closeMembersModal}
      onSubmit={onSave}
      title={`What plays in “${item.title}”`}
      titleId="membersmodal-title"
    >
      <p className="subhint">{t(HINT)}</p>

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
          <ul className="memberlist" id="memberlist">
            {rows.map((row, i) => (
              <MemberListRow
                key={row.ratingKey || `row-${i}`}
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
                previous={rows[i - 1] ?? null}
                row={row}
                seedKey={seedKey}
                t={t}
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
          {t("Nothing inside this entry to choose from.")}
        </p>
      ) : null}

      <p className="idnote" id="members-note">
        {note}
      </p>
    </Modal>
  )
}

/** One row, plus the season heading that opens its group. */
function MemberListRow({
  isSkipped,
  onToggle,
  previous,
  row,
  seedKey,
  t,
}: {
  isSkipped: boolean
  onToggle: (isPlaying: boolean) => void
  previous: MemberRow | null
  row: MemberRow
  seedKey: string
  t: (s: string) => string
}) {
  const isSeasonHead =
    row.season != null && row.season !== previous?.season

  return (
    <>
      {isSeasonHead ? (
        // h4: the modal's own title is an `<h3>` (`Modal.tsx`), so a season group opens one
        // level under it. Nothing on this route sits between them.
        <li className="memberseason">
          <h4>
            {row.isSpecial
              ? t("Specials")
              : `${t("Season")} ${row.season}`}
          </h4>
        </li>
      ) : null}
      <li>
        {row.ratingKey ? (
          <Checkbox
            description={row.detail || undefined}
            isChecked={!isSkipped}
            // Keyed on what re-seeds it from outside the user's own clicks — the rows
            // landing — and never on `isSkipped`, which changes on their click and would
            // remount the box under their finger.
            key={`${seedKey}:${row.ratingKey}`}
            label={row.label}
            onChange={onToggle}
            size="sm"
            value={row.ratingKey}
          />
        ) : (
          // No leaf key: this provider cannot skip one item, so the row reads rather than
          // pretends to be a control.
          <span className="memberplain">
            {row.label}
            {row.detail ? ` · ${row.detail}` : ""}
          </span>
        )}
        {row.isDone ? (
          <Badge intent="success" size="sm">
            {t("Watched")}
          </Badge>
        ) : null}
        {isSkipped ? (
          <Badge intent="neutral" size="sm">
            {row.isSpecial
              ? "Skipped by default"
              : "Skipped"}
          </Badge>
        ) : null}
      </li>
    </>
  )
}
