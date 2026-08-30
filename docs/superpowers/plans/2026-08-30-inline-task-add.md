# Inline Task Creation + Slide-Over Detail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Creating a task never opens a modal, and opening a task docks a slide-over panel to the right instead of a centered overlay.

**Architecture:** Everything lives in the single file `todo.html` (~496 KB, front end and styles inline). The pending new task is held in one module-level `nlDraft` object. The six existing field pickers are made draft-aware by swapping their `tasks.find(...)` lookup for a shared `nlFind(id)` helper — the pickers themselves are not duplicated. The slide-over reuses the existing `#task-modal` markup and `saveTask`, changing only the shell's CSS class.

**Tech Stack:** Vanilla JS + inline CSS in one HTML file; Node/Express (`server.js`) serves it on port 8081; Firestore for persistence via `scheduleSave()`. No build step, no bundler, no test framework.

## Global Constraints

- All work is in `D:\vscode\todo\todo.html`. Do not touch `server.js`, the Firestore schema, or the Odoo sync.
- No new fields on the task object. A task created inline has the same shape as one created by `saveTask`.
- No new dropdown/picker components. Reuse `nlAssigneeMenu`, `nlDueMenu`, `nlPrioMenu`, `nlStatusMenu`, `nlDeptMenu`, `nlVendorMenu`.
- ClickUp is the reference for every interaction decision.
- Match the surrounding code: 2-space indent, `nl*` prefix for List-view functions, template literals with inline `style="..."`, `esc()` / `escAttr()` on every interpolated value.
- The other modals in the file (settings, new project, new user) are untouched.
- **There is no test framework in this project.** Every task is verified by driving the running app in a browser via the Playwright MCP tools against `http://localhost:8081`. "Write the failing test" means "confirm the current behaviour is wrong in the browser, and record what you saw" — do that before editing, every time.

## Before Task 1: baseline commit

`todo.html`, `server.js` and `package.json` all have uncommitted changes predating this plan. Commit them first so the plan's own commits are clean and reviewable.

```bash
cd /d/vscode/todo
git add todo.html server.js package.json
git commit -m "chore: baseline before inline-task work"
```

Then start the app if it is not already running:

```bash
cd /d/vscode/todo && node server.js &
```

Confirm it answers: `curl -s -o /dev/null -w "%{http_code}" http://localhost:8081` → `200`

---

### Task 1: Draft-aware field pickers (`nlFind` seam)

The six pickers each begin `const t = tasks.find(x => x.id === id); if (!t) return;` and write through setters that call `scheduleSave()` + `renderAll()`. This task makes them resolve — and write to — a draft object when the id is the sentinel `__draft__`. No visible behaviour changes yet; this is the seam Task 2 builds on.

**Files:**
- Modify: `todo.html` — insert the seam just above `function nlDeptMenu` (line ~7214); edit `nlDeptMenu` (~7214), `nlPrioMenu` (~7323), `nlDueMenu` (~7333), `nlSetTaskField` (~7357), `nlVendorMenu` (~7396), `nlSetVendor` (~7417), `nlAssigneeMenu` (~7731), `nlRefreshAssignee` (~7752), `nlToggleAssignee` (~7760), `nlClearAssignees` (~7770), `nlNewAssignee` (~7778), `nlStatusMenu` (~7791), `nlSetStatus` (~7819)

**Interfaces:**
- Consumes: nothing.
- Produces, for Task 2:
  - `NL_DRAFT_ID` — the string `'__draft__'`
  - `nlDraft` — module-level `let`, either `null` or a partial task object carrying `id: NL_DRAFT_ID` plus any of `assignees`, `due`, `priority`, `taskStatus`, `department`, `partner`, `done`
  - `nlFind(id)` — returns the draft when `id === NL_DRAFT_ID`, else `tasks.find(x => x.id === id)`
  - `nlIsDraft(id)` — `id === NL_DRAFT_ID`
  - `nlDraftChanged()` — called by every setter after writing to the draft; Task 2 replaces its body to repaint the chip strip. In this task it is a no-op.

