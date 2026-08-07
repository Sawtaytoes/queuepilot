import { type ReactNode, useEffect, useRef } from "react"

import { busy } from "../state/busy"

/**
 * A real `<dialog>` + `showModal()`, as the vanilla app used — not a hand-rolled
 * overlay. That is what gives Esc, the inert backdrop and focus containment for
 * free, and it is what `#dynmodal[open]` / `#setmodal[open]` select on in the e2e
 * suites.
 *
 * Two things `<dialog>` does NOT do, both handled here:
 *
 * - **It does not lock page scroll.** On a tablet the background scrolls under the
 *   open dialog. `html.modal-open { overflow: hidden }` is applied while any dialog
 *   is open, and released on every close path (Esc, backdrop, ✕, submit) by
 *   listening to the native `close` event rather than by remembering to call a
 *   helper at four sites.
 * - **A backdrop click does not close it.** The click lands on the dialog element
 *   itself (the form is the only child with area), so `e.target === dialog` is the
 *   backdrop test.
 */

type Props = {
  id: string
  isOpen: boolean
  onClose: () => void
  title: string
  titleId?: string
  onSubmit?: () => void
  children: ReactNode
  footer?: ReactNode
}

export function Modal({
  children,
  footer,
  id,
  isOpen,
  onClose,
  onSubmit,
  title,
  titleId,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  // True while THIS modal holds the page-scroll lock + its slot in `openModals`, so
  // the lock is dropped exactly once no matter HOW the modal goes away.
  const isLocking = useRef(false)

  // Release the scroll-lock + busy count this modal holds. Idempotent — the native
  // `close` path and the unmount backstop both call it, but only the first wins.
  const release = () => {
    if (!isLocking.current) return

    isLocking.current = false
    busy.openModals = Math.max(0, busy.openModals - 1)

    if (!document.querySelector("dialog[open]")) {
      document.documentElement.classList.remove("modal-open")
    }
  }

  // Always call the freshest `release` from the mount-once unmount effect below.
  const releaseRef = useRef(release)
  releaseRef.current = release

  useEffect(() => {
    const dlg = ref.current

    if (!dlg) return

    if (isOpen && !dlg.open) {
      document.documentElement.classList.add("modal-open")
      busy.openModals += 1
      isLocking.current = true
      dlg.showModal()
    }
    else if (!isOpen && dlg.open) {
      dlg.close()
    }
  }, [isOpen])

  useEffect(() => {
    const dlg = ref.current

    if (!dlg) return

    const onNativeClose = () => {
      release()
      onClose()
    }

    dlg.addEventListener("close", onNativeClose)

    return () => dlg.removeEventListener("close", onNativeClose)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose])

  // A `<dialog>` removed from the DOM while still open never fires `close`, so a
  // modal that unmounts mid-open — App.tsx renders each overlay as `x ? <M/> : null`,
  // and an optimistic add + background refresh can swap the item out from under an
  // open picker — would strand `html.modal-open` and the page would silently stop
  // scrolling with no dialog in sight. Releasing on unmount is the backstop.
  useEffect(() => () => releaseRef.current(), [])

  return (
    <dialog
      id={id}
      onClick={(e) => {
        if (
          e.target === ref.current ||
          (e.target as HTMLElement).closest("[data-close]")
        ) {
          ref.current?.close()
        }
      }}
      ref={ref}
    >
      <form
        id={`${id.replace("modal", "")}form`}
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit?.()
        }}
      >
        <button
          aria-label="Close"
          className="modalx"
          data-close=""
          type="button"
        >
          <svg aria-hidden="true" height="15" viewBox="0 0 14 14" width="15">
            <path
              d="M2 2l10 10M12 2L2 12"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="2"
            />
          </svg>
        </button>
        <h3 id={titleId}>{title}</h3>
        {children}
        <div className="modalbtns">{footer}</div>
      </form>
    </dialog>
  )
}
