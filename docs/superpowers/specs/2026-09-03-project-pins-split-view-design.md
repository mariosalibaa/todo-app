# Project pins, pinned-only filter, and split Project List

Date: 2026-09-03
File touched: `todo.html` (single-file front end). No server changes.

## Goal

Three related additions to the **Project List** view (`currentView === 'projects-list'`):

1. Pin a project. Pinned projects sort to the top, in their own group.
2. A "Pinned only" toggle that hides everything unpinned.
3. Split the view: the project table on top, the selected project's tasks below.

Pins are **per user** and sync across that user's devices. The Project List is the
only surface that changes; the sidebar tree, the Projects board, and the Dashboard
are untouched.

## 1. Data model

One new field on the existing project record:

```js
projectMeta[p].pinnedBy = ["Mario", "Therese"]   // short user names
```

- Identity is `whoAmIName()` (`todo.html:5129`) — the same short name the activity
  log and reminders already use.
- Absent or empty array means nobody has pinned the project. An older client that
  never wrote the field reads as `[]`.
- Helpers:
  - `isPinned(p)` → `(projectMeta[p]?.pinnedBy || []).includes(whoAmIName())`
  - `togglePin(p)` → add/remove the name, `saveProjectMeta()`, `renderProjectsList()`

### Why this and not a per-user prefs store

`pinnedBy` rides the existing `GET/POST /api/workspaces/:id/projects` round trip, so
there is no new Firestore collection, no new route in `server.js`, and no extra
load step at boot — while still syncing to the user's phone. A dedicated per-user
prefs endpoint was considered and rejected as disproportionate to a boolean.

### What comes for free

- **Rename**: `commitProjNameEdit` deep-copies meta to the new key
  (`todo.html:3818`), so `pinnedBy` survives a rename.
- **Delete**: `deleteProject` already drops the meta entry (`todo.html:3849`).

### Deliberately out of scope

No per-user ordering inside the Pinned group. A user-specific `ord` map is a lot of
machinery for a group that will hold a handful of rows. The Pinned group sorts by
the same rule the status groups use today: `projectMeta[p].ord` when present, then
alphabetical.

### Concurrency

`saveProjectMeta()` POSTs the whole project map, so simultaneous edits by two users
are last-writer-wins across the map. This is the pre-existing behaviour for status,
due date and `ord`; pins inherit it. Not addressed here.

## 2. Pin control and grouping

**Row control.** A pin button in the name cell of `projRowHtml`, between the open
(⛶) button and the rename input. Dim and revealed on row hover when unpinned; solid
amber when pinned. Unpinned rows stay as visually clean as they are now.

**Bulk pin.** `plBulkBarHtml` gains Pin / Unpin buttons acting on the checkbox
selection `plSel`, alongside the existing Status and Delete actions.

**Grouping.** `renderProjectsList` emits a **Pinned** group before the status
groups. Pinned projects are removed from `byStatus` first, so:

- Every project appears exactly once.
- Status group headers keep honest "N projects · M open tasks" counts.
- The Pinned header shows the same counts, in amber.

**Drag.** `initPlistDrag` skips rows inside the Pinned group. Cross-group drag sets
a project's status, which has no meaning for a group that is not a status. To
re-file a pinned project, unpin it first.

## 3. Pinned-only toggle

- A "Pinned only" button in the Project List toolbar, beside `+ New Project` and
  `Print`, using the existing active-button styling.
- State: `plPinnedOnly`, persisted in `localStorage` under `todo_pl_pinned_only`.
  This is a view preference, so per device is correct — unlike the pins themselves.
- When on, `visibleProjects` is filtered to `isPinned` **before** grouping, so it
  composes with the existing per-column filters and with `plistHasFilters()`.
- `#task-count` reads `N pinned projects`.
- With the toggle on and no pins, the empty state reads:
  *"No pinned projects — click the pin on a row to pin one."*

## 4. Split screen

### Container

`#projects-list-view` (`todo.html:1912`) changes from one scrolling box to
`display:flex; flex-direction:column; overflow:hidden`, holding:

