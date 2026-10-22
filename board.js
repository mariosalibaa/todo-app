// Board — Mario's page of tabs (Mario 2026-10-22: "a page having tabs that I can rename — projects in progress,
// Ajaltoun with sub-tabs operation/site, design/management, sales/marketing, accounting; upselling; leads;
// accounting: Mahab / Ghassan Hibri / …; other to-do list; development / investment").
// Every tab and sub-tab can be renamed, moved, deleted, and given sub-tabs of its own; each one holds a list of
// lines written the Daily Paper way (done, highlighter, due date, drag = priority).
// Mounted by server.js under /api/board*; admin only (gated in server.js).
//
// Firestore (under workspaces/<team>):
//   boardTabs/<id>   { id, name, parent (tab id | null), order, addedAt, updatedAt, updatedBy }
//   boardItems/<id>  { id, tab, text, order, hl ('' | 'y' | 'o'), due (yyyy-mm-dd | ''), done, doneAt,
//                      addedAt, addedBy, updatedAt, updatedBy }

const { beirutDay } = require('./paper');

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const now = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ID = /^[\w-]{1,40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The tabs Mario asked for, written once when the board is empty
const SEED = [
  ['projects', 'Projects in progress'],
  ['ajaltoun', 'Ajaltoun', [['aj-site', 'Operation / Site'], ['aj-design', 'Design / Management'], ['aj-sales', 'Sales / Marketing'], ['aj-accounting', 'Accounting']]],
  ['upselling', 'Upselling'],
  ['leads', 'Leads'],
  ['accounting', 'Accounting', [['acc-mahab', 'Mahab'], ['acc-ghassan', 'Ghassan Hibri']]],
  ['other', 'Other to-do list'],
  ['development', 'Development / Investment'],
];

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); return; } data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