- [ ] **Step 1: Confirm the current behaviour in the browser**

Open `http://localhost:8081` in Playwright, go to the List view, and run in the page console:

```js
typeof nlFind
```

Expected: `"undefined"` — the seam does not exist yet. Record this.

- [ ] **Step 2: Add the seam**

Insert immediately above `function nlDeptMenu(e, id) {`:

```js
// ── The pending inline new task ───────────────────────────────────────────
// The list's field pickers all resolve their target with nlFind, so the same
// menus that edit a saved task also fill in a task that does not exist yet.
const NL_DRAFT_ID = '__draft__';
let nlDraft = null;
function nlIsDraft(id) { return id === NL_DRAFT_ID; }
function nlFind(id) {
  if (nlIsDraft(id)) return nlDraft;
  return tasks.find(x => x.id === id);
}
// Replaced in Task 2 by a repaint of the inline row's chip strip.
function nlDraftChanged() {}
```

- [ ] **Step 3: Point every picker at `nlFind`**

In each of `nlDeptMenu`, `nlPrioMenu`, `nlDueMenu`, `nlAssigneeMenu`, `nlStatusMenu`, replace:

```js
  const t = tasks.find(x => x.id === id);
```

with:

```js
  const t = nlFind(id);
```

`nlVendorMenu` takes `taskId`, not `id` — there it is:

```js
  const t = nlFind(taskId);
```

Leave every other `tasks.find` in the file alone. Verify the count:

```bash
grep -c "nlFind(" todo.html
```

Expected: at least 7 (the definition plus six call sites).

- [ ] **Step 4: Make the setters draft-aware**

`nlSetTaskField` — covers department, priority and due date:

```js
function nlSetTaskField(id, field, value) {
  closeOvMenu();
  const t = nlFind(id);
  if (!t || t[field] === value) return;
  t[field] = value;
  if (nlIsDraft(id)) { nlDraftChanged(); return; }
  scheduleSave();
  renderAll();
}
```

`nlSetVendor`:

```js
function nlSetVendor(taskId, subId, value) {
  closeOvMenu();
  if (subId) { setSubField(taskId, subId, 'partner', value); return; }
  const t = nlFind(taskId);
  if (!t) return;
  t.partner = value;
  if (nlIsDraft(taskId)) { nlDraftChanged(); return; }
  scheduleSave();
  if (typeof refreshPartnerDatalist === 'function') refreshPartnerDatalist();
  renderAll();
}
```

`nlSetStatus` — read the existing body first; it sets `done`/`doneAt` for the `__done__` value and `taskStatus` otherwise. Keep that logic exactly and change only the lookup and the tail:

```js
function nlSetStatus(id, val) {
  closeOvMenu();
  const t = nlFind(id);
  if (!t) return;
  if (val === '__done__') {
    t.done = true; t.doneAt = new Date().toISOString();
  } else {
    if (t.done) { t.done = false; t.doneAt = null; }
    t.taskStatus = val;
  }
  if (nlIsDraft(id)) { nlDraftChanged(); return; }
  scheduleSave();
  renderAll();
}
```

`nlRefreshAssignee` — the draft's cell is the chip strip, not a `.nl-c-assignee[data-task]` cell:

```js
function nlRefreshAssignee(t) {
  if (nlIsDraft(t.id)) {
    nlDraftChanged();
    const dm = document.getElementById('ov-prio-menu');
    if (dm && dm.dataset.task === t.id) dm.innerHTML = nlAssigneeItems(t);
    return;
  }
  const cell = document.querySelector(`.nl-c-assignee[data-task="${t.id}"]`);
  if (cell) cell.innerHTML = nlAssigneeCellInner(t);
  const m = document.getElementById('ov-prio-menu');
  if (m && m.dataset.task === t.id) m.innerHTML = nlAssigneeItems(t);
}
```

`nlToggleAssignee`, `nlClearAssignees`, `nlNewAssignee` — change their lookup to `nlFind(id)` and guard the save. For example:

