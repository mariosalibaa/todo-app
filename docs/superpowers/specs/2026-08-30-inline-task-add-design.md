# Inline task creation and slide-over task detail

Date: 2026-08-30
Status: approved, not yet implemented
Scope: `todo.html` (single-file front end). No server or Firestore schema changes.

## Problem

Creating a task always opens the centered `New Task` modal (`#task-modal`,
todo.html:1624). Every entry point funnels into it: the sidebar button, the `N`
key, the per-project and kanban buttons, and the post-project-creation flow.

The List view already has a `＋ Add task` row (`nlInlineAdd`, todo.html:7833),
but it accepts a title and nothing else, so any task needing an assignee or a
due date still goes through the modal. Table mode has no add affordance at all,
and an empty list shows a hint that points at a button rather than an inline row.

## Goal

Creating a task never opens a modal. Editing a field never opens a modal. The
only floating surface left is a right-docked slide-over holding the task content
that cannot fit in a row: notes, subtasks, attachments, accounting fields.

ClickUp is the reference for all interaction decisions.

## Design

### 1. Inline new-task row (List view, `nice` mode)

`nlInlineAdd` is replaced. Clicking `＋ Add task` renders a row on the same
`--nl-cols` grid as the rows above it, so it aligns with the columns:

- a name `<input>` in the name column
- a strip of six field chips: assignee, due date, priority, status, department,
  vendor

Each chip opens the dropdown the existing rows already use — `nlAssigneeMenu`,
`nlDueMenu`, `nlPrioMenu`, `nlStatusMenu`, `nlDeptMenu`, `nlVendorMenu`. No new
pickers are written. A chip that has been set renders its value (avatar, date,
flag, pill) in place of its icon, so the pending task is legible before it is
saved.

The group the row was opened from pre-fills its own field via the existing
`field` / `key` arguments, plus `filterProject` when a project filter is active.

Keys:

- `Enter` — save, then reopen a blank row directly underneath with the field
  chips cleared and the group context kept, so several tasks can be typed
  without the mouse.
- `Escape` — close and discard.
- blur — save if the name is non-empty, otherwise close.

Fields outside the strip (notes, start date, subtasks, client, accounting) are
set afterwards in the slide-over.

#### Menu refactor

The six `nl*Menu` functions take a task id and mutate `tasks[]` directly. They
gain a second target: a draft object held in a module-level `nlDraft`. The seam
is a single `applyField(target, field, value)` helper — when `target` is a task
id it behaves as today; when it is the draft it writes to the draft and
re-renders the chip strip. The menus themselves are not duplicated.

### 2. Create entry points

| Entry point | Line | New behaviour |
| --- | --- | --- |
| Sidebar `+ Add task` | 1524 | Switch to List view, open the inline row at the bottom |
| `N` key | 9820 | Same |
| Projects list `+ Task` | 3557 | Open List filtered to that project, then the inline row |
| Kanban `+ Add task` | 5061, 5093 | Inline card at the bottom of the column: name only, the column's status or department applied, `Enter` saves and reopens |
| After creating a project | 9791 | Inline row |
| Empty state | 6102 | Renders an inline `＋ Add task` row; today an empty list has no inline path |

`openAddModal`, `openAddModalForProject` and `openAddModalForDept` survive as
named functions and become thin wrappers onto the inline row, so no call site
needs hunting down.

### 3. Table mode add row

`renderListTable` (todo.html:8980) gains a final `<tr>` whose first cell is a
name input. `Enter` creates the task and reopens the row. Table mode's cells are
already `<input>` / `<select>` bound through `setField`, so the remaining fields
are filled by tabbing across the row once it exists — no chip strip there.

### 4. Slide-over task detail

The `#task-modal` markup, `openEditModal` and `saveTask` are unchanged. Only the
shell moves:

- `.modal-overlay.slideover` — docked to the right (`left:auto`), no
  full-screen scrim, so the list behind stays visible and clickable.
- the `.modal` inside it — `width:440px`, full viewport height, square corners,
  a left border, entering on a transform transition.
- `openEditModal` adds the class. `Escape` and `×` close it.
- Clicking a row behind the panel switches the panel to that task instead of
  closing it.

The `⤢` row icon remains the way in. Clicking a task name still starts an inline
rename, unchanged — renaming is far more frequent than opening.

The other modals in the file (settings, new project, new user, and the rest) are
untouched.

## Out of scope

- Gantt view gets no add path; it has none today.
- No change to the Firestore documents, the Odoo sync, or `server.js`.
- No new fields on the task object.

## Success criteria

- No path from an empty state, a sidebar button, the `N` key, a kanban column,
  or a project row opens a centered modal to create a task.
- A task with a name, assignee, due date, priority, status, department and
  vendor can be created without leaving the list row.
- `Enter` in the inline row saves and reopens, so three tasks can be created
  with keyboard only.
- Opening an existing task docks a panel to the right with the list still
  usable, and clicking another row moves the panel to it.