async function handle(req, res, url, user, ctx) {
  const { db, TEAM_ID } = ctx;
  const base = db.collection('workspaces').doc(TEAM_ID);
  const tabs = base.collection('boardTabs'), items = base.collection('boardItems');
  const who = (user && user.email) || 'unknown';
  let m;

  const allTabs = async () => (await tabs.get()).docs.map(d => d.data());
  const allItems = async () => (await items.get()).docs.map(d => d.data());

  // The whole board: tabs + lines (seeded with Mario's tabs the first time)
  if (url === '/api/board' && req.method === 'GET') {
    let [t, i] = await Promise.all([allTabs(), allItems()]);
    if (!t.length) {
      const batch = db.batch();
      SEED.forEach(([id, name, kids], n) => {
        const doc = { id, name, parent: null, order: n + 1, addedAt: now(), updatedAt: now(), updatedBy: who };
        batch.set(tabs.doc(id), doc); t.push(doc);
        (kids || []).forEach(([kid, kname], k) => { const kd = { id: kid, name: kname, parent: id, order: k + 1, addedAt: now(), updatedAt: now(), updatedBy: who }; batch.set(tabs.doc(kid), kd); t.push(kd); });
      });
      await batch.commit();
    }
    return json(res, 200, { today: beirutDay(), tabs: t, items: i });
  }

  // Add or rename a tab (id present → edit). A new tab goes last among its siblings.
  if (url === '/api/board/tab' && req.method === 'POST') {
    const b = await readBody(req, 8e3);
    const id = (typeof b.id === 'string' && ID.test(b.id)) ? b.id : newId();
    const ref = tabs.doc(id); const cur = (await ref.get()).data();
    const doc = { id, updatedAt: now(), updatedBy: who };
    if (b.name != null) doc.name = String(b.name).trim().slice(0, 60);
    if (doc.name === '') return json(res, 400, { error: 'a tab needs a name' });
    if (!cur) {
      if (!doc.name) return json(res, 400, { error: 'a tab needs a name' });
      doc.parent = (typeof b.parent === 'string' && ID.test(b.parent)) ? b.parent : null;
      const sibs = (await allTabs()).filter(x => (x.parent || null) === doc.parent);
      doc.order = sibs.reduce((mx, x) => Math.max(mx, x.order || 0), 0) + 1;
      doc.addedAt = doc.updatedAt;
      // the first sub-tab of a tab takes the lines already written on that tab, so none get hidden
      if (doc.parent && !sibs.length) {
        const moved = (await allItems()).filter(x => x.tab === doc.parent);
        if (moved.length) { const batch = db.batch(); moved.forEach(x => batch.set(items.doc(x.id), { tab: id }, { merge: true })); await batch.commit(); }
      }
    }
    await ref.set(doc, { merge: true });
    return json(res, 200, (await ref.get()).data());
  }

  // Delete a tab, its sub-tabs and every line on them
  if ((m = url.match(/^\/api\/board\/tab\/([\w-]+)$/)) && req.method === 'DELETE') {
    const t = await allTabs(); const gone = new Set([m[1]]);
    t.filter(x => x.parent === m[1]).forEach(x => gone.add(x.id));
    const lines = (await allItems()).filter(x => gone.has(x.tab));
    const batch = db.batch();
    gone.forEach(id => batch.delete(tabs.doc(id))); lines.forEach(x => batch.delete(items.doc(x.id)));
    await batch.commit();
    return json(res, 200, { tabs: [...gone], items: lines.map(x => x.id) });
  }

  // New order of tabs or of the lines of one tab: ids left → right / top → bottom
  if ((m = url.match(/^\/api\/board\/(tabs|items)\/order$/)) && req.method === 'POST') {
    const b = await readBody(req, 32e3);
    const col = m[1] === 'tabs' ? tabs : items;
    const ids = (b.ids || []).filter(x => typeof x === 'string' && ID.test(x)).slice(0, 500);
    const batch = db.batch();
    ids.forEach((id, i) => batch.set(col.doc(id), { order: i + 1, updatedAt: now(), updatedBy: who }, { merge: true }));
    await batch.commit();
    return json(res, 200, { ok: true });
  }

  // Add or edit one line (id present → edit). Only the fields sent are touched.
  if (url === '/api/board/item' && req.method === 'POST') {
    const b = await readBody(req, 32e3);
    const id = (typeof b.id === 'string' && ID.test(b.id)) ? b.id : newId();
    const ref = items.doc(id); const cur = (await ref.get()).data();
    const doc = { id, updatedAt: now(), updatedBy: who };
    if (b.text != null) doc.text = String(b.text).trim().slice(0, 500);
    if (b.tab !== undefined && typeof b.tab === 'string' && ID.test(b.tab)) doc.tab = b.tab;
    if (b.hl !== undefined) doc.hl = ['y', 'o'].includes(b.hl) ? b.hl : '';
    if (b.due !== undefined) doc.due = DAY.test(b.due || '') ? b.due : '';
    if (b.done !== undefined) { doc.done = !!b.done; doc.doneAt = b.done ? beirutDay() : null; }
    if (!cur) {
      if (!doc.text) return json(res, 400, { error: 'text is required' });
      if (!doc.tab) return json(res, 400, { error: 'tab is required' });
      const sibs = (await allItems()).filter(x => x.tab === doc.tab);
      doc.order = sibs.reduce((mx, x) => Math.max(mx, x.order || 0), 0) + 1;
      doc.addedAt = doc.updatedAt; doc.addedBy = who;
      for (const [k, v] of Object.entries({ hl: '', due: '', done: false, doneAt: null })) if (doc[k] === undefined) doc[k] = v;
    } else if (doc.text === '') return json(res, 400, { error: 'text is required' });
    await ref.set(doc, { merge: true });
    return json(res, 200, (await ref.get()).data());
  }

  if ((m = url.match(/^\/api\/board\/item\/([\w-]+)$/)) && req.method === 'DELETE') {
    await items.doc(m[1]).delete();
    return json(res, 200, { deleted: m[1] });
  }

  return false;
}

module.exports = { handle };