```js
function nlToggleAssignee(e, id, userId) {
  e.stopPropagation();
  const t = nlFind(id);
  if (!t) return;
  if (!Array.isArray(t.assignees)) t.assignees = [];
  const i = t.assignees.indexOf(userId);
  if (i < 0) t.assignees.push(userId); else t.assignees.splice(i, 1);
  if (!nlIsDraft(id)) scheduleSave();
  nlRefreshAssignee(t);
}
```

Apply the same two changes (`nlFind`, `if (!nlIsDraft(id)) scheduleSave();`) to `nlClearAssignees` and `nlNewAssignee`. `nlNewAssignee` still calls `quickCreateUser` unconditionally — a person created there is a real user even if the task is still a draft.

- [ ] **Step 5: Verify in the browser that saved tasks still behave**

Reload the List view. Click a status pill, a date cell, a priority cell, a department cell, an assignee cell and a vendor cell on a real task; set a value in each. Expected: each one still writes through and the list repaints, exactly as before.

Then in the page console:

```js
nlDraft = { id: NL_DRAFT_ID, assignees: [] };
nlSetTaskField(NL_DRAFT_ID, 'priority', priorities[0].id);
nlDraft.priority === priorities[0].id && tasks.every(t => t.id !== NL_DRAFT_ID)
```

Expected: `true` — the draft took the value and nothing was written into `tasks`. Then reset: `nlDraft = null`.

- [ ] **Step 6: Commit**

```bash
git add todo.html
git commit -m "feat(list): make field pickers draft-aware via nlFind seam"
```

---

### Task 2: The inline new-task row

Replaces `nlInlineAdd` / `nlInlineKey` (todo.html:7833–7862), which today take a title and nothing else.

**Files:**
- Modify: `todo.html` — `nlInlineAdd` and `nlInlineKey` (~7833); `nlDraftChanged` (added in Task 1); the group branch and `flatHtml` of `renderNiceList` (~6724 and ~6757); the empty-state branch of the list renderer (~6097); CSS near `.nl-add` (~463)

**Interfaces:**
- Consumes: `NL_DRAFT_ID`, `nlDraft`, `nlFind`, `nlIsDraft`, `nlDraftChanged` from Task 1. Existing helpers `uid()`, `esc()`, `escAttr()`, `userById()`, `deptById()`, `priorityById()`, `taskStatusColor()`, `userAvatarHtml()`, `formatDate()`, `nlGridTemplate()`, `nlVisibleCols()`, `filterProject`, `scheduleSave()`, `renderTasks()`.
- Produces, for Tasks 3–5:
  - `nlOpenInlineAdd(field, key)` — opens the inline row for a group (`field` and `key` may be `''`). Returns nothing. Safe to call when the List view is already rendered.
  - `nlCommitDraft()` — writes `nlDraft` into `tasks[]`, calls `scheduleSave()`, returns the created task object, or `null` when the name is blank.

- [ ] **Step 1: Confirm the current behaviour in the browser**

In the List view, click `＋ Add task`. Expected today: a bare text input with no way to set an assignee, date, priority, status, department or vendor. Screenshot it — that is the "failing test".

- [ ] **Step 2: Replace `nlInlineAdd` and `nlInlineKey`**

Replace the whole block from the comment `// "＋ Add task" → inline input row` through the closing brace of `nlInlineKey` with:

