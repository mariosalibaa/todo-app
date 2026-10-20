// Daily Paper — Mario's handwritten A4 list on the hub (Mario 2026-10-20: "I use this paper daily to write my
// ideas, projects running, projects to do … like a priority list in mind, or like due date").
// One living page: the order is the priority, a highlighter marks the top ones, a due date is optional, any line
// can open into its own sheet (the way 18 Oct broke Ajaltoun into a page). Every change also writes that day's
// copy, so the page of any past day can be read back like the papers in the drawer. A photo of the real paper can
// be read into lines (Claude reads the handwriting, Mario ticks what to add). A line goes to the To-Do only when
// Mario presses ➜ (the paper stays his thinking list).
// Mounted by server.js under /api/paper*; admin only (gated in server.js).
//
// Firestore (under workspaces/<team>):
//   paper/<id>       { id, text, parent (line id | null), order, hl ('' | 'y' | 'o'), due (yyyy-mm-dd | ''),
//                      project (To-Do project name | ''), done, doneAt, taskId, addedAt, addedBy, updatedAt, updatedBy }
//   paperDays/<day>  { day, lines: [{ id, text, parent, order, hl, due, project, done }], photos: [...], updatedAt }

const files = require('./hub-files');
const parse = require('./site-parse');

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const now = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); return; } data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

// yyyy-mm-dd in Beirut, never toISOString() (hub-date-timezone rule)
function beirutDay() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value; return `${g('year')}-${g('month')}-${g('day')}`;
}

const slim = l => ({ id: l.id, text: l.text, parent: l.parent || null, order: l.order || 0, hl: l.hl || '', due: l.due || '', project: l.project || '', done: !!l.done });

