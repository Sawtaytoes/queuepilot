# Media queues use Charcuterie cards

The queue index put each title, count, lane summary, and audience on one long line.
The approved card direction gives each queue a distinct surface, with its audience
below the title and its lane summary beside visible actions.

Use Charcuterie `Card` for both Picks and Rules, including its shared categorical
accent edge, surface, padding, border, and corners. Use `useAdaptiveColumns` for the
grid calculation. The app supplies layout and content; it does not repaint the
shared card. The grid retains its own DOM container because queue dragging moves
its direct children and restores them before React updates.

A parent and its filtered views occupy one grid cell and move as a unit. A view
whose parent is absent from its people-filter tier stays visible independently.
Exact and also-in matches retain their separate tiers. Search can show a matching
view while hiding its nonmatching parent.

Expanded shelves retain one poster strip, lane controls, playback, removal, and
cross-queue moves. Rules previews remain read-only. Queue title and people rules
are unchanged. This supersedes the single-baseline heading layout in the August 29
heading records; it preserves the shared accent-edge decision and shared title rule.

Verification: four-window smoke and queue-card interaction coverage, plus fixture
before/after screenshots. No household values or screenshots belong in this repo.