```js
// "＋ Add task" → a live row on the list's own grid. The name is typed in
// place; the six chips beside it open the same pickers the saved rows use,
// so a task can be given an owner and a date before it exists.
let _nlAddCtx = null;            // { field, key } the row was opened from

function nlInlineAdd(e, field, key) {
  if (e && e.currentTarget) e.currentTarget.remove();
  nlOpenInlineAdd(field, key);
}

function nlOpenInlineAdd(field, key) {
  _nlAddCtx = { field: field || '', key: key || '' };
  nlDraft = {
    id: NL_DRAFT_ID,
    title: '',
    assignees: [],
    due: '',
    priority: '',
    taskStatus: field === 'taskstatus' ? (key || '') : '',
    department: field === 'dept' && key ? key : null,
    partner: '',
    done: false,
  };
  renderTasks();
  setTimeout(() => document.getElementById('nl-inline-input')?.focus(), 0);
}

function nlCloseInlineAdd() {
  nlDraft = null;
  _nlAddCtx = null;
  renderTasks();
}

// The six chips. A chip that has a value shows the value instead of its icon.
function nlDraftChipsHtml() {
  const d = nlDraft;
  if (!d) return '';
  const u = userById((d.assignees || [])[0]);
  const pr = priorityById(d.priority);
  const dep = deptById(d.department);
  const chip = (act, title, inner, set) => `
    <span class="nl-dchip ${set ? 'set' : ''}" onclick="${act}" title="${title}">${inner}</span>`;
  return `
    ${chip(`nlAssigneeMenu(event,'${NL_DRAFT_ID}')`, 'Assign', u ? userAvatarHtml(u, 'sm') : '👤', !!u)}
    ${chip(`nlDueMenu(event,'${NL_DRAFT_ID}')`, 'Due date', d.due ? '📅 ' + formatDate(d.due) : '📅', !!d.due)}
    ${chip(`nlPrioMenu(event,'${NL_DRAFT_ID}')`, 'Priority', pr ? `<span style="color:${pr.color};">⚑</span> ${esc(pr.name)}` : '⚑', !!pr)}
    ${chip(`nlStatusMenu(event,'${NL_DRAFT_ID}')`, 'Status',
        d.taskStatus ? `<span class="nl-status-pill" style="background:${taskStatusColor(d.taskStatus)};">${esc(d.taskStatus.toUpperCase())}</span>` : '◉', !!d.taskStatus)}
    ${chip(`nlDeptMenu(event,'${NL_DRAFT_ID}')`, 'Department',
        dep ? `<span class="nl-tag" style="background:${dep.color}22;color:${dep.color};">${esc(dep.name)}</span>` : '🏷', !!dep)}
    ${chip(`nlVendorMenu(event,'${NL_DRAFT_ID}',null)`, 'Vendor', d.partner ? esc(d.partner) : '🏢', !!d.partner)}`;
}

// One row on the list grid: name cell, then a blank cell per remaining column.
function nlDraftRowHtml() {
  const nCols = nlVisibleCols().length;
  return `
    <div class="nl-row nl-addrow" id="nl-inline-add">
      <span class="nl-c-name" style="gap:8px;">
        <span style="color:var(--accent);font-weight:700;">＋</span>
        <input id="nl-inline-input" class="nl-inline-input" type="text" autocomplete="off"
               placeholder="Task name — Enter to save, Esc to close"
               value="${escAttr(nlDraft.title || '')}"
               oninput="nlDraft && (nlDraft.title = this.value)"
               onkeydown="nlInlineKey(event)" onblur="nlInlineBlur()"
               onclick="event.stopPropagation()"
               style="flex:1;min-width:120px;">
        <span class="nl-dchips">${nlDraftChipsHtml()}</span>
      </span>
      ${Array.from({ length: Math.max(0, nCols - 1) }, () => '<span></span>').join('')}<span></span><span></span>
    </div>`;
}

// Repaint only the chips, so a picker can be used without losing the caret.
function nlDraftChanged() {
  const host = document.querySelector('#nl-inline-add .nl-dchips');
  if (host) host.innerHTML = nlDraftChipsHtml();
}

// Write the draft into tasks[]. Returns the new task, or null if unnamed.
// The shape matches listAddRow() exactly — same fields, same client lookup —
// so a task created here is indistinguishable from one added in Table mode.
function nlCommitDraft() {
  const d = nlDraft;
  if (!d) return null;
  const title = (d.title || '').trim();
  if (!title) return null;
  const ctx = _nlAddCtx || { field: '', key: '' };
  const proj = ctx.field === 'project' && ctx.key ? ctx.key : (filterProject !== 'All' ? filterProject : '');
  const t = {
    id: uid(),
    title,
    done: false,
    doneAt: null,
    createdAt: new Date().toISOString(),
    project: proj,
    taskStatus: d.taskStatus || '',
    department: d.department || null,
    priority: d.priority || '',
    due: d.due || '',
    partner: d.partner || '',
    notes: '',
    taskType: 'task',
    clientName: projectMeta[proj]?.clientName || '',
    clientId: projectMeta[proj]?.clientId || null,
    subtasks: [],
    assignees: [...(d.assignees || [])],
  };
  tasks.push(t);
  scheduleSave();
  return t;
}

function nlInlineKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); nlCloseInlineAdd(); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const ctx = _nlAddCtx || { field: '', key: '' };
  const t = nlCommitDraft();
  if (!t) { nlCloseInlineAdd(); return; }
  // Saved — reopen a blank row in the same group, so several tasks can be
  // typed without reaching for the mouse.
  nlOpenInlineAdd(ctx.field, ctx.key);
}

// Clicking away keeps a named task rather than discarding what was typed.
// Deferred, so clicking a chip (which steals focus) does not close the row.
function nlInlineBlur() {
  setTimeout(() => {
    if (!nlDraft) return;
    if (document.getElementById('ov-prio-menu')) return;   // a picker is open
    if (document.activeElement?.closest?.('#nl-inline-add')) return;
    if ((nlDraft.title || '').trim()) nlCommitDraft();
    nlCloseInlineAdd();
  }, 150);
}
```

