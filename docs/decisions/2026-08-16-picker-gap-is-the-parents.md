# A picker next to text gets its gap from the parent

- **Status:** Accepted
- **Date:** 2026-08-16
- **Type:** ui
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [2026-08-13-selectlistbox-adopts-the-shared-charcuterie-picker](2026-08-13-selectlistbox-adopts-the-shared-charcuterie-picker.md)

## Decision

**Do not put margin on the CountPicker / SelectListbox / Picker.** The
trigger is flush on purpose (Charcuterie: a control that ships margin
fights `Field`). An inline label + picker row owns a `column-gap`
instead.

`#entrymodal .field` and `#setmodal .flags > .field` are flex rows
with a 10px column-gap (the same gutter `.fieldselect` already used).
The hint takes the full next row.

## Context

The owner, 2026-08-16, after the Default chip landed on the closed
trigger:

> "we still need a space between this listbox and the text. That's an
> issue I've seen often. Not sure how to solve it, but we might need
> to update either Charcuterie or update the docs at least."

`#setmodal .fieldselect { margin-left: 10px }` already named the
defect for the *other* inline pickers. The CountPicker never got that
class.

## Why

- **Same gutter, not a new one-off.** 10px is what `.fieldselect`
  already paid. The flags CountPickers and the entry panel now use
  it without each growing their own margin.
- **Charcuterie documents the rule** on `Picker` (`the parent owns
  the gap`) so the next app does not invent `.fieldselect` again.

## Evidence

- Owner quote and screenshot, 2026-08-16.
- Charcuterie `docs/decisions/2026-08-16-picker-is-flush-the-parent-owns-the-gap.md`.
