const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// Initialize Firebase Admin
const serviceAccount = JSON.parse(fs.readFileSync(path.join(__dirname, 'firebase-service-account.json'), 'utf8'));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id
});

const db = admin.firestore();
const auth = admin.auth();

const PORT = process.env.PORT || 8081;

// Auth middleware: verify Firebase ID token
async function verifyToken(req) {
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
};

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,PUT,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Public endpoints (no auth required)
  if (url === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'todo.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
      const userDoc = await db.collection('users').doc(userId).get();
      const userData = userDoc.data() || { workspaces: [] };
      const workspaceIds = (userData.workspaces || []).map(w => w.workspaceId);

      const workspaces = [];
      for (const wsId of workspaceIds) {
        const wsDoc = await db.collection('workspaces').doc(wsId).get();
        if (wsDoc.exists) {
          workspaces.push({ id: wsId, ...wsDoc.data() });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(workspaces));
    } catch (e) {
      console.error('GET /api/workspaces error:', e);
      res.writeHead(500);
      res.end('server error');
    }
    return;
  }

  if (url === '/api/workspaces' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { name } = JSON.parse(body);
        const workspaceId = db.collection('workspaces').doc().id;
        const now = new Date().toISOString();

        await db.collection('workspaces').doc(workspaceId).set({
          id: workspaceId,
          name,
          type: 'shared',
          ownerId: userId,
          createdAt: now,
          members: [{ uid: userId, email: user.email, name: user.name || 'User', role: 'owner' }],
          invites: []
        });

        await db.collection('users').doc(userId).update({
          workspaces: admin.firestore.FieldValue.arrayUnion({ workspaceId, role: 'owner' })
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: workspaceId, name, ownerId: userId }));
      } catch (e) {
        console.error('POST /api/workspaces error:', e);
        res.writeHead(400);
        res.end('bad request');
      }
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // TASKS (workspace-scoped)
  // ═══════════════════════════════════════════════════════════════

  const tasksMatch = url.match(/^\/api\/workspaces\/([^\/]+)\/tasks$/);
  if (tasksMatch && req.method === 'GET') {
    const workspaceId = tasksMatch[1];
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
    const workspaceId = tasksMatch[1];
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const tasks = JSON.parse(body);
        const batch = db.batch();

        for (const task of tasks) {
          const taskRef = db.collection('workspaces').doc(workspaceId)
            .collection('tasks').doc(task.id);
          batch.set(taskRef, { ...task, workspaceId });
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
    const workspaceId = projectsMatch[1];
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
    const workspaceId = projectsMatch[1];
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const projectMeta = JSON.parse(body);
        const batch = db.batch();

        for (const [name, data] of Object.entries(projectMeta)) {
          const projectRef = db.collection('workspaces').doc(workspaceId)
            .collection('projects').doc(name);
          batch.set(projectRef, { name, ...data });
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
  // REFERENCE DATA (departments, statuses, companies, priorities)
  // ═══════════════════════════════════════════════════════════════

  const refDataMatch = url.match(/^\/api\/workspaces\/([^\/]+)\/(departments|statuses|companies|priorities|changelog)$/);
  if (refDataMatch && req.method === 'GET') {
    const [, workspaceId, collection] = refDataMatch;
    try {
      const snap = await db.collection('workspaces').doc(workspaceId).collection(collection).get();
      const items = snap.docs.map(doc => doc.data());
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
    const [, workspaceId, collection] = refDataMatch;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const items = JSON.parse(body);
        const batch = db.batch();

        for (const item of items) {
          const ref = db.collection('workspaces').doc(workspaceId).collection(collection).doc(item.id);
          batch.set(ref, item);
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
  // USERS/MEMBERS
  // ═══════════════════════════════════════════════════════════════

  const usersMatch = url.match(/^\/api\/workspaces\/([^\/]+)\/users$/);
  if (usersMatch && req.method === 'GET') {
    const workspaceId = usersMatch[1];
    try {
      const wsDoc = await db.collection('workspaces').doc(workspaceId).get();
      const members = wsDoc.data().members || [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(members));
    } catch (e) {
      console.error('GET members error:', e);
      res.writeHead(500);
      res.end('server error');
    }
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // INVITES
  // ═══════════════════════════════════════════════════════════════

  const inviteMatch = url.match(/^\/api\/workspaces\/([^\/]+)\/invite$/);
  if (inviteMatch && req.method === 'POST') {
    const workspaceId = inviteMatch[1];
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
});

server.listen(PORT, () => {
  console.log(`Todo app listening on port ${PORT}`);
  console.log(`Firebase project: ${serviceAccount.project_id}`);
});
