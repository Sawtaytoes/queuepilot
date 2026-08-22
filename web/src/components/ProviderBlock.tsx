import {
  Button,
  Checkbox,
  SegmentedControl,
} from "@charcuterie/ui"
import { useEffect, useState } from "react"

import { api } from "../lib/api"
import type {
  ProviderBlockValue,
  ProviderInfo,
  ProviderLibrary,
} from "../lib/types"
import { SelectListbox } from "./SelectListbox"

/**
 * One `{ provider, profile, libraries }` source on a queue. The whole block repeats — a
 * queue holds N of them — so mixing falls out of composition rather than out of a
 * multi-select control (decision `2026-08-13-provider-block-repeats-and-picks-its-control`).
 *
 * ## Which control renders, and why it is a rule rather than a choice
 *
 * The owner picked **segmented if the options fit, else the listbox as the longer-term
 * fix**, and "fit" is a measurement, not a taste call. Measured against the real
 * `#setmodal` box (`width: min(440px, 92vw)`, `padding: 20px 22px`, so 396px of content in
 * the Wide View and 315px at a 390px width):
 *
 * | providers | segmented, wide | segmented, narrow |
 * | --- | --- | --- |
 * | 2 | 264px — fits | 264px — fits |
 * | 3 | 371px — fits | 371px — **overflows** |
 * | 4 | 470px — overflows | overflows |
 * | 5 | 560px — overflows | overflows |
 *
 * The listbox is a flat 258px at any count. So the threshold is **two**: three providers
 * already overflow the Narrow View, which this app really has and holds with a CI gate
 * against horizontal scroll. Since providers are added at RUNTIME, the rule has to be evaluated at
 * runtime too — which is exactly what the owner's "if they fit, otherwise…" describes.
 *
 * One provider renders NO control at all (his "C1 is good when only 1 provider"): with
 * nothing to choose there is nothing to ask, and it means today's Plex-only users see no
 * change whatsoever.
 */
const SEGMENTED_MAX = 2

