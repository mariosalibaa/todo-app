const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8081;
const DATA_FILE     = path.join(__dirname, 'tasks.json');
const PROJECTS_FILE = path.join(__dirname, 'projects.json');
const USERS_FILE    = path.join(__dirname, 'users.json');
const DEPTS_FILE    = path.join(__dirname, 'departments.json');
const COMPANIES_FILE  = path.join(__dirname, 'companies.json');
const STATUSES_FILE   = path.join(__dirname, 'statuses.json');
const CHANGELOG_FILE    = path.join(__dirname, 'changelog.json');
const PRIORITIES_FILE   = path.join(__dirname, 'priorities.json');

if (!fs.existsSync(DATA_FILE))      fs.writeFileSync(DATA_FILE,      '[]', 'utf8');
if (!fs.existsSync(PROJECTS_FILE))  fs.writeFileSync(PROJECTS_FILE,  '{}', 'utf8');
if (!fs.existsSync(USERS_FILE))     fs.writeFileSync(USERS_FILE,     '[]', 'utf8');
if (!fs.existsSync(DEPTS_FILE))     fs.writeFileSync(DEPTS_FILE,     JSON.stringify([
  { id: 'accounting',  name: 'Accounting',  color: '#a6e3a1' },
  { id: 'engineering', name: 'Engineering', color: '#89b4fa' },
  { id: 'sales',       name: 'Sales',       color: '#fab387' },
  { id: 'marketing',   name: 'Marketing',   color: '#cba6f7' },
  { id: 'operations',  name: 'Operations',  color: '#f9e2af' },
  { id: 'hr',          name: 'HR',          color: '#94e2d5' },
  { id: 'personal',    name: 'Personal',    color: '#f38ba8' }
], null, 2), 'utf8');
if (!fs.existsSync(CHANGELOG_FILE)) fs.writeFileSync(CHANGELOG_FILE, '[]', 'utf8');
if (!fs.existsSync(PRIORITIES_FILE)) fs.writeFileSync(PRIORITIES_FILE, JSON.stringify([
  { id: 'high',   name: 'High',   color: '#f38ba8' },
  { id: 'medium', name: 'Medium', color: '#fab387' },
  { id: 'low',    name: 'Low',    color: '#a6e3a1' }
], null, 2), 'utf8');
if (!fs.existsSync(STATUSES_FILE))  fs.writeFileSync(STATUSES_FILE,  JSON.stringify([
  { id: 'lead',    name: 'Lead',    color: '#f9e2af' },
  { id: 'active',  name: 'Active',  color: '#a6e3a1' },
  { id: 'on-hold', name: 'On Hold', color: '#fab387' },
  { id: 'done-p',  name: 'Done',    color: '#585b70' }
], null, 2), 'utf8');
if (!fs.existsSync(COMPANIES_FILE)) fs.writeFileSync(COMPANIES_FILE, JSON.stringify([
  { id: 'shift-dev',   name: 'Shift Development' },
  { id: 'shift-group', name: 'Shift Group' },
  { id: 'personal',    name: 'Personal' }
], null, 2), 'utf8');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url === '/api/tasks' && req.method === 'GET') {
    try {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch { res.writeHead(500); res.end('read error'); }
    return;
  }

  if (url === '/api/tasks' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const tasks = JSON.parse(body);
        fs.writeFileSync(DATA_FILE, JSON.stringify(tasks, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: tasks.length }));
        console.log(`Saved ${tasks.length} tasks`);
      } catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }

  if (url === '/api/projects' && req.method === 'GET') {
    try {
      const data = fs.readFileSync(PROJECTS_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch { res.writeHead(500); res.end('read error'); }
    return;
  }

  if (url === '/api/projects' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const meta = JSON.parse(body);
        fs.writeFileSync(PROJECTS_FILE, JSON.stringify(meta, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }

  if (url === '/api/users' && req.method === 'GET') {
    try {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch { res.writeHead(500); res.end('read error'); }
    return;
  }

  if (url === '/api/users' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const users = JSON.parse(body);
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }

  if (url === '/api/changelog' && req.method === 'GET') {
    try { res.writeHead(200,{'Content-Type':'application/json'}); res.end(fs.readFileSync(CHANGELOG_FILE,'utf8')); } catch { res.writeHead(500); res.end('error'); }
    return;
  }
  if (url === '/api/changelog' && req.method === 'POST') {
    let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
      try { fs.writeFileSync(CHANGELOG_FILE,body,'utf8'); res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}'); }
      catch { res.writeHead(400); res.end('bad json'); }
    }); return;
  }

  if (url === '/api/statuses' && req.method === 'GET') {
    try { res.writeHead(200,{'Content-Type':'application/json'}); res.end(fs.readFileSync(STATUSES_FILE,'utf8')); } catch { res.writeHead(500); res.end('error'); }
    return;
  }
  if (url === '/api/statuses' && req.method === 'POST') {
    let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
      try { fs.writeFileSync(STATUSES_FILE,body,'utf8'); res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}'); }
      catch { res.writeHead(400); res.end('bad json'); }
    }); return;
  }

  if (url === '/api/departments' && req.method === 'GET') {
    try { res.writeHead(200,{'Content-Type':'application/json'}); res.end(fs.readFileSync(DEPTS_FILE,'utf8')); } catch { res.writeHead(500); res.end('error'); }
    return;
  }
  if (url === '/api/departments' && req.method === 'POST') {
    let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
      try { fs.writeFileSync(DEPTS_FILE,body,'utf8'); res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}'); }
      catch { res.writeHead(400); res.end('bad json'); }
    }); return;
  }
  if (url === '/api/priorities' && req.method === 'GET') {
    try { res.writeHead(200,{'Content-Type':'application/json'}); res.end(fs.readFileSync(PRIORITIES_FILE,'utf8')); } catch { res.writeHead(500); res.end('error'); }
    return;
  }
  if (url === '/api/priorities' && req.method === 'POST') {
    let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
      try { fs.writeFileSync(PRIORITIES_FILE,body,'utf8'); res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}'); }
      catch { res.writeHead(400); res.end('bad json'); }
    }); return;
  }

  if (url === '/api/companies' && req.method === 'GET') {
    try { res.writeHead(200,{'Content-Type':'application/json'}); res.end(fs.readFileSync(COMPANIES_FILE,'utf8')); } catch { res.writeHead(500); res.end('error'); }
    return;
  }
  if (url === '/api/companies' && req.method === 'POST') {
    let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
      try { fs.writeFileSync(COMPANIES_FILE,body,'utf8'); res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}'); }
      catch { res.writeHead(400); res.end('bad json'); }
    }); return;
  }

  // Static files
  const filePath = url === '/' ? path.join(__dirname, 'todo.html') : path.join(__dirname, url);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`To-Do → http://localhost:${PORT}/`));