| child | role |
| --- | --- |
| `#pl-top` | scrolls; today's toolbar + table markup, unchanged |
| `#pl-divider` | 6px grab bar |
| `#pl-split` | hidden until a project is selected |

`#pl-split` is a header strip (project name · ⛶ drill full-screen · `+ Task` ·
`✕` close) over `#pl-split-body`, which scrolls independently.

### Selecting a project

`<tr class="plist-row">` gets `onclick="plSelectProject(p)"`. Every interactive
child in the row must call `event.stopPropagation()` — checkbox, drag handle, the
open button, rename input, the company / client / status / due / bill cells, and the
action buttons. Several already stop propagation; the remainder are added.

The ⛶ button keeps its current meaning: full-screen drill-down via
`openProjectTasks`, with the existing Back button. Only the row background is the
new gesture.

The selected row gets a `pl-active` class (left accent border), visually distinct
from the `nl-selected` checkbox highlight, so "shown below" and "ticked for a bulk
action" never look alike.

### Rendering the tasks

`#pl-split-body` calls the same renderer the List view is currently set to —
`renderNiceList(filtered, el)` or `renderListTable(filtered, el)` per `listMode`.
No second task renderer is introduced.

`filtered` is `getFiltered()` narrowed to the selected project, so the active user,
department, priority and search filters and `showDone` keep applying, consistent
with the rest of the app.

Both renderers take a new optional third argument `opts`:

- `opts.hideProjCols: true` — `renderListTable` currently derives this from
  `filterProject !== 'All'` (`todo.html:10726`); in the pane the Company and
  Project columns are always redundant.
- The same flag suppresses the renderers' writes to `#task-count` and
  `updateLineCount`, which would otherwise clobber the project count in the toolbar.

The main List table and the pane are never on screen simultaneously, so they safely
share the column-filter, sort and selection globals — the user's sort and column
filters carry over between the two, which is the desired behaviour.

### Divider

`mousedown` on `#pl-divider` starts a drag that sets `plSplitH` as a percentage of
the container height, persisted per device. Clamped to 20–80% **and** to a minimum
of 120px per pane, so the split stays usable on a short window or a phone.

### Persistence and re-render

- `plSplitProj` (the selected project name) is remembered per device, so returning
  to the Project List restores the pane. If that project no longer exists, it
  clears silently and the pane stays closed.
- Task edits funnel through `renderAll()`, which calls `renderProjectsList()` in
  this view, so the pane refreshes itself. `renderProjectsList` must preserve both
  panes' scroll positions across the re-render, the way it already restores focus
  and caret into the column filter input being typed in.

### Edges

- A column filter that hides the pane's project does not close the pane; `✕` does.
- `printProjectList` keeps printing the top pane only, filters respected, unchanged.

## Verification

There is no test framework in this repo (`package.json` defines only `start` and
`dev`). Verification is a manual pass against the local server:

**Pins**

1. Pin a project → it moves to the Pinned group; its former status group's project
   count drops by one and the open-task count drops accordingly.
2. Reload → the pin survives.
3. Rename a pinned project → it stays pinned under the new name.
4. Delete a pinned project → it disappears from the Pinned group, no stale row.
5. Bulk-select three projects → Pin → all three move up; Unpin returns them.

**Pinned-only**

6. Toggle on → only pinned rows; count reads "N pinned projects"; reload keeps the
   toggle.
7. Toggle on with zero pins → the empty-state message appears.
8. Toggle on **and** a column filter set → both apply; Clear clears the columns and
   leaves the toggle.

**Split**

9. Click a row → the pane opens with that project's tasks; the row shows `pl-active`.
10. Click the checkbox, the drag handle, the name, and each editable cell → none of
    them change the pane.
11. Edit a task inline in the pane → it saves, and both panes keep their scroll.
12. Drag the divider → the height persists across a reload.
13. `✕` closes the pane; the table returns to full height.
14. ⛶ still drills full-screen, and Back still returns to the Project List.
15. Narrow the window to phone width → both panes stay above 120px and usable.
