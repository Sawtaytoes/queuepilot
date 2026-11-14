import { Button } from "@charcuterie/ui"
import type { ReactNode } from "react"
import { Link } from "react-router"
import {
  isPullSet,
  OpenQueueButton,
} from "../components/OpenQueueButton"
import type { RegistrySet } from "../lib/types"

/**
 * The two kinds, as the card says them out loud.
 *
 * Ordered Queue and Curated Pool were the same object with different default playback —
 * both are hand-picked titles — so they share one badge. Rules queues are the other kind
 * (membership from library/ratings rules). The badge is the ONLY place the page says them;
 * there are no shelf headings left to carry them.
 * (decision `2026-08-23-kind-is-picks-or-rules`; supersedes the three-name split in
 * `2026-08-16-filtered-pools-curated-pools-ordered-queues`)
 */
type SetKind = "picks" | "rules"

const KIND_WORD: Record<SetKind, string> = {
  picks: "Picks",
  rules: "Rules",
}

export function PlayCard({
  kind,
  label,
  meta,
  onPlay,
  people,
  set,
  tier,
  to,
}: {
  /**
   * Where this card GOES — a real link target, not an `onClick` that calls `navigate()`.
   * Middle-click, ⌘/Ctrl-click, "Open in new tab", "Copy link address" and the status-bar
   * preview all come from the ELEMENT being an anchor; none of them can be added to a
   * `<button>` by styling it like a link.
   * (decision `2026-08-15-navigation-is-an-anchor-not-a-button`)
   *
   * It is a react-router `<Link>` rather than a bare `<a>` as of 2026-08-16. Under the
   * hash router a plain `<a href="#/q/1">` needed no handler — setting the hash WAS the
   * navigation. A path `<a href="/q/1">` is not the same thing: the browser would leave
   * the page and refetch the whole app. `<Link>` still RENDERS an `<a href>`, so every
   * affordance above survives; it just intercepts the plain left-click.
   */
  to: string
  kind: SetKind
  label: string
  meta: string
  onPlay: (anchor: DOMRect) => void
  /**
   * WHO THIS QUEUE IS FOR — a `PeopleRow`, or null for a card that has no trays.
   *
   * The same row the Picks page draws in a shelf heading, and it is here for the reason it
   * is there: it is the only thing on the card that says a queue apart from its neighbour
   * once you stop reading the name. A shelf can lean on its posters for that; a landing card
   * has none, so this row is doing MORE work here, not less
   * (decision `2026-08-25-a-queue-is-people-plus-an-activity`).
   *
   * A RULES card carries one too, as of 2026-08-26. It used to be null here on the argument
   * that a filtered pool is bound to one provider ACCOUNT and its meta line already names it.
   * That conflated two facts: the account is which Plex profile the pool signs in as, and the
   * trays are who the pool is FOR. The owner reported the gap from the other end — there was
   * no way to put anybody on Shorts or Movies at all
   * (decision `2026-08-26-a-rules-queue-carries-people-too`).
   */
  people?: ReactNode
  /** The registry entry, for `delivery`, the accent + the start button's words. Absent =
   * push (pre-provider callers). */
  set?: Pick<
    RegistrySet,
    "id" | "delivery" | "provider_kind" | "vocabulary"
  >
  tier?: ReactNode
}) {
  return (
    // Each card wears its own set's colour, so the landing says at a glance which service
    // each button will talk to — the Kavita card's Open button is Kavita-green beside the
    // Plex cards' amber. (decision `2026-08-15-a-queue-wears-its-providers-colour`)
    <li
      className="playcard"
      // The id the reorder hook reads off the DOM after a drag — the cards it moves are
      // nodes, not React state, so the new order has to be legible from the elements.
      data-set={set?.id}
      data-kind={kind}
      data-provider={set?.provider_kind || undefined}
    >
      <div className="cardhead">
        {/* TOUCH ONLY, and CSS decides that — the glyph is `display: none` on a fine pointer,
            where the whole card is grabbable and this would be an empty gutter indenting
            every name for a control shown on hover. It survives on a coarse pointer because
            whole-card touch dragging would cost the page its scroll surface, and because
            there is no hover there to reveal an affordance with. Hidden from assistive tech:
            it is a pointer affordance, and reordering is not the only way to get anywhere.
            (decision `2026-08-19-the-whole-card-is-the-drag-handle-on-a-fine-pointer`) */}
        <span
          aria-hidden="true"
          className="rowdrag"
          title="Drag to reorder"
        >
          ≡
        </span>
        <Link className="rowname" to={to}>
          {label}
        </Link>
        {/* Not a `<Badge>`: charcuterie's badge is a status pill with an intent colour,
            and this is a permanent classification rather than a state that changes. It
            also has to sit flush against a heading that may wrap to two lines, which the
            pill's own line-height fights. */}
        <span className="cardkind">{KIND_WORD[kind]}</span>
      </div>
      {/* ITS OWN ROW, above the meta rather than inside it. The faces are 26px tall and the
          meta is 0.83rem text; sharing a line would set the row's height from the faces and
          leave the count floating half-way up it. Above the meta and not below, because the
          two lines answer "whose is this" and then "how big is it" — the order somebody
          scanning a wall of cards asks them in. */}
      {people}
      {/* THE META OWNS A LINE. It used to be the first child of `.cardfoot`, sharing the
          row with the start button, and `.cardfoot` wraps — so whether the button ended up
          beside the meta or on a line of its own was decided by how many characters that
          card's meta happened to have. Three cards in one row of the live grid had three
          different layouts: "17 entries · random pool" fit, so its button sat right;
          "Younger Kids · rotation · ratings-filtered" did not, so its button dropped to a
          second line and (with nothing pushing it over) sat LEFT; "Younger Kids · weighted
          rewatch" fit again. Same component, same CSS, three shapes.

          Out here the line is unconditional: name, then meta, then the action on the floor,
          on every card at every width. */}
      <p className="rowmeta">{meta}</p>
      <div className="cardfoot">
        {tier}
        {isPullSet(set) ? (
          // Nothing to cast to — the launcher URL is the whole affordance.
          <OpenQueueButton set={set} />
        ) : (
          <>
            {/* A Charcuterie `Button`, `intent="accent"` — what `.playbtn`'s solid accent skin
              painted by hand. The class STAYS as a DOM handle: `PlayMenu` asks
              `t.closest(".playbtn")` so pressing this does not close the menu it opens. */}
            <Button
              className="playbtn"
              intent="accent"
              onClick={(event) =>
                onPlay(
                  event.currentTarget.getBoundingClientRect(),
                )
              }
            >
              ▶ Play on ▾
            </Button>
          </>
        )}
      </div>
    </li>
  )
}
