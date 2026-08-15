import { Modal as OverlayModal } from "@charcuterie/ui"
import { type ReactNode, useEffect } from "react"

import { busy } from "../state/busy"

/**
 * The app's modal, now built on Charcuterie's base `Modal` (a body-portalled overlay)
 * instead of a native `<dialog>` + `showModal()`.
 *
 * Why the switch: a `showModal()` dialog lives in the browser TOP LAYER, above every
 * portal — so a Charcuterie `Listbox`/`Combobox` opened inside it (portalled to
 * `document.body`) rendered BEHIND the modal and was unclickable. Charcuterie's overlay
 * portals to `document.body` at `--layer-modal`, so a picker's dropdown now stacks above
 * it. That is the whole reason in-modal pickers can be `SelectListbox`.
 * (decision `2026-08-07-plex-channels-pickers-are-listbox-not-native-select`)
 *
 * The PUBLIC API and DOM contract are unchanged on purpose — the three consumers
 * (DynModal/SetModal/StartModal) and the e2e suites are untouched:
 *  - `id` stays on the box element (so `#dynmodal`/`#setmodal`/`#startmodal` still resolve),
 *    and a real `open` attribute is kept while visible so `#{id}[open]` selectors work now
 *    that this is no longer a native dialog.
 *  - the `<form onSubmit>`, the `.modalbtns` footer and the `.modalx` ✕ are rendered here
 *    exactly as before — all of app.css's `#id …` modal chrome keys off the box id, so
 *    Charcuterie's own box surface is neutralised (below) and the app styling still owns
 *    the look.
 *  - `busy.openModals` + `html.modal-open` are maintained here (Charcuterie does its own
 *    scroll lock, but `uiBusy()` reads this counter as "an edit is in progress").
 *
 * Escape and a backdrop press close via Charcuterie's dismiss (`isDismissable`), so the
 * old native-close listener and manual backdrop test are gone.
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
  /**
   * Scopes the accent to one provider (`plex` / `kavita`) for everything inside the modal.
   * Lands on the app-styled `#id` box rather than Charcuterie's outer shell, because that is
   * the element every `#setmodal` rule already targets. Omit for a modal that belongs to no
   * queue — it then inherits the app's neutral accent.
   */
  dataProvider?: string
}

export function Modal({
  children,
  dataProvider,
  footer,
  id,
  isOpen,
  onClose,
  onSubmit,
  title,
  titleId,
}: Props) {
  useEffect(() => {
    if (!isOpen) return

    busy.openModals += 1
    document.documentElement.classList.add("modal-open")

    return () => {
      busy.openModals = Math.max(0, busy.openModals - 1)

      if (busy.openModals === 0) {
        document.documentElement.classList.remove(
          "modal-open",
        )
      }
    }
  }, [isOpen])

  return (
    <OverlayModal
      aria-labelledby={titleId}
      // Neutralise Charcuterie's own bordered/rounded/elevated box: the visible box is the
      // app-styled `#id` element below (every `#startmodal|#setmodal|#dynmodal …` rule in
      // app.css targets it), and its own `max-height`/`overflow` handle scrolling. Tailwind
      // v4 takes `!` as a SUFFIX.
      className="max-h-none! overflow-visible! rounded-none! border-0! bg-transparent! p-0! shadow-none!"
      isVisible={isOpen}
      onClose={onClose}
    >
      {/* `data-open` (not `open`, which React only renders on <dialog>/<details>) keeps the
          e2e "modal is open" contract alive now that this is not a native <dialog>. */}
      <div
        data-open=""
        data-provider={dataProvider}
        id={id}
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
            onClick={onClose}
            type="button"
          >
            <svg
              aria-hidden="true"
              height="15"
              viewBox="0 0 14 14"
              width="15"
            >
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
      </div>
    </OverlayModal>
  )
}
