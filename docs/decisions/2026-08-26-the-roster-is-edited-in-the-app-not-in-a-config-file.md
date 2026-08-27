# 2026-08-26 — The roster is edited in the app, not in a config file

Status: Accepted
Date: 2026-08-26
Type: product rule / frontend + API (people)
Supersedes: nothing — it fills a gap `store/migrate/people.ts` left open by design
Superseded by: —

## Decision

**1. A person can be added, renamed and removed from inside the app.**
`POST /api/people`, `PATCH /api/people/:id`, `DELETE /api/people/:id`, behind `PeopleModal`
— reached from **⚙ Edit people** in the group bar, beside **⚙ Edit groups**.

**2. A GROUP's label is editable from the same screen.**
Labels only. Creating a group, deleting one, and choosing its sets and provider accounts stay
in `GroupsModal`, which this modal links to. A group's sets are a different question from its
name, and two editors for one field is two places to change it.

**3. A person id is generated once from the name and never moves.**
`slugify(displayName)`, de-duplicated with `-2`. A rename is display-side only. This is the
same contract `createGroup` keeps, and it is not a style choice: `queue_people` and
`group_people` both store a person id, and `PersonFace` hashes that id into a hue. An id that
moved on rename would empty a queue's Must-be-here tray *and* repaint the person.

**4. A blank name is refused, not stored.**
`display_name` is `NOT NULL` with a `''` default, so a blank one is a row that paints a `?`
face and no name — unidentifiable on the landing, the shelves, the trays and the Tonight
checklist at once.

**5. A delete cascades, and the app says what it took.**
`deletePerson()` already clears `person_accounts` and `group_people` by foreign key and
`queue_people` through `forgetMember`. The route counts the trays and rosters **before** the
delete and returns them, and the row shows that sentence in an inline confirmation:
*"Remove Ada? They are filed on 2 queues and 1 group, and will be taken off."*

**6. The mapping file keeps working and is never written.**
`/config/people-mapping.yaml` stays the import path, and it owns only the rows it names — "a
person in the database the file has never heard of is untouched". That is what makes an
app-added person safe beside it, and what stops the next restart importing over an edit made
here.

## Context

WP-5 put people on screen. Nothing ever put them under an editor: `GET /api/people` was
read-only, and the roster arrived exclusively through the owner-confirmed mapping file in
`/config`, imported at start-up. Changing somebody's name meant an agent editing YAML on the
appliance and restarting the app.

That surfaced on 2026-08-26. The owner's own person row read `Kevin`, and a *group* in the
same household is also labelled `Kevin` — two different objects that the queue editor's trays
correctly draw side by side. He opened the trays, saw both, and asked:

> There are now two Kevins here. Can we please fix this so I can edit the names somewhere?
> Add some UI. Let's get it fixed.

Nothing was broken. A person and a group are different things, both are legitimately in that
tray, and they may legitimately share a name. What was missing was any way to tell them apart
by renaming one.

## Why

**Because this is the same complaint the groups editor already answered.** `GroupsModal`
exists because of *"All those configs are managed by you, not inside the app. The only thing
that should be via env vars are the Plex token and Kavita token."* The roster is a config the
household owns, and it was still being managed by an agent over SSH.

**Because the mapping file is a MIGRATION record, not a roster.** Its header says so, and its
gate — nothing is written until a human writes `confirmed: true` — is about the identity match
it proposes, not about day-to-day maintenance. Adding a houseguest is not an identity claim
against Board Game Picker's `player_known_games`, and it should not need the ceremony that one
does.

**Because people and groups belong on ONE screen.** The collision that prompted this spans
both kinds. An editor that renamed only people would have fixed one half of *"two Kevins"* and
sent him to a second editor for the other.

**Because a name is read by four surfaces at once**, which is why the write is explicit rather
than save-on-blur: the landing cards, the shelf headings, the trays and the Tonight checklist
all paint `displayName`. Committing a half-typed name because somebody clicked a scrollbar is
a worse trade than one more button per row. The Save button is disabled until the row is
dirty, Enter submits, Escape reverts.

## Evidence

- The report, in full, with the screenshot of the trays showing the person `Kevin Ghadyani`
  one card above the group `Kevin` (chat 2026-08-26).
- The prior half of the same conversation: *"Also, how do I edit or add people? I don't see a
  settings area. Mine doesn't have my last name, and I wanted to add it."*
- `e2e/roster-editor-test.ts` — 27 assertions over a running app: the id survives a rename and
  the tray still resolves it, a blank name is a 400 on both add and rename, a duplicate name
  de-duplicates the id, a delete names the queue and the group it un-filed and leaves no
  orphan member rows, and the mapping file comes out byte-identical.
- `e2e/shot-people-editor.ts` — the before/after frames, and the three browser claims a still
  cannot make: Save is disabled on a clean row, it enables when the row is dirty, and the list
  repaints from the server's answer.
