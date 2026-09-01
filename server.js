const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// Initialize Firebase Admin
let serviceAccount;
try {
  // Try to read from environment variable first (Render)
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else {
    // Fall back to file (local development)
    serviceAccount = JSON.parse(fs.readFileSync(path.join(__dirname, 'firebase-service-account.json'), 'utf8'));
  }
} catch (e) {
  console.error('Failed to load Firebase credentials:', e.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id
});

const db = admin.firestore();
const auth = admin.auth();

// ── Odoo JSON-RPC (credentials in %USERPROFILE%/.odoo-creds.json) ──
const os = require('os');
let odooCreds = null, odooUid = null;
function loadOdooCreds() {
  if (!odooCreds) {
    if (process.env.ODOO_CREDS_JSON) {          // cloud (Render/Vercel)
      odooCreds = JSON.parse(process.env.ODOO_CREDS_JSON);
    } else {                                     // local file
      const raw = fs.readFileSync(path.join(os.homedir(), '.odoo-creds.json'), 'utf8');
      odooCreds = JSON.parse(raw.replace(/^﻿/, ''));
    }
  }
  return odooCreds;
}
async function odooRpc(service, method, args) {
  const creds = loadOdooCreds();
  const res = await fetch(`${creds.url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args } })
  });
  const data = await res.json();
  if (data.error) {
    const d = data.error.data || {};
    throw new Error(`Odoo: ${d.message || data.error.message}`);
  }
  return data.result;
}
async function odooCall(model, method, args = [], kwargs = {}) {
  const creds = loadOdooCreds();
  if (!odooUid) {
    odooUid = await odooRpc('common', 'authenticate', [creds.db, creds.username, creds.apiKey, {}]);
    if (!odooUid) throw new Error('Odoo authentication failed');
  }
  return odooRpc('object', 'execute_kw', [creds.db, odooUid, creds.apiKey, model, method, args, kwargs]);
}

const PORT = process.env.PORT || 8081;

// Single shared team workspace — everyone who signs in works on the same board.
const TEAM_ID = process.env.TEAM_ID || 'team';  // override for an isolated sandbox board

// ═══════════════════════════════════════════════════════════════════════════
// Odoo ⇄ App sync engine — shared by the dry-run (plan) and execute endpoints.
// direction: 'pull' (Odoo→App), 'push' (App→Odoo), 'both' (most-recent wins).
// Nothing here runs automatically; only the /odoo-sync-* endpoints call it.
// ═══════════════════════════════════════════════════════════════════════════
const SYNC_SKIP = new Set(['internal', 'database template']);
const nk = s => (s || '').toString().trim().toLowerCase();
const odooTs = s => s ? new Date(String(s).replace(' ', 'T') + 'Z').getTime() : 0;
const appTs  = s => s ? new Date(s).getTime() : 0;

async function fetchOdooState() {
  const [projects, clients, tasks] = await Promise.all([
    odooCall('project.project', 'search_read', [[['active', '=', true]]],
      { fields: ['name', 'company_id', 'partner_id', 'write_date'] }),
    odooCall('res.partner', 'search_read', [[['customer_rank', '>', 0]]],
      { fields: ['name', 'email', 'phone', 'write_date'] }),
    odooCall('project.task', 'search_read', [[['active', '=', true]]],
      { fields: ['name', 'project_id', 'state', 'date_deadline', 'partner_id', 'priority', 'create_date', 'write_date', 'stage_id'] }),
  ]);
  return { projects, clients, tasks };
}

async function fetchAppState() {
  const base = db.collection('workspaces').doc(TEAM_ID);
  const [p, c, t] = await Promise.all([
    base.collection('projects').get(),
    base.collection('clients').get(),
    base.collection('tasks').get(),
  ]);
  return {
    projects: p.docs.map(d => ({ _id: d.id, ...d.data() })),
    clients:  c.docs.map(d => ({ _id: d.id, ...d.data() })),
    tasks:    t.docs.map(d => ({ _id: d.id, ...d.data() })),
  };
}

// Read-only: figure out every create/update each direction would perform.
function computeSyncPlan(direction, odoo, app) {
  const doPull = direction === 'pull' || direction === 'both';
  const doPush = direction === 'push' || direction === 'both';

  const odooProjByName = new Map(odoo.projects.filter(p => !SYNC_SKIP.has(nk(p.name))).map(p => [nk(p.name), p]));
  const odooProjById   = new Map(odoo.projects.map(p => [p.id, p]));
  const odooCliByName  = new Map(odoo.clients.map(c => [nk(c.name), c]));
  const odooTaskById   = new Map(odoo.tasks.map(t => [t.id, t]));
  const appProjByName  = new Map(app.projects.map(p => [nk(p.name || p._id), p]));
  const appTaskByOdoo  = new Map(app.tasks.filter(t => t.odooId).map(t => [t.odooId, t]));

  const ops = { pullProjects: [], pullClients: 0, pullTasks: [], pushProjects: [], pushClients: [], pushTasks: [], updateOdooTasks: [] };

  if (doPull) {
    for (const p of odoo.projects) {
      if (SYNC_SKIP.has(nk(p.name))) continue;
      const ap = appProjByName.get(nk(p.name));
      if (!ap) ops.pullProjects.push({ name: p.name.trim(), action: 'create' });
      else if (!ap.odooId) ops.pullProjects.push({ name: p.name.trim(), action: 'link' });
    }
    ops.pullClients = odoo.clients.length;
    for (const t of odoo.tasks) {
      const rawProj = t.project_id ? t.project_id[1].trim() : '';
      if (SYNC_SKIP.has(nk(rawProj))) continue;
      const existing = appTaskByOdoo.get(t.id);
      if (direction === 'both' && existing && odooTs(t.write_date) <= appTs(existing.updatedAt || existing.createdAt)) continue;
      ops.pullTasks.push({ odooId: t.id, action: existing ? 'update' : 'create', title: t.name });
    }
  }

  if (doPush) {
    for (const ap of app.projects) {
      const nm = (ap.name || ap._id || '').trim();
      if (!nm || SYNC_SKIP.has(nk(nm))) continue;
      const matched = ap.odooId ? odooProjById.get(ap.odooId) : odooProjByName.get(nk(nm));
      if (!matched) ops.pushProjects.push({ appId: ap._id, name: nm });
    }
    const appClientNames = new Set();
    app.projects.forEach(p => { if (p.clientName) appClientNames.add(p.clientName.trim()); });
    app.tasks.forEach(t => { if (t.clientName) appClientNames.add(t.clientName.trim()); });
    for (const nm of appClientNames) {
      if (nm && !odooCliByName.has(nk(nm))) ops.pushClients.push({ name: nm });
    }
    for (const t of app.tasks) {
      if (t.archived) continue;
      if (!t.odooId && !String(t._id).startsWith('odoo-')) {
        if ((t.project || '').trim()) ops.pushTasks.push({ appId: t._id, title: t.title, project: t.project });
      } else if (t.odooId) {
        const ot = odooTaskById.get(t.odooId);
        if (!ot) continue;
        if (direction === 'both' && appTs(t.updatedAt || t.createdAt) <= odooTs(ot.write_date)) continue;
        const changes = {};
        if ((t.title || '') !== (ot.name || '')) changes.name = t.title;
        const appDue = t.due || '', odDue = ot.date_deadline ? String(ot.date_deadline).slice(0, 10) : '';
        if (appDue !== odDue) changes.date_deadline = appDue || false;
        const appPrio = t.priority === 'high' ? '1' : '0';
        if (appPrio !== (ot.priority || '0')) changes.priority = appPrio;
        const appDone = !!t.done, odDone = ot.state === '1_done';
        if (appDone !== odDone) changes.state = appDone ? '1_done' : '01_in_progress';
        if (Object.keys(changes).length) ops.updateOdooTasks.push({ odooId: t.odooId, title: t.title, changes });
      }
    }
  }

  const summary = {
    direction,
    pull: doPull ? {
      projectsCreate: ops.pullProjects.filter(p => p.action === 'create').length,
      projectsLink:   ops.pullProjects.filter(p => p.action === 'link').length,
      clients:        ops.pullClients,
      tasksCreate:    ops.pullTasks.filter(t => t.action === 'create').length,
      tasksUpdate:    ops.pullTasks.filter(t => t.action === 'update').length,
    } : null,
    push: doPush ? {
      projectsCreate: ops.pushProjects.length,
      clientsCreate:  ops.pushClients.length,
      tasksCreate:    ops.pushTasks.length,
      tasksUpdate:    ops.updateOdooTasks.length,
    } : null,
    details: {
      pushProjects: ops.pushProjects.slice(0, 60),
      pushClients:  ops.pushClients.slice(0, 60),
      pushTasksCreate: ops.pushTasks.slice(0, 60).map(t => ({ title: t.title, project: t.project })),
      pushTasksUpdate: ops.updateOdooTasks.slice(0, 60).map(t => ({ title: t.title, fields: Object.keys(t.changes) })),
    },
  };
  return { ops, summary };
}

// Odoo → App writer (Firestore). 'both' skips tasks the app edited more recently.
async function applyPull(direction, odoo, app) {
  const base = db.collection('workspaces').doc(TEAM_ID);
  const col = base.collection('projects');
  const existingByName = new Map(app.projects.map(p => [nk(p.name || p._id), col.doc(p._id)]));

  const batch = db.batch();
  const added = [];
  for (const p of odoo.projects) {
    const name = (p.name || '').trim(), key = nk(name);
    if (SYNC_SKIP.has(key)) continue;
    const client = p.partner_id ? { clientId: p.partner_id[0], clientName: p.partner_id[1] } : {};
    const ref = existingByName.get(key);
    if (ref) { batch.set(ref, { odooId: p.id, ...client }, { merge: true }); continue; }
    const newRef = col.doc(name);
    existingByName.set(key, newRef);
    batch.set(newRef, { name, status: 'active', odooId: p.id, ...client, ...(p.company_id ? { odooCompany: p.company_id[1] } : {}) });
    added.push(name);
  }
  await batch.commit();

  const clientsCol = base.collection('clients');
  const clientBatch = db.batch();
  for (const c of odoo.clients) {
    clientBatch.set(clientsCol.doc(String(c.id)), { id: String(c.id), odooId: c.id, name: c.name, email: c.email || '', phone: c.phone || '' }, { merge: true });
  }
  await clientBatch.commit();

  const canonicalName = new Map();
  for (const [key, ref] of existingByName) canonicalName.set(key, ref.id);
  const appTaskByOdoo = new Map(app.tasks.filter(t => t.odooId).map(t => [t.odooId, t]));

  const tasksCol = base.collection('tasks');
  const taskBatch = db.batch();
  const stageNames = new Set();
  let taskCount = 0;
  for (const t of odoo.tasks) {
    const rawProj = t.project_id ? t.project_id[1].trim() : '';
    if (SYNC_SKIP.has(nk(rawProj))) continue;
    const existing = appTaskByOdoo.get(t.id);
    if (direction === 'both' && existing && odooTs(t.write_date) <= appTs(existing.updatedAt || existing.createdAt)) continue;
    const project = canonicalName.get(nk(rawProj)) || rawProj;
    const done = t.state === '1_done';
    const stage = t.stage_id ? t.stage_id[1] : '';
    if (stage) stageNames.add(stage);
    taskBatch.set(tasksCol.doc(`odoo-${t.id}`), {
      id: `odoo-${t.id}`, odooId: t.id, workspaceId: TEAM_ID, title: t.name, project,
      due: t.date_deadline ? String(t.date_deadline).slice(0, 10) : '',
      done, doneAt: done ? new Date().toISOString() : null,
      createdAt: t.create_date ? new Date(String(t.create_date).replace(' ', 'T') + 'Z').toISOString() : new Date().toISOString(),
      priority: t.priority === '1' ? 'high' : '',
      taskStatus: stage,
      ...(t.partner_id ? { clientId: t.partner_id[0], clientName: t.partner_id[1] } : {})
    }, { merge: true });
    taskCount++;
  }
  await taskBatch.commit();

  const tsCol = base.collection('taskstatuses');
  const tsColors = ['#89b4fa', '#f9e2af', '#fab387', '#a6e3a1', '#cba6f7', '#94e2d5', '#f38ba8', '#f5c2e7'];
  const tsBatch = db.batch();
  let i = 0;
  for (const nm of stageNames) {
    const id = nm.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ts-' + (i + 1);
    tsBatch.set(tsCol.doc(id), { id, name: nm, color: tsColors[i % tsColors.length] }, { merge: true });
    i++;
  }
  if (stageNames.size) await tsBatch.commit();

  return { added, projects: added.length, clients: odoo.clients.length, tasks: taskCount, stages: stageNames.size };
}

// App → Odoo writer + optional pull. Push runs first so new Odoo ids flow back.
async function executeSyncPlan(direction, odoo, app) {
  const doPull = direction === 'pull' || direction === 'both';
  const doPush = direction === 'push' || direction === 'both';
  const base = db.collection('workspaces').doc(TEAM_ID);
  const result = { push: null, pull: null };
  const { ops } = computeSyncPlan(direction, odoo, app);

  if (doPush) {
    const pushed = { projects: 0, clients: 0, tasksCreate: 0, tasksUpdate: 0 };
    const newProjIdByName = new Map();
    for (const p of ops.pushProjects) {
      const id = await odooCall('project.project', 'create', [{ name: p.name }]);
      newProjIdByName.set(nk(p.name), id);
      await base.collection('projects').doc(p.appId).set({ odooId: id }, { merge: true });
      pushed.projects++;
    }
    const newCliIdByName = new Map();
    for (const c of ops.pushClients) {
      const id = await odooCall('res.partner', 'create', [{ name: c.name, customer_rank: 1 }]);
      newCliIdByName.set(nk(c.name), id);
      pushed.clients++;
    }
    const projOdooId = new Map();
    app.projects.forEach(ap => { if (ap.odooId) projOdooId.set(nk(ap.name || ap._id), ap.odooId); });
    odoo.projects.forEach(op => projOdooId.set(nk(op.name), op.id));
    newProjIdByName.forEach((id, key) => projOdooId.set(key, id));
    const cliOdooId = new Map();
    odoo.clients.forEach(oc => cliOdooId.set(nk(oc.name), oc.id));
    newCliIdByName.forEach((id, key) => cliOdooId.set(key, id));

    for (const t of ops.pushTasks) {
      const pid = projOdooId.get(nk(t.project));
      if (!pid) continue;   // project couldn't be created/resolved → skip its tasks
      const at = app.tasks.find(x => x._id === t.appId) || {};
      const vals = {
        name: t.title, project_id: pid, date_deadline: at.due || false,
        priority: at.priority === 'high' ? '1' : '0',
        state: at.done ? '1_done' : '01_in_progress',
      };
      const cli = at.clientName ? cliOdooId.get(nk(at.clientName)) : null;
      if (cli) vals.partner_id = cli;
      const newId = await odooCall('project.task', 'create', [vals]);
      await base.collection('tasks').doc(t.appId).set({ odooId: newId }, { merge: true });
      pushed.tasksCreate++;
    }
    for (const u of ops.updateOdooTasks) {
      await odooCall('project.task', 'write', [[u.odooId], u.changes]);
      pushed.tasksUpdate++;
    }
    result.push = pushed;
  }

  if (doPull) {
    const odoo2 = doPush ? await fetchOdooState() : odoo;
    const app2  = doPush ? await fetchAppState()  : app;
    result.pull = await applyPull(direction, odoo2, app2);
  }
  return result;
}

async function ensureTeamMember(user) {
  const wsRef = db.collection('workspaces').doc(TEAM_ID);
  const wsDoc = await wsRef.get();
  const member = {
    uid: user.uid,
    email: user.email || '',
    name: user.name || user.email || 'User',
    role: 'member'
  };
  if (!wsDoc.exists) {
    await wsRef.set({
      id: TEAM_ID,
      name: 'Shift Team',
      type: 'shared',
      createdAt: new Date().toISOString(),
      members: [{ ...member, role: 'owner' }]
    });
    return;
  }
  const members = wsDoc.data().members || [];
  if (!members.some(m => m.uid === user.uid)) {
    await wsRef.update({
      members: admin.firestore.FieldValue.arrayUnion(member)
    });
  }
}

// Local mode: no sign-in required. Auth is enforced automatically when the app
// runs on Render (RENDER env var is set there), or when REQUIRE_AUTH=1 is set.
// Sign-in is enforced on any cloud host (Render, Vercel) and can be forced locally
const AUTH_DISABLED = !process.env.RENDER && !process.env.VERCEL && process.env.REQUIRE_AUTH !== '1';

// Auth middleware: verify Firebase ID token
async function verifyToken(req) {
  if (AUTH_DISABLED) {
    return { uid: 'local-user', email: 'local@shift', name: 'Mario' };
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7);
  try {
    const decodedToken = await auth.verifyIdToken(token);
    return decodedToken;
  } catch (e) {
    console.error('Token verification failed:', e.message);
    return null;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const handler = async (req, res) => {
  const url = req.url.split('?')[0];

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,PUT,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Public endpoints (no auth required)
  if (url === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'todo.html'), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(html);
    return;
  }

  // Static files
  if (!url.startsWith('/api/')) {
    const filePath = path.join(__dirname, url);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const contentType = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
    return;
  }

  // Public: tells the client whether sign-in is required
  if (url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authDisabled: AUTH_DISABLED }));
    return;
  }

  // All API endpoints require auth
  const user = await verifyToken(req);
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const userId = user.uid;

  // ═══════════════════════════════════════════════════════════════
  // WORKSPACES
  // ═══════════════════════════════════════════════════════════════

  if (url === '/api/workspaces' && req.method === 'GET') {
    try {
      await ensureTeamMember(user);
      const wsDoc = await db.collection('workspaces').doc(TEAM_ID).get();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ id: TEAM_ID, ...wsDoc.data() }]));
    } catch (e) {
      console.error('GET /api/workspaces error:', e);
      res.writeHead(500);
      res.end('server error');
    }
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // TASKS (workspace-scoped)
  // ═══════════════════════════════════════════════════════════════

  const tasksMatch = url.match(/^\/api\/workspaces\/([^\/]+)\/tasks$/);
  if (tasksMatch && req.method === 'GET') {
    const workspaceId = TEAM_ID;
    try {
      const tasksSnap = await db.collection('workspaces').doc(workspaceId)
        .collection('tasks').orderBy('createdAt', 'desc').get();
      const tasks = tasksSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tasks));
    } catch (e) {
      console.error('GET tasks error:', e);
      res.writeHead(500);
      res.end('server error');
    }
    return;
  }

  if (tasksMatch && req.method === 'POST') {
    const workspaceId = TEAM_ID;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const tasks = JSON.parse(body);
        const batch = db.batch();
        const col = db.collection('workspaces').doc(workspaceId).collection('tasks');

        for (const task of tasks) {
          batch.set(col.doc(task.id), { ...task, workspaceId });
        }

        // The client sends the full task list — remove docs that are no longer in it
        const keep = new Set(tasks.map(t => t.id));
        const existing = await col.listDocuments();
        for (const docRef of existing) {
          if (!keep.has(docRef.id)) batch.delete(docRef);
        }

        await batch.commit();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: tasks.length }));
      } catch (e) {
        console.error('POST tasks error:', e);
        res.writeHead(400);
        res.end('bad request');
      }
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // PROJECTS (workspace-scoped)
  // ═══════════════════════════════════════════════════════════════

  const projectsMatch = url.match(/^\/api\/workspaces\/([^\/]+)\/projects$/);
  if (projectsMatch && req.method === 'GET') {
    const workspaceId = TEAM_ID;
    try {
      const projectsSnap = await db.collection('workspaces').doc(workspaceId)
        .collection('projects').get();
      const projects = {};
      projectsSnap.docs.forEach(doc => {
        projects[doc.data().name] = doc.data();
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(projects));
    } catch (e) {
      console.error('GET projects error:', e);
      res.writeHead(500);
      res.end('server error');
    }
    return;
  }

  if (projectsMatch && req.method === 'POST') {
    const workspaceId = TEAM_ID;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const projectMeta = JSON.parse(body);
        const batch = db.batch();
        const col = db.collection('workspaces').doc(workspaceId).collection('projects');

        for (const [name, data] of Object.entries(projectMeta)) {
          batch.set(col.doc(name), { name, ...data });
        }

        const keep = new Set(Object.keys(projectMeta));
        const existing = await col.listDocuments();
        for (const docRef of existing) {
          if (!keep.has(docRef.id)) batch.delete(docRef);
        }

        await batch.commit();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('POST projects error:', e);
        res.writeHead(400);
        res.end('bad request');
      }
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // ODOO SYNC — pull Odoo project list into the app's projects
  // ═══════════════════════════════════════════════════════════════

  if (url.match(/^\/api\/workspaces\/[^\/]+\/sync-odoo-projects$/) && req.method === 'POST') {
    try {
      const odooProjects = await odooCall('project.project', 'search_read',
        [[['active', '=', true]]], { fields: ['name', 'company_id', 'partner_id'] });

      const col = db.collection('workspaces').doc(TEAM_ID).collection('projects');
      const existingSnap = await col.get();
      // match case-insensitively so "Ajaltoun" doesn't duplicate "AJALTOUN"
      const existingByName = new Map(existingSnap.docs.map(d => [(d.data().name || d.id).trim().toLowerCase(), d.ref]));

      const skipNames = new Set(['internal', 'database template']);
      const batch = db.batch();
      const added = [];
      for (const p of odooProjects) {
        const name = p.name.trim();
        const key = name.toLowerCase();
        if (skipNames.has(key)) continue;
        const client = p.partner_id ? { clientId: p.partner_id[0], clientName: p.partner_id[1] } : {};
        const existingRef = existingByName.get(key);
        if (existingRef) {
          // refresh the Odoo link + customer on already-known projects
          batch.set(existingRef, { odooId: p.id, ...client }, { merge: true });
          continue;
        }
        existingByName.set(key, col.doc(name));
        batch.set(col.doc(name), {
          name,
          status: 'active',
          odooId: p.id,
          ...client,
          ...(p.company_id ? { odooCompany: p.company_id[1] } : {})
        });
        added.push(name);
      }
      await batch.commit();

      // Clients: mirror Odoo customers into the 'clients' collection (odoo id = doc id)
      const odooClients = await odooCall('res.partner', 'search_read',
        [[['customer_rank', '>', 0]]], { fields: ['name', 'email', 'phone'] });
      const clientsCol = db.collection('workspaces').doc(TEAM_ID).collection('clients');
      const clientBatch = db.batch();
      for (const c of odooClients) {
        clientBatch.set(clientsCol.doc(String(c.id)), {
          id: String(c.id),
          odooId: c.id,
          name: c.name,
          email: c.email || '',
          phone: c.phone || ''
        });
      }
      await clientBatch.commit();

      // Tasks: mirror Odoo tasks (doc id "odoo-<id>"); merge so app-side extras
      // (assignees, notes, department, subtasks) survive re-syncs. Odoo wins on
      // title/project/due/done/client.
      const canonicalName = new Map();  // lower-cased name → exact app project name
      for (const [key, ref] of existingByName) canonicalName.set(key, ref.id);

      const odooTasks = await odooCall('project.task', 'search_read',
        [[['active', '=', true]]],
        { fields: ['name', 'project_id', 'state', 'date_deadline', 'partner_id', 'priority', 'create_date', 'stage_id'] });

      const tasksCol = db.collection('workspaces').doc(TEAM_ID).collection('tasks');
      const taskBatch = db.batch();
      const stageNames = new Set();   // collect distinct Odoo task stages
      let taskCount = 0;
      for (const t of odooTasks) {
        const rawProj = t.project_id ? t.project_id[1].trim() : '';
        if (skipNames.has(rawProj.toLowerCase())) continue;
        const project = canonicalName.get(rawProj.toLowerCase()) || rawProj;
        const done = t.state === '1_done';
        const stage = t.stage_id ? t.stage_id[1] : '';
        if (stage) stageNames.add(stage);
        taskBatch.set(tasksCol.doc(`odoo-${t.id}`), {
          id: `odoo-${t.id}`,
          odooId: t.id,
          workspaceId: TEAM_ID,
          title: t.name,
          project,
          due: t.date_deadline ? String(t.date_deadline).slice(0, 10) : '',
          done,
          doneAt: done ? new Date().toISOString() : null,
          createdAt: t.create_date
            ? new Date(String(t.create_date).replace(' ', 'T') + 'Z').toISOString()
            : new Date().toISOString(),
          priority: t.priority === '1' ? 'high' : '',
          taskStatus: stage,
          ...(t.partner_id ? { clientId: t.partner_id[0], clientName: t.partner_id[1] } : {})
        }, { merge: true });
        taskCount++;
      }
      await taskBatch.commit();

      // Mirror the distinct Odoo task stages into a 'taskstatuses' collection
      const tsCol = db.collection('workspaces').doc(TEAM_ID).collection('taskstatuses');
      const tsColors = ['#89b4fa', '#f9e2af', '#fab387', '#a6e3a1', '#cba6f7', '#94e2d5', '#f38ba8', '#f5c2e7'];
      const tsBatch = db.batch();
      let i = 0;
      for (const nm of stageNames) {
        const id = nm.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ts-' + (i + 1);
        tsBatch.set(tsCol.doc(id), { id, name: nm, color: tsColors[i % tsColors.length] }, { merge: true });
        i++;
      }
      if (stageNames.size) await tsBatch.commit();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, added, total: odooProjects.length, clients: odooClients.length, tasks: taskCount, taskStages: stageNames.size }));
    } catch (e) {
      console.error('sync-odoo-projects error:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Two-way sync: push done/undone to Odoo
  if (url.match(/^\/api\/workspaces\/[^\/]+\/odoo-task-state$/) && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { odooId, done } = JSON.parse(body);
        await odooCall('project.task', 'write',
          [[odooId], { state: done ? '1_done' : '01_in_progress' }]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('odoo-task-state error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Two-way sync: create a new task in Odoo (returns the new Odoo id)
  if (url.match(/^\/api\/workspaces\/[^\/]+\/odoo-task-create$/) && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { title, projectOdooId, due, priority, clientId } = JSON.parse(body);
        const vals = {
          name: title,
          project_id: projectOdooId,
          date_deadline: due || false,
          priority: priority === 'high' ? '1' : '0',
          ...(clientId ? { partner_id: clientId } : {})
        };
        const newId = await odooCall('project.task', 'create', [vals]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, odooId: newId }));
      } catch (e) {
        console.error('odoo-task-create error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Directional sync — dry run: report every change without writing anything.
  if (url.match(/^\/api\/workspaces\/[^\/]+\/odoo-sync-plan$/) && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { direction } = JSON.parse(body || '{}');
        if (!['pull', 'push', 'both'].includes(direction)) throw new Error('invalid direction');
        const [odoo, app] = await Promise.all([fetchOdooState(), fetchAppState()]);
        const { summary } = computeSyncPlan(direction, odoo, app);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, summary }));
      } catch (e) {
        console.error('odoo-sync-plan error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Directional sync — execute (only after the user confirmed the plan).
  if (url.match(/^\/api\/workspaces\/[^\/]+\/odoo-sync-run$/) && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { direction } = JSON.parse(body || '{}');
        if (!['pull', 'push', 'both'].includes(direction)) throw new Error('invalid direction');
        const [odoo, app] = await Promise.all([fetchOdooState(), fetchAppState()]);
        const result = await executeSyncPlan(direction, odoo, app);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (e) {
        console.error('odoo-sync-run error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // REFERENCE DATA (departments, statuses, companies, priorities)
  // ═══════════════════════════════════════════════════════════════

  const refDataMatch = url.match(/^\/api\/workspaces\/([^\/]+)\/(departments|statuses|companies|priorities|changelog|users|clients|taskstatuses|folders)$/);
  if (refDataMatch && req.method === 'GET') {
    const collection = refDataMatch[2];
    const workspaceId = TEAM_ID;
    try {
      const snap = await db.collection('workspaces').doc(workspaceId).collection(collection).get();
      const items = snap.docs.map(doc => doc.data());
      if (collection === 'changelog') items.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(items));
    } catch (e) {
      console.error(`GET ${collection} error:`, e);
      res.writeHead(500);
      res.end('server error');
    }
    return;
  }

  if (refDataMatch && req.method === 'POST') {
    const collection = refDataMatch[2];
    const workspaceId = TEAM_ID;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const items = JSON.parse(body);
        const batch = db.batch();
        const col = db.collection('workspaces').doc(workspaceId).collection(collection);
        const keep = new Set();

        for (const item of items) {
          const id = item.id || db.collection('_ids').doc().id;
          keep.add(id);
          batch.set(col.doc(id), { ...item, id });
        }

        const existing = await col.listDocuments();
        for (const docRef of existing) {
          if (!keep.has(docRef.id)) batch.delete(docRef);
        }

        await batch.commit();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error(`POST ${collection} error:`, e);
        res.writeHead(400);
        res.end('bad request');
      }
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // INVITES
  // ═══════════════════════════════════════════════════════════════

  const inviteMatch = url.match(/^\/api\/workspaces\/([^\/]+)\/invite$/);
  if (inviteMatch && req.method === 'POST') {
    const workspaceId = TEAM_ID;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { email, role } = JSON.parse(body);
        await db.collection('workspaces').doc(workspaceId).update({
          invites: admin.firestore.FieldValue.arrayUnion({ email, role, invitedAt: new Date().toISOString() })
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('POST invite error:', e);
        res.writeHead(400);
        res.end('bad request');
      }
    });
    return;
  }

  // 404
  res.writeHead(404);
  res.end('not found');
};

// Vercel runs the handler as a serverless function; everywhere else we listen.
module.exports = handler;
if (!process.env.VERCEL) {
  const server = http.createServer(handler);
  server.listen(PORT, () => {
    console.log(`Todo app listening on port ${PORT}`);
    console.log(`Firebase project: ${serviceAccount.project_id}`);
  });
}