async function handle(req, res, url, user, ctx) {
  const { db, TEAM_ID } = ctx;
  const base = db.collection('workspaces').doc(TEAM_ID);
  const col = base.collection('paper'), days = base.collection('paperDays');
  const who = (user && user.email) || 'unknown';
  let m;

  const all = async () => (await col.get()).docs.map(d => d.data());
  // today's copy of the page = the page as it stands after this change
  const snapshot = async () => {
    const day = beirutDay();
    await days.doc(day).set({ day, lines: (await all()).map(slim), updatedAt: now() }, { merge: true });
  };

  // The page + the days that have a copy (for the ‹ › history) + the To-Do projects for the picker
  if (url === '/api/paper' && req.method === 'GET') {
    const [lines, dsnap, psnap] = await Promise.all([all(), days.select('day', 'photos').get(), base.collection('projects').get()]);
    const dayList = dsnap.docs.map(d => ({ day: d.id, photos: ((d.data().photos) || []).length })).sort((a, b) => a.day.localeCompare(b.day));
    const projects = psnap.docs.map(d => d.data()).filter(p => p && p.name).map(p => ({ name: p.name, status: p.status || '' }));
    return json(res, 200, { today: beirutDay(), lines, days: dayList, projects });
  }

  // Add or edit one line (id present → edit). Only the fields sent are touched.
  if (url === '/api/paper/line' && req.method === 'POST') {
    const b = await readBody(req, 32e3);
    const id = (typeof b.id === 'string' && /^[\w-]{1,40}$/.test(b.id)) ? b.id : newId();
    const ref = col.doc(id); const cur = (await ref.get()).data();
    const doc = { id, updatedAt: now(), updatedBy: who };
    if (b.text != null) doc.text = String(b.text).trim().slice(0, 500);
    if (b.parent !== undefined) doc.parent = (typeof b.parent === 'string' && b.parent) ? b.parent : null;
    if (b.hl !== undefined) doc.hl = ['y', 'o'].includes(b.hl) ? b.hl : '';
    if (b.due !== undefined) doc.due = DAY.test(b.due || '') ? b.due : '';
    if (b.project !== undefined) doc.project = String(b.project || '').slice(0, 120);
    if (b.order !== undefined && isFinite(b.order)) doc.order = Number(b.order);
    if (b.done !== undefined) { doc.done = !!b.done; doc.doneAt = b.done ? beirutDay() : null; }
    if (!cur) {
      if (!doc.text) return json(res, 400, { error: 'text is required' });
      doc.addedAt = doc.updatedAt; doc.addedBy = who;
      if (doc.parent === undefined) doc.parent = null;
      if (doc.order === undefined) {   // a new line goes at the bottom of its sheet
        const sibs = (await all()).filter(l => (l.parent || null) === doc.parent);
        doc.order = sibs.reduce((mx, l) => Math.max(mx, l.order || 0), 0) + 1;
      }
      for (const [k, v] of Object.entries({ hl: '', due: '', project: '', done: false, doneAt: null, taskId: null })) if (doc[k] === undefined) doc[k] = v;
    } else if (doc.text === '') return json(res, 400, { error: 'text is required' });
    await ref.set(doc, { merge: true });
    await snapshot();
    return json(res, 200, (await ref.get()).data());
  }

  // Several lines added at once (from a photo of the paper)
  if (url === '/api/paper/lines' && req.method === 'POST') {
    const b = await readBody(req, 64e3);
    const parent = (typeof b.parent === 'string' && b.parent) ? b.parent : null;
    const sibs = (await all()).filter(l => (l.parent || null) === parent);
    let order = sibs.reduce((mx, l) => Math.max(mx, l.order || 0), 0);
    const batch = db.batch(); const out = [];
    for (const x of (b.lines || []).slice(0, 60)) {
      const text = String(x.text || '').trim().slice(0, 500); if (!text) continue;
      const id = newId() + out.length;
      const doc = { id, text, parent, order: ++order, hl: ['y', 'o'].includes(x.hl) ? x.hl : '', due: '', project: String(x.project || '').slice(0, 120),
        done: false, doneAt: null, taskId: null, addedAt: now(), addedBy: who, updatedAt: now(), updatedBy: who };
      batch.set(col.doc(id), doc); out.push(doc);
    }
    await batch.commit(); await snapshot();
    return json(res, 200, out);
  }

  // New order of one sheet: ids top → bottom
  if (url === '/api/paper/order' && req.method === 'POST') {
    const b = await readBody(req, 32e3);
    const ids = (b.ids || []).filter(x => typeof x === 'string' && /^[\w-]{1,40}$/.test(x)).slice(0, 500);
    const batch = db.batch();
    ids.forEach((id, i) => batch.set(col.doc(id), { order: i + 1, updatedAt: now(), updatedBy: who }, { merge: true }));
    await batch.commit(); await snapshot();
    return json(res, 200, { ok: true });
  }

  // Delete a line and everything written under it
  if ((m = url.match(/^\/api\/paper\/line\/([\w-]+)$/)) && req.method === 'DELETE') {
    const lines = await all(); const gone = new Set([m[1]]);
    let grew = true; while (grew) { grew = false; for (const l of lines) if (l.parent && gone.has(l.parent) && !gone.has(l.id)) { gone.add(l.id); grew = true; } }
    const batch = db.batch(); gone.forEach(id => batch.delete(col.doc(id))); await batch.commit();
    await snapshot();
    return json(res, 200, { deleted: [...gone] });
  }

  // ➜ To-Do: the line becomes a task under its project (one task doc, never the full-list POST that deletes)
  if ((m = url.match(/^\/api\/paper\/line\/([\w-]+)\/todo$/)) && req.method === 'POST') {
    const ref = col.doc(m[1]); const l = (await ref.get()).data();
    if (!l) return json(res, 404, { error: 'line not found' });
    if (l.taskId && (await base.collection('tasks').doc(l.taskId).get()).exists) return json(res, 200, l);
    const lines = await all();
    const path = []; for (let p = l.parent; p; ) { const pl = lines.find(x => x.id === p); if (!pl) break; path.unshift(pl.text); p = pl.parent; }
    const project = l.project || (path.length && lines.find(x => x.text === path[0] && !x.parent) || {}).project || 'General Tasks';
    const taskId = 'paper-' + l.id;
    await base.collection('tasks').doc(taskId).set({ id: taskId, title: l.text, done: false, doneAt: null, createdAt: now(), project, taskStatus: '', department: null,
      priority: l.hl ? 'high' : '', due: l.due || '', partner: '', notes: 'From the Daily Paper' + (path.length ? ' — ' + path.join(' › ') : '') + '.',
      taskType: 'task', clientName: '', clientId: null, subtasks: [], assignees: [], createdBy: 'Daily Paper', updatedBy: who, updatedAt: now() });
    await ref.set({ taskId, updatedAt: now(), updatedBy: who }, { merge: true });
    return json(res, 200, (await ref.get()).data());
  }

  // One past day, as it stood at the end of that day
  if ((m = url.match(/^\/api\/paper\/day\/(\d{4}-\d{2}-\d{2})$/)) && req.method === 'GET') {
    const d = (await days.doc(m[1]).get()).data();
    return json(res, 200, d || { day: m[1], lines: [], photos: [] });
  }

  // A photo of the real paper: kept on that day, then read into lines for Mario to tick
  if (url === '/api/paper/photo' && req.method === 'POST') {
    const b = await readBody(req, 12e6);
    if (!b.dataBase64) return json(res, 400, { error: 'dataBase64 required' });
    const raw = String(b.dataBase64).replace(/^data:[^,]*,/, '');
    const buf = Buffer.from(raw, 'base64');
    if (buf.length > 8e6) return json(res, 400, { error: 'photo over 8 MB' });
    const mime = /^image\/(png|webp|jpeg)$/.test(b.mime || '') ? String(b.mime) : 'image/jpeg';
    const ext = /png$/.test(mime) ? 'png' : /webp$/.test(mime) ? 'webp' : 'jpg';
    const day = DAY.test(b.day || '') ? b.day : beirutDay();
    const pid = newId();
    const saved = await files.saveFile(ctx, { buf, mime, name: `Paper ${day}.${ext}`, key: `paper/${day}/${pid}.${ext}`, who, meta: { paper: day } });
    const photo = { ...saved, id: pid, at: now() };
    const dref = days.doc(day); const cur = (await dref.get()).data() || {};
    await dref.set({ day, photos: [...(cur.photos || []), photo], updatedAt: now() }, { merge: true });
    let read = { date: '', title: '', lines: [] }, error = null;
    try {
      const known = (await all()).filter(l => !l.done).map(l => l.text).slice(0, 80);
      const projects = (await base.collection('projects').get()).docs.map(d => d.data().name).filter(Boolean);
      read = await parse.anthropic({ model: 'claude-sonnet-5', max_tokens: 1500,
        system: 'This is a photo of Mario Saliba\'s handwritten daily list (Shift Group, Lebanon: solar, steel structures, villas). '
          + 'Read it top to bottom. Return JSON only: {"date":"yyyy-mm-dd or empty","title":"the underlined heading if the page is about one project, else empty","lines":[{"text":string,"hl":"y"|"o"|"","unsure":boolean}]}. '
          + 'One entry per bullet, in order; skip empty bullets. hl = "y" when the line is marked with a yellow/green highlighter, "o" for orange/red, else "". '
          + 'Spell names the way they are written in his projects or current lines when the handwriting matches one; unsure = true when you are guessing a word. '
          + 'His projects: ' + projects.join(', ') + '. His current lines: ' + known.join(', ') + '.',
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mime, data: raw } }] }] });
    } catch (e) { error = e.message; }
    return json(res, 200, { day, photo, read, error });
  }
  if ((m = url.match(/^\/api\/paper\/day\/(\d{4}-\d{2}-\d{2})\/photo\/([\w-]+)$/)) && req.method === 'GET') {
    const d = (await days.doc(m[1]).get()).data();
    const ph = d && (d.photos || []).find(p => p.id === m[2]);
    if (!ph) { res.writeHead(404); res.end('no such photo'); return true; }
    await files.streamFile(ctx, ph, res, req); return true;
  }

  return false;
}

module.exports = { handle, beirutDay };