- [ ] **Step 3: Draw the row from the renderer**

In `renderNiceList`, the group branch currently ends with:

```js
            `<div class="nl-add" onclick="nlInlineAdd(event,'${f}','${escAttr(String(k))}')">＋ Add task</div>`
```

Replace with:

```js
            ((nlDraft && _nlAddCtx && _nlAddCtx.field === f && _nlAddCtx.key === String(k))
              ? nlDraftRowHtml()
              : `<div class="nl-add" onclick="nlInlineAdd(event,'${f}','${escAttr(String(k))}')">＋ Add task</div>`)
```

And `flatHtml` currently ends with:

```js
    + `<div class="nl-add" onclick="nlInlineAdd(event,'','')">＋ Add task</div>`
```

Replace with:

```js
    + ((nlDraft && _nlAddCtx && !_nlAddCtx.field)
        ? nlDraftRowHtml()
        : `<div class="nl-add" onclick="nlInlineAdd(event,'','')">＋ Add task</div>`)
```

- [ ] **Step 4: Give the empty state an add row**

The empty branch (todo.html ~6097) returns early with a hint and no add affordance. Replace its body with:

```js
  if (filtered.length === 0) {
    el.innerHTML = `
      <div class="empty-state" style="padding-bottom:6px;">
        <div class="empty-icon">✓</div>
        <div>No tasks here</div>
      </div>
      <div class="nl-wrap" style="--nl-cols:${nlGridTemplate()};">
        ${nlDraft && _nlAddCtx && !_nlAddCtx.field
          ? nlDraftRowHtml()
          : `<div class="nl-add" onclick="nlInlineAdd(event,'','')">＋ Add task</div>`}
      </div>`;
    if (nlDraft) setTimeout(() => document.getElementById('nl-inline-input')?.focus(), 0);
    return;
  }
```

- [ ] **Step 5: Style the row and the chips**

Add after the `.nl-add:hover` rule:

```css
    .nl-addrow { background: var(--surface0); }
    .nl-addrow .nl-inline-input {
      background: transparent; border: 1px solid var(--accent); border-radius: 5px;
      color: var(--text); font-size: 0.8rem; font-family: inherit; padding: 3px 8px;
    }
    .nl-dchips { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .nl-dchip {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 6px; border-radius: 6px; cursor: pointer;
      font-size: 0.72rem; color: var(--overlay0);
      border: 1px dashed var(--surface1);
    }
    .nl-dchip:hover { color: var(--accent); border-color: var(--accent); background: var(--surface1); }
    .nl-dchip.set { color: var(--text); border-style: solid; }
```

- [ ] **Step 6: Verify in the browser**

Reload. In the List view:

1. Click `＋ Add task` → a row appears on the grid with a focused name box and six dashed chips.
2. Type `plan test A`, click the 👤 chip, pick a person → the chip shows their avatar and the name box still holds `plan test A`.
3. Click 📅 → Tomorrow. Click ⚑ → any priority.
4. Press `Enter` → the task appears in the list *with* that person, date and priority, and a fresh blank row is open underneath.
5. Type `plan test B`, press `Enter` → second task created, row reopens.
6. Press `Escape` → the row closes and no third task is created.
7. Reload the page → both tasks are still there with their fields (proves `scheduleSave` ran).
8. Group the list by Department, click `＋ Add task` under one department, save a task → it lands in that department.
9. Filter to a project with no tasks → the empty state shows an `＋ Add task` row that works.

Delete the test tasks afterwards.

- [ ] **Step 7: Commit**

```bash
git add todo.html
git commit -m "feat(list): inline new-task row with field chips, Enter saves and reopens"
```

---

### Task 3: Route the create entry points to the inline row

**Files:**
- Modify: `todo.html` — `openAddModal` (~9562), `openAddModalForProject` (~9539), `openAddModalForDept` (~5118)

**Interfaces:**
- Consumes: `nlOpenInlineAdd` from Task 2; existing `setView`, `currentView`, `filterProject`, `renderAll`.
- Produces: `nlStartAdd(proj)` — switches to the List view, applies `proj` as the project filter when given, and opens the inline row. Task 4 does not use it, but it is the single entry point for any future caller.

The sidebar button (line 1524), the `n` key handler (~9820), the projects-list `+ Task` button (~3557) and the post-project-create branch (~9791) all already call `openAddModal` / `openAddModalForProject`, so repointing those two functions repoints every one of them. Do not edit those four call sites.

- [ ] **Step 1: Confirm the current behaviour**

Click the sidebar `+ Add task`, then press `Escape`; press `N`. Expected today: the centered `New Task` modal opens both times. Screenshot it.

- [ ] **Step 2: Add the router and repoint the modal openers**

`openAddModal` and `openAddModalForProject` keep their names — many call sites use them — but stop opening the modal. Replace both functions with:

```js
// Creating a task is inline now. These names survive because call sites all
// over the file use them; they route into the list's inline row.
function nlStartAdd(proj) {
  if (proj && proj !== 'All') filterProject = proj;
  if (currentView !== 'list') setView('list');
  else renderAll();
  setTimeout(() => nlOpenInlineAdd('', ''), 0);
}
function openAddModal() { nlStartAdd(null); }
function openAddModalForProject(proj) { nlStartAdd(proj); }
```

Delete the old `openAddModal` body entirely — the block that clears `m-title`, `m-project`, `m-start`, `m-due`, `m-notes`, `m-client`, the partner fields, then calls `openModal('task-modal')`. `openEditModal` sits directly below it, still uses every one of those `m-*` fields, and is untouched: do not remove any `m-*` markup or any of the `renderModalDepts` / `renderModalAssignees` / `renderSubtaskList` helpers.

- [ ] **Step 3: Repoint `openAddModalForDept`**

It currently calls `openAddModalForProject` then pre-selects a department in the modal. Replace with:

```js
function openAddModalForDept(deptId) {
  if (currentView !== 'list') setView('list');
  setTimeout(() => nlOpenInlineAdd(deptId ? 'dept' : '', deptId || ''), 0);
}
```

- [ ] **Step 4: Verify in the browser**

1. Sidebar `+ Add task` from the Board view → lands in the List view with the inline row open, no modal.
2. Press `N` from the List view → inline row opens, no modal.
3. Projects list `+ Task` on a project → List view filtered to that project, inline row open; a task saved there gets that project.
4. Create a new project → ends in the List view with the inline row open.
5. Confirm no centered overlay appears at any point. In the console: `document.getElementById('task-modal').classList.contains('open')` → `false`.

- [ ] **Step 5: Commit**

```bash
git add todo.html
git commit -m "feat: route every create entry point to the inline row"
```

---

### Task 4: Inline card on the kanban board

