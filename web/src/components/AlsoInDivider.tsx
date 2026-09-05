/**
 * The rule between the queues that ANSWER the filter and the queues the ticked people are
 * merely ON.
 *
 * The people filter answers in two tiers since 2026-09-05
 * (decision `2026-09-05-the-people-filter-answers-in-two-tiers-exact-then-also-in`). Above
 * this line: everybody ticked is on the queue and the queue needs nobody else. Below it:
 * everybody ticked is on the queue, and it also wants somebody who is not ticked.
 *
 * It says WHO the queues below want, not just that they want somebody, because the whole
 * point of the tier is that you should not have to already know:
 *
 * > "It removes the need to 'know' everyone who's required to be in a queue."
 *
 * Names rather than a count, capped, because three names is the answer and "and 6 others" is
 * a second question. The cap is on the NAMES, never on the queues — nothing below this line
 * is hidden.
 *
 * It renders nothing when there is nothing below it: a page with no partial matches is the
 * ordinary case and needs no chrome, exactly as `groupHits` only labels its first group when
 * there is a second one to tell it from.
 */

/** How many names the line prints before it counts the rest instead. */
const NAME_CAP = 3

export function AlsoInDivider({
  names,
}: {
  /** The people the queues below this line want, who are not ticked. In roster order. */
  names: readonly string[]
}) {
  return (
    // A PARAGRAPH, not `role="separator"`. The line carries text, and a separator that
    // carries text is a heading wearing a rule — `role="separator"` would make a screen
    // reader announce a divider and skip the sentence explaining what is under it. In
    // document order this reads before the first also-in queue, which is the whole job.
    <p className="alsodivide">
      <span className="alsodivide-label">
        Also in these queues
        {names.length ? (
          <span className="alsodivide-who">
            {" — they also want "}
            {listNames(names)}
          </span>
        ) : null}
      </span>
    </p>
  )
}

/** "Ada", "Ada and Sven", "Ada, Sven and Grace", "Ada, Sven, Grace and 4 others". */
function listNames(names: readonly string[]): string {
  const shown = names.slice(0, NAME_CAP)
  const rest = names.length - shown.length
  const tail =
    rest > 0
      ? `${rest} other${rest === 1 ? "" : "s"}`
      : shown.pop()

  return shown.length
    ? `${shown.join(", ")} and ${tail}`
    : String(tail)
}
