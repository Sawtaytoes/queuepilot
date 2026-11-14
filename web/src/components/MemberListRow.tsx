import {
  Badge,
  Checkbox,
  IconButton,
} from "@charcuterie/ui"
import { DragIcon } from "./DragIcon"

/** One row, whatever it came from — a collection member or an episode. */
export type MemberRow = {
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

/** One row, plus the season heading that opens its group. */
export function MemberListRow({
  isCollection,
  isSkipped,
  onMove,
  onToggle,
  position,
  previous,
  row,
  seedKey,
  t,
}: {
  isCollection: boolean
  isSkipped: boolean
  onMove?: (offset: number) => void
  onToggle: (isPlaying: boolean) => void
  position: number
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
      <li
        data-set={isCollection ? row.ratingKey : undefined}
      >
        {row.ratingKey ? (
          <Checkbox
            description={row.detail || undefined}
            isChecked={!isSkipped}
            // Keyed on what re-seeds it from outside the user's own clicks — the rows
            // landing — and never on `isSkipped`, which changes on their click and would
            // remount the box under their finger.
            key={`${seedKey}:${row.ratingKey}`}
            label={
              isCollection
                ? `${position}. ${row.label}`
                : row.label
            }
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
        {onMove ? (
          <IconButton
            appearance="ghost"
            className="rowdrag"
            intent="neutral"
            label={`Drag ${row.label} to reorder. Use the up and down arrow keys to move it.`}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp") {
                event.preventDefault()
                onMove(-1)
              } else if (event.key === "ArrowDown") {
                event.preventDefault()
                onMove(1)
              }
            }}
            size="sm"
          >
            <DragIcon />
          </IconButton>
        ) : null}
      </li>
    </>
  )
}