export function ProviderBlock({
  block,
  canRemove,
  index,
  onChange,
  onRemove,
  profileOptionsFor,
  providers,
}: {
  block: ProviderBlockValue
  canRemove: boolean
  index: number
  onChange: (next: ProviderBlockValue) => void
  onRemove: () => void
  /** Plex's profile list comes from the registry; other providers fetch their own. */
  profileOptionsFor: (
    providerId: string,
  ) => { label: string; value: string }[]
  providers: ProviderInfo[]
}) {
  const [libraries, setLibraries] = useState<
    ProviderLibrary[]
  >([])
  const [libError, setLibError] = useState<string | null>(
    null,
  )

  const provider =
    providers.find((p) => p.id === block.provider) ?? null

  // Libraries are provider-scoped: the list Plex serves is not the list Kavita serves, and
  // an id means nothing without knowing which provider it belongs to. Refetched whenever
  // the block's provider changes.
  useEffect(() => {
    let cancelled = false

    if (!block.provider) return

    setLibError(null)
    void api<{ libraries: ProviderLibrary[] }>(
      "GET",
      `/api/providers/${block.provider}/libraries`,
    )
      .then((r) => {
        if (!cancelled) setLibraries(r.libraries ?? [])
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setLibraries([])
        // A provider that is not configured says so here rather than rendering an empty
        // list that looks like "this provider has no libraries".
        setLibError(
          e instanceof Error ? e.message : String(e),
        )
      })

    return () => {
      cancelled = true
    }
  }, [block.provider])

  const profileOptions = profileOptionsFor(block.provider)

  // The profile field is provider-SCOPED, and today's copy is Plex-only. For Kavita there
  // is no Shield to switch and no scan to wait on; the real concept is which Kavita user
  // OWNS the reading list — and getting it wrong fails silently, with an empty reader and
  // no error. So label and help text come from the provider, never hardcoded here.
  const isPull = provider?.delivery === "pull"
  const profileLabel = isPull
    ? "Reads as user"
    : "Plays under profile"
  const profileHint = isPull
    ? `Which ${provider?.label ?? "provider"} account owns the reading list. A list built as a different account is invisible to the reader that is meant to open it.`
    : "Locks this source to a Plex Home profile — a scan waits (and switches the Shield) until that profile is signed in before it plays."

  // No box ticked = every library this source has, not "no source"
  // (decision `2026-08-17-no-libraries-checked-means-every-library`).
  const isEveryLibrary = block.libraries.length === 0

  const setLibrary = (id: string, on: boolean) => {
    onChange({
      ...block,
      libraries: on
        ? [...block.libraries, id]
        : block.libraries.filter((x) => x !== id),
    })
  }

  return (
    <div className="pblock" data-provider={block.provider}>
      <div className="phead">
        <span className="pname">
          Source {index + 1}
          {providers.length > 1 && provider
            ? ` — ${provider.label}`
            : ""}
        </span>
        {canRemove ? (
          // `#setmodal .rmblock` painted a small outline chip — transparent, a border, muted
          // text at 0.78rem. That is `appearance="outline"` at `size="sm"`. The rule is
          // scoped to `#setmodal` and this block only ever renders there, so nothing else
          // relied on it.
          <Button
            appearance="outline"
            intent="neutral"
            onClick={onRemove}
            size="sm"
          >
            Remove
          </Button>
        ) : null}
      </div>

      {/* One provider: no control. Two: segmented. Three or more: the listbox, because the
          segmented row overflows the Narrow View at three. See this file's header for the numbers. */}
      {providers.length > 1 ? (
        /* A <div>, not a <label>: SegmentedControl renders a `radiogroup`, which takes its
           accessible name from its own required `label` prop. Wrapping a radiogroup in a
           <label> would name the group twice and name none of its options. SelectListbox
           likewise carries its own `label`, so the visible text here is a plain <span>. */
        <div className="field">
          <span className="fieldlbl">Source app</span>
          {providers.length <= SEGMENTED_MAX ? (
            <SegmentedControl
              className="fieldseg"
              items={providers.map((p) => ({
                isDisabled: !p.configured,
                label: p.label,
                value: p.id,
              }))}
              key={`seg-${index}`}
              label="Source app"
              onChange={(v) =>
                onChange({
                  ...block,
                  libraries: [],
                  profile: "",
                  provider: v ?? block.provider,
                })
              }
              selectedValue={block.provider}
            />
          ) : (
            <SelectListbox
              className="fieldselect"
              id={`block-provider-${index}`}
              key={`lb-${index}`}
              label="Source app"
              onChange={(v) =>
                // Switching provider clears the libraries and profile: both are scoped to
                // the OLD provider, and carrying a Plex section id onto a Kavita block
                // would silently point at an unrelated library.
                onChange({
                  ...block,
                  libraries: [],
                  profile: "",
                  provider: v,
                })
              }
              options={providers.map((p) => ({
                isDisabled: !p.configured,
                label: p.configured
                  ? p.label
                  : `${p.label} — not connected`,
                value: p.id,
              }))}
              value={block.provider}
            />
          )}
        </div>
      ) : null}

      <label className="field">
        {profileLabel}
        <SelectListbox
          className="fieldselect"
          id={`block-profile-${index}`}
          key={`prof-${index}-${block.provider}`}
          label={profileLabel}
          onChange={(v) =>
            onChange({ ...block, profile: v })
          }
          options={profileOptions}
          value={block.profile}
        />
      </label>
      <p className="subhint">{profileHint}</p>

      <fieldset className="field">
        <legend>
          Libraries this queue can search &amp; hold
        </legend>
        {libError ? (
          <p className="subhint" role="alert">
            {libError}
          </p>
        ) : (
          <div
            className="libs"
            data-scope={isEveryLibrary ? "all" : "named"}
          >
            {/* Keyed on the PROVIDER, which is this group's second writer: switching the
                source clears `block.libraries` without anyone touching a box, and
                Charcuterie's Checkbox seeds `isChecked` on mount only. Not keyed on the
                checked set, which the user's own click writes. */}
            {libraries.map((l) => (
              <Checkbox
                isChecked={block.libraries.includes(l.id)}
                key={`${block.provider}:${l.id}`}
                label={l.title}
                onChange={(isChecked) =>
                  setLibrary(l.id, isChecked)
                }
                size="sm"
                value={l.id}
              />
            ))}
          </div>
        )}
        {/* The scope is OPTIONAL, and saying so is the whole point of the change: an empty
            group used to be a save error, so nobody could express "search all of it". */}
        <p className="subhint">
          {/* The provider NAMES the libraries ("Every Plex library"), so with no provider
              there is no adjective to write — not the word "library" a second time, which
              is what the `?? "library"` fallback printed. Its sibling at the top of this
              block falls back to "provider" for the same reason. */}
          {isEveryLibrary
            ? `${provider?.label ? `Every ${provider.label} library` : "Every library"} — check a box to narrow it.`
            : "Uncheck every box to search all of them."}
        </p>
      </fieldset>
    </div>
  )
}
