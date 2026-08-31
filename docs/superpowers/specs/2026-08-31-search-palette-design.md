# Search Palette + Task-List Column Filters — Design

Date: 2026-08-31 · Approved by Mario ("go")

## Scope
1. Ctrl+K search palette (ClickUp-style popup) searching everything.
2. Per-column search/filter row in the task List view (same pattern as the Project List table).
3. Toolbar cleanup: hide the "Filters" and "Options" popover buttons (superseded by 1+2, the status-chip row, and the group bar). The toolbar "Task…" live-filter box stays.

## 1. Search palette
- **Trigger:** Ctrl/Cmd+K anywhere; 🔍 button in the toolbar. Esc closes. Input auto-focused.
- **Shell:** reuses the modal-overlay pattern; ~620px panel, top-aligned.
- **Chips:** All · Tasks · Projects · Clients · People · Departments · Companies · Vendors, with match counts. Default All (grouped sections, max 5/group, "Show all N" activates the chip).
- **Rows:** icon + name + dim context (task rows: project + status pill), last-updated right-aligned.
- **Actions:**
  - Task → `openEditModal(id)`
  - Project → `openProjectTasks(p)`
  - Client → Clients view with search prefilled
  - Person / Department / Company → All Tasks with `onUserFilter` / `onDeptFilter` / `onCompanyFilter` applied (normal filter-chips bar shows and clears it)
  - Vendor → narrows the palette itself to that vendor's tasks (no global vendor filter exists)
- **Matching:** case-insensitive substring, in-memory. Tasks: title + notes + subtask text (archived excluded; done included, sorted last). Projects: name + client name. Ranking: starts-with > contains, then most recently updated.
- **Keyboard:** ↑/↓ highlight, Enter activates (first row pre-highlighted), Tab cycles chips.

## 2. Task-list column filter row
- One filter row pinned at the top of `.nl-wrap` (sticky, above the frozen header rows), one control per visible column, following column order/visibility/widths (`--nl-cols`).
- Text inputs: Name (title+notes), Project, Vendor, Due, Last-updated (matches updater name + date). Selects: Assignee, Department, Priority, Status (To Do / stages / Done), Company — each with All + (none).
- Applied inside `renderNiceList` only (Board/Gantt untouched; Table mode already has its own column filters).
- State in `nlColFilters`, persisted to localStorage like the Project List filters; ✕ clears all. Focus/caret preserved across re-renders.

## 3. Toolbar cleanup
- `filters-btn` and `options-btn` hidden (not deleted — their popover elements stay in the DOM because filter renderers and `show-done-btn` references depend on them).
- Known trade-off: the Overview-only buttons living in the Options popover (Hide tasks / Group by priority / Group by dept / Compact / Print) become unreachable; flagged to Mario.