**Files:**
- Modify: `todo.html` — the project-column add button (line ~5061) and the department-column add button (line ~5093); add the `kanban*` functions above `openAddModalForDept` (~5118)

**Interfaces:**
- Consumes: `uid()`, `scheduleSave()`, `renderAll()`, `escAttr()`, `filterProject`.
- Produces: nothing later tasks use.

Kanban gets a name-only card — no chip strip. The column supplies the project or the department; everything else is set afterwards in the List view or the slide-over.

- [ ] **Step 1: Confirm the current behaviour**

On the Board view, click a column's `+ Add task`. Expected after Task 3: it navigates away to the List view. Record that leaving the board is the thing being fixed.

- [ ] **Step 2: Add the kanban inline card**

Insert immediately above `function openAddModalForDept`:

```js
// A blank card at the foot of a column. The column supplies the project or the
// department; Enter saves and reopens so a column can be filled in one go.
let _kbAdd = null;   // { kind: 'project'|'dept', key }

function kanbanInlineAdd(kind, key) {
  _kbAdd = { kind, key: String(key || '') };
  renderAll();
  setTimeout(() => document.getElementById('kb-add-input')?.focus(), 0);
}
function kanbanAddCardHtml(kind, key) {
  if (!_kbAdd || _kbAdd.kind !== kind || _kbAdd.key !== String(key || '')) {
    return `<button class="kanban-add-btn" onclick="kanbanInlineAdd('${kind}','${escAttr(String(key || ''))}')">+ Add task</button>`;
  }
  return `
    <div class="kanban-card" style="border:1px solid var(--accent);">
      <input id="kb-add-input" type="text" autocomplete="off"
             placeholder="Task name — Enter to save, Esc to close"
             onkeydown="kanbanAddKey(event)" onblur="kanbanAddBlur()"
             style="width:100%;background:transparent;border:none;outline:none;color:var(--text);font-size:0.8rem;font-family:inherit;">
    </div>`;
}
function kanbanAddCommit(title) {
  const t = {
    id: uid(), title, done: false, doneAt: null,
    createdAt: new Date().toISOString(),
    project: _kbAdd.kind === 'project' ? _kbAdd.key : (filterProject !== 'All' ? filterProject : ''),
    taskStatus: '',
    department: _kbAdd.kind === 'dept' ? (_kbAdd.key || null) : null,
    priority: '', due: '', partner: '', subtasks: [], assignees: [],
  };
  tasks.push(t);
  scheduleSave();
  return t;
}
function kanbanAddKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); _kbAdd = null; renderAll(); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const title = e.target.value.trim();
  if (!title) { _kbAdd = null; renderAll(); return; }
  const ctx = _kbAdd;
  kanbanAddCommit(title);
  _kbAdd = ctx;                    // keep the column open for the next one
  renderAll();
  setTimeout(() => document.getElementById('kb-add-input')?.focus(), 0);
}
function kanbanAddBlur() {
  setTimeout(() => {
    const inp = document.getElementById('kb-add-input');
    if (!_kbAdd || !inp) return;
    const title = inp.value.trim();
    if (title) kanbanAddCommit(title);
    _kbAdd = null;
    renderAll();
  }, 150);
}
```

- [ ] **Step 3: Swap the two buttons for the card**

At line ~5061 replace:

```js
      <button class="kanban-add-btn" onclick="openAddModalForProject('${esc(col.name === '—' ? '' : col.name)}')">+ Add task</button>
```

with:

```js
      ${kanbanAddCardHtml('project', col.name === '—' ? '' : col.name)}
```

At line ~5093 replace:

```js
        <button class="kanban-add-btn" onclick="openAddModalForDept('${col.id}')">+ Add task</button>
```

with:

```js
        ${kanbanAddCardHtml('dept', col.id)}
```

- [ ] **Step 4: Verify in the browser**

1. Board view → a column's `+ Add task` becomes a card with a focused input; the board does not navigate away.
2. Type `kb test A`, `Enter` → the card appears in that column and the input reopens.
3. Type `kb test B`, `Enter` → second card in the same column.
4. `Escape` → input closes, no third card.
5. Switch to the List view → both tasks carry the column's project.
6. Repeat on the department board and confirm the department is set.

