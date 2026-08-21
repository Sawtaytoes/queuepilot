import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"

import { setStatus } from "../state/store"

/**
 * The search-as-you-type dropdown, shared by the in-queue add box, the Home
 * toolbar's add-to-ANY-queue search, the channel member picker and the exclude
 * picker. Four behaviours here are bug fixes with history and none are negotiable
 * (decision `2026-07-21-shelf-ui-conventions`):
 *
 * 1. **Keyboard**: ↑/↓ move the highlight, Enter picks it (the first row if none is
 *    highlighted), Esc closes.
 * 2. **Delegated picks.** The click handler lives on the LIST, not the row. A
 *    listener bound to the row dies when a late search response re-renders the list
 *    between mousedown and mouseup — that was "clicking a result doesn't work".
 * 3. **Stale responses are dropped.** A response for text the user has already left
 *    must not repaint the list.
 * 4. **A no-match search shows a muted, non-pickable row** rather than silently
 *    staying closed, which read as "search is broken".
 *
 * Only the HITS are held in state; the rows are rebuilt from `rowFor` on every
 * render, so a row's `pick` closure always sees current props. Building rows once
 * when the response landed is what would freeze a caller's own state (the Add-to
 * menu's open row) inside a stale closure.
 *
 * **The input is uncontrolled and listens to the NATIVE `input` event**, not
 * React's `onChange`. React installs a value tracker on every `<input>` it renders
 * and suppresses the synthetic change event when the new value equals the tracked
 * one — so re-entering the SAME query (`fill('#gsearch', 'toy tinkers')` twice, the
 * second time after the box already held it) fires nothing at all, and the search
 * silently never runs. `ui-test` catches exactly that, and it is a real behaviour
 * too: the vanilla box re-searched on any input event, identical text or not.
 */

export type SearchRow = {
  /** Rendered inside the `<li>`; must not include the `<li>` itself. */
  content: ReactNode
  /**
   * A group heading rendered ABOVE this row, inside the SAME `<li>`.
   *
   * Inside, and not as an `<li>` of its own, because of (2) below: the delegated click
   * handler finds a row by `indexOf` on the list's children, so it requires one child per
   * entry in `rows`. A separator `<li>` would shift every index after it and start firing
   * the wrong result's `pick`. Styling makes it read as a rule across the list; the DOM
   * keeps the one-child-per-row contract the click handling depends on.
   */
  separator?: ReactNode
  /** Run on click-anywhere-on-the-row, or on Enter. */
  pick: () => void
  /** Nested controls that own their own clicks and must not trigger `pick`. */
  ignoreSelector?: string
  className?: string
}

type Props<T> = {
  inputId: string
  listId: string
  placeholder: string
  doSearch: (q: string) => Promise<T[]>
  rowFor: (
    hit: T,
    index: number,
    close: () => void,
  ) => SearchRow
  /** Extra controls rendered between the input and the list (e.g. the Add-to
   * position select). */
  children?: ReactNode
  onClose?: () => void
}

export function SearchDropdown<T>({
  children,
  doSearch,
  inputId,
  listId,
  onClose,
  placeholder,
  rowFor,
}: Props<T>) {
  const [hits, setHits] = useState<T[]>([])
  const [noMatch, setNoMatch] = useState<string | null>(
    null,
  )
  const [activeIndex, setActiveIndex] = useState(-1)
  const [isOpen, setIsOpen] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const timerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null)

  const close = useCallback(() => {
    setIsOpen(false)
    setActiveIndex(-1)
    onClose?.()
  }, [onClose])

  const clearInput = useCallback(() => {
    if (inputRef.current) inputRef.current.value = ""

    setHits([])
    setNoMatch(null)
    close()
  }, [close])

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const onInput = (next: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)

    const q = next.trim()

    if (q.length < 2) {
      setIsOpen(false)
      setHits([])
      setNoMatch(null)

      return
    }

    timerRef.current = setTimeout(async () => {
      try {
        const found = await doSearch(q)

        // Stale — the user kept typing. Read the LIVE input, not `value`: this
        // closure captured the text as it was 250 ms ago.
        if (inputRef.current?.value.trim() !== q) return

        setHits(found.slice(0, 30))
        setNoMatch(found.length ? null : q)
        setActiveIndex(-1)
        setIsOpen(true)
      } catch (e) {
        setStatus(
          `Search failed: ${(e as Error).message}`,
          "err",
        )
      }
    }, 250)
  }

  // The native `input` listener, registered once. `handlerRef` keeps it pointed at
  // the current closure without re-binding on every render.
  const handlerRef = useRef(onInput)

  handlerRef.current = onInput

  useEffect(() => {
    const el = inputRef.current

    if (!el) return

    const listener = () => handlerRef.current(el.value)

    el.addEventListener("input", listener)

    return () => el.removeEventListener("input", listener)
  }, [])

  const rows = hits.map((hit, i) =>
    rowFor(hit, i, clearInput),
  )

  const onKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key === "Escape") {
      close()

      return
    }

    if (!rows.length) return

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()

      const next =
        e.key === "ArrowDown"
          ? (activeIndex + 1) % rows.length
          : (activeIndex - 1 + rows.length) % rows.length

      setActiveIndex(next)

      requestAnimationFrame(() => {
        listRef.current
          ?.querySelectorAll("li")
          [next]?.scrollIntoView({ block: "nearest" })
      })
    } else if (e.key === "Enter") {
      e.preventDefault()
      rows[activeIndex >= 0 ? activeIndex : 0]?.pick()
    }
  }

  // Delegated pick — see (2) above.
  const onListClick = (
    e: React.MouseEvent<HTMLUListElement>,
  ) => {
    const li = (e.target as HTMLElement).closest("li")

    if (!li || !listRef.current) return

    const index = [...listRef.current.children].indexOf(li)
    const row = rows[index]

    if (!row) return
    if (
      row.ignoreSelector &&
      (e.target as HTMLElement).closest(row.ignoreSelector)
    ) {
      return
    }

    row.pick()
  }

  return (
    <>
      <input
        defaultValue=""
        id={inputId}
        onBlur={() => {
          // NOT an immediate close: a click on a row has to land first, and a
          // nested menu inside a row needs focus time.
          setTimeout(() => {
            const focused = document.activeElement

            // A row's Add-to menu is a Charcuterie `Menu`, and a `Menu` PORTALS its
            // panel to <body>. So the element that now holds focus is inside the
            // dropdown on screen and outside it in the DOM, and a containment test
            // against the list alone reads it as "focus left" — which closed the
            // results the instant the menu opened, taking the menu with them.
            const isFocusHeld =
              listRef.current?.contains(focused) ||
              focused?.closest('[role="menu"]') != null

            if (!isFocusHeld) close()
          }, 250)
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        ref={inputRef}
        type="search"
      />
      {children}
      <ul
        className={`results${isOpen ? " open" : ""}`}
        id={listId}
        onClick={onListClick}
        ref={listRef}
      >
        {noMatch ? (
          <li className="noresults">{`No matches for “${noMatch}”.`}</li>
        ) : (
          rows.map((row, i) => (
            <li
              className={
                [
                  row.className,
                  i === activeIndex ? "active" : null,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              // A search result set has no identity beyond its position: rows
              // never persist across searches, and a ratingKey key would make
              // React reuse a row for a different hit at the same index.
              // biome-ignore lint/suspicious/noArrayIndexKey: the index IS the identity here — see above.
              key={i}
            >
              {row.separator ? (
                <span className="resultsplit">
                  {row.separator}
                </span>
              ) : null}
              {row.content}
            </li>
          ))
        )}
      </ul>
    </>
  )
}
