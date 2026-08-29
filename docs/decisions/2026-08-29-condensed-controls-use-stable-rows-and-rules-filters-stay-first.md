# Condensed controls use stable rows, and Rules filters stay first

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** Responsive UI / layout
- **Supersedes:** [Queue shelf headings omit the audience chevron](2026-08-29-queue-shelf-headings-omit-the-audience-chevron.md) (alignment only; its content decision remains)
- **Superseded by:** —

## Decision

The Picks toolbar uses a container-responsive grid. It is one aligned row when the content
area is wide enough. At condensed widths, the library search takes the first row and the queue
filter plus actions take the next aligned row. The Narrow View gives both searches full rows
and keeps the two actions together.

A shelf heading aligns its collapse button with the queue-name row. The button does not span
the audience and action rows. The shelves also have space above the first heading.

At one-column Rules widths, **Eligibility filters** is the first part of the page body. The
eligible-title result can be very long, so the filter panel never follows it.

## Context

The old wrapping flex rows made controls land on different vertical axes at intermediate
widths. A shelf collapse button aligned against the heading's combined baseline, which left
the icon and queue name visibly uneven. On the Rules page, DOM order put the filters after
the whole generated result when the two-column grid collapsed.

The owner reported all three defects with images and asked for stable control alignment,
correct shelf-button alignment, top padding, and filters above the Rules result in the Narrow
View.

## Why

- A grid makes each control's row deliberate instead of dependent on the label widths that
  happen to fit.
- The collapse button controls the queue-name row, so that is the row it aligns with.
- Eligibility filters must be reachable before a potentially large generated result.
- Container width is the relevant measurement for a toolbar beside a responsive navigation
  rail.

## Evidence

- Owner, 2026-08-29, current conversation and attached images 3, 4 and 7.