Delete the test tasks.

- [ ] **Step 5: Commit**

```bash
git add todo.html
git commit -m "feat(board): inline add card at the foot of each kanban column"
```

---

### Task 5: Slide-over task detail

**Files:**
- Modify: `todo.html` — `.modal-overlay` / `.modal` CSS (~842–864); `openEditModal` (~9598); `closeModalById` (~9798)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing.

`#task-modal`'s markup, its form fields and `saveTask` are unchanged. Only the shell moves.

- [ ] **Step 1: Confirm the current behaviour**

Click a row's `⤢`. Expected today: a centered overlay with a dark scrim; the list behind is dimmed and unclickable. Screenshot it.

- [ ] **Step 2: Add the slide-over styles**

Insert after the `.modal-close:hover` rule:

```css
    /* Opening a task docks a panel to the right; the list stays usable. */
    .modal-overlay.slideover {
      left: auto; right: 0; background: none;
      align-items: stretch; justify-content: flex-end;
      pointer-events: none;
    }
    .modal-overlay.slideover .modal {
      pointer-events: auto;
      width: 440px; max-width: 96vw; height: 100vh; max-height: 100vh;
      border-radius: 0; border: none; border-left: 1px solid var(--surface1);
      box-shadow: -12px 0 40px rgba(0,0,0,0.45);
      animation: nl-slide-in 0.16s ease-out;
    }
    @keyframes nl-slide-in {
      from { transform: translateX(24px); opacity: 0.6; }
      to   { transform: none; opacity: 1; }
    }
```

`pointer-events: none` on the overlay is what keeps the list behind clickable; the panel itself turns them back on.

- [ ] **Step 3: Open it as a slide-over**

In `openEditModal`, the final line is `openModal('task-modal');`. Replace with:

```js
  document.getElementById('task-modal').classList.add('slideover');
  openModal('task-modal');
```

And in `closeModalById`, drop the class on the way out so nothing else inherits it:

```js
function closeModalById(id) {
  const el = document.getElementById(id);
  el.classList.remove('open');
  el.classList.remove('slideover');
}
```

- [ ] **Step 4: Let a click behind the panel switch tasks**

`onOverlayClick` closes the modal when the backdrop is clicked. With `pointer-events: none` the backdrop no longer receives clicks at all, so that handler simply never fires for the slide-over — leave it as is for the other modals.

Clicking a row's `⤢` while the panel is open already calls `openEditModal` again, which repopulates the same panel. Verify that in the browser rather than writing new code. If the panel is left showing the previous task's values, add this immediately after the `if (!t) return;` guard at the top of `openEditModal`, so switching tasks does not silently drop edits in progress:

```js
  if (editingId && editingId !== id) saveTask();
```

- [ ] **Step 5: Verify in the browser**

1. Click a row's `⤢` → a panel docks to the right edge, full height, no dark scrim.
2. The list on the left is still readable and its cells still respond to clicks.
3. Edit the notes, click `Save` → the change persists after a reload.
4. Click a different row's `⤢` while the panel is open → the panel switches to that task.
5. `×` closes it. Reopen and press `Escape` → it closes.
6. Open the Settings modal → it is still a centered overlay with a scrim, unaffected.

- [ ] **Step 6: Commit**

```bash
git add todo.html
git commit -m "feat: dock the task detail as a right slide-over instead of a centered modal"
```

---

## Final verification

Walk the spec's success criteria end to end in one pass:

- [ ] No path from the empty state, the sidebar button, the `N` key, a kanban column, or a projects-list row opens a centered modal to create a task.
- [ ] A task with a name, assignee, due date, priority, status, department and vendor can be created without leaving the list row.
- [ ] `Enter` in the inline row saves and reopens; three tasks can be created keyboard-only.
- [ ] Opening an existing task docks a panel to the right with the list still usable, and clicking another row's `⤢` moves the panel to it.
- [ ] Reload the page and confirm everything created during the pass survived.
- [ ] Delete every test task created along the way.
