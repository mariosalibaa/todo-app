// Budget section of the accounting app — replica of the HomeBudget desktop app.
// Mounted by server.js under /api/accounting/budget/* (accounting app gate applies).
// Firestore layout (all under workspaces/<team>):
//   budgetAccounts/<id>       { name, type, currency, opening, include, archived, seq }
//   `include` = counts towards the grand total. `archived` = retired: hidden from the
//   lists and the account picker and left out of every total, history kept.
//   budgetCategories/<id>     { name, icon, seq }
//   budgetSubCategories/<id>  { catId, name, icon, seq }
//   budgetPayees/<id>         { name, phone, notes }
//   budgetExpenses/<id>       { date, catId, subId, amount, currency, currencyAmount, accAmount, accountId, payeeId, notes, ts }
//   budgetIncome/<id>         { date, name, amount, currency, currencyAmount, accAmount, accountId, notes, ts }
//   budgetTransfers/<id>      { date, fromId, toId, amount, currency, currencyAmount, fromAmount, toAmount, notes }
//   budgetWhish/<trId>        { catId, subId, payeeId, notes }   overrides for Whish statement lines
//   budgetMeta/settings       { baseCurrency, currencies[], cycleStart, whishAccountId }
// Amounts: `amount` is always in the base currency (USD); `accAmount` is the amount in the
// account's own currency (what moves the balance) — copied from HomeBudget's own ledger.

const COLL = {
  accounts: 'budgetAccounts', categories: 'budgetCategories', subCategories: 'budgetSubCategories', payees: 'budgetPayees',
  expenses: 'budgetExpenses', income: 'budgetIncome', transfers: 'budgetTransfers', whish: 'budgetWhish'
};
const FIELDS = {
  accounts: ['name', 'type', 'currency', 'opening', 'include', 'archived', 'seq'],
  categories: ['name', 'icon', 'seq'],
  subCategories: ['catId', 'name', 'icon', 'seq'],
  payees: ['name', 'phone', 'notes'],
  expenses: ['date', 'catId', 'subId', 'amount', 'currency', 'currencyAmount', 'accAmount', 'accountId', 'payeeId', 'notes', 'ts'],
  income: ['date', 'name', 'amount', 'currency', 'currencyAmount', 'accAmount', 'accountId', 'notes', 'ts'],
  transfers: ['date', 'fromId', 'toId', 'amount', 'currency', 'currencyAmount', 'fromAmount', 'toAmount', 'notes'],
  whish: ['catId', 'subId', 'payeeId', 'notes']
};

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise((resolve, reject) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 2e6) req.destroy(); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('bad json')); } });
  req.on('error', reject);
});
const all = async coll => (await coll.get()).docs.map(d => ({ id: d.id, ...d.data() }));

async function whishLines(ws) {
  // every statement line of every Whish account, flattened for the Budget page.
  // The payee of a line is whoever owns the phone number: whishContacts is filled
  // from Google Contacts on the Whish page, so the same names show up here.
  const [accs, contactDocs] = await Promise.all([
    ws.collection('whishAccounts').get(),
    ws.collection('whishContacts').get()
  ]);
  const contacts = {};
  for (const d of contactDocs.docs) contacts[d.id] = (d.data() || {}).name || '';
  const out = [];
  for (const a of accs.docs) {
    const tx = await a.ref.collection('tx').get();
    for (const d of tx.docs) {
      const t = d.data();
      const contact = t.phone ? (contacts[t.phone] || '') : '';
      // a number nobody has named yet reads better as a local Lebanese number
      const local = t.phone ? '0' + String(t.phone).replace(/^961/, '') : '';
      out.push({
        id: d.id, whishAccount: a.id, date: t.date || '', ref: t.ref || '', service: t.service || '',
        phone: t.phone || '', contact,
        // payee = owner of the phone number, else the merchant name on the statement
        partner: t.partnerName || '',
        payeeLabel: t.partnerName || contact || t.name || local || t.description || '',
        who: t.partnerName || contact || t.name || local || t.description || '',
        debit: t.debit || 0, credit: t.credit || 0, balance: t.balance ?? null,
        note: t.note || '', kind: t.kind || '', analyticName: t.analyticName || ''
      });
    }
  }
  return out;
}

// Returns true when the request was handled.
async function handle(req, res, url, user, ctx) {
  const { db, TEAM_ID } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const who = (user && user.email) || '';
  const P = '/api/accounting/budget/';
  if (!url.startsWith(P)) return false;
  const rest = url.slice(P.length);

  if (rest === 'all' && req.method === 'GET') {
    const [accounts, categories, subCategories, payees, expenses, income, transfers, whishMap, settingsDoc, whish] = await Promise.all([
      all(ws.collection(COLL.accounts)), all(ws.collection(COLL.categories)), all(ws.collection(COLL.subCategories)),
      all(ws.collection(COLL.payees)), all(ws.collection(COLL.expenses)), all(ws.collection(COLL.income)),
      all(ws.collection(COLL.transfers)), all(ws.collection(COLL.whish)), ws.collection('budgetMeta').doc('settings').get(),
      whishLines(ws)
    ]);
    return json(res, 200, { accounts, categories, subCategories, payees, expenses, income, transfers, whish, whishMap,
      settings: settingsDoc.exists ? settingsDoc.data() : { baseCurrency: 'USD', currencies: [], cycleStart: 1 } }), true;
  }

  if (rest === 'settings' && req.method === 'POST') {
    const b = await readBody(req);
    const data = {};
    if (b.baseCurrency) data.baseCurrency = String(b.baseCurrency);
    if (Array.isArray(b.currencies)) data.currencies = b.currencies.map(c => ({ code: String(c.code || ''), name: String(c.name || ''), rate: c.rate == null ? null : Number(c.rate) }));
    if (b.whishAccountId != null) data.whishAccountId = String(b.whishAccountId);
    if (b.cycleStart) data.cycleStart = Number(b.cycleStart);
    data.updatedAt = new Date().toISOString(); data.updatedBy = who;
    await ws.collection('budgetMeta').doc('settings').set(data, { merge: true });
    return json(res, 200, { ok: true }), true;
  }

  // /api/accounting/budget/<kind>            POST  upsert {id?, ...fields}  → {id}
  // /api/accounting/budget/<kind>/<id>       DELETE
  const m = rest.match(/^(\w+)(?:\/([\w.~:@+-]+))?$/);
  if (!m || !COLL[m[1]]) return false;
  const kind = m[1], coll = ws.collection(COLL[kind]);

  if (req.method === 'POST' && !m[2]) {
    const b = await readBody(req);
    const data = {};
    for (const f of FIELDS[kind]) if (b[f] !== undefined) data[f] = b[f];
    for (const f of ['amount', 'currencyAmount', 'accAmount', 'fromAmount', 'toAmount', 'opening', 'seq']) if (data[f] != null) data[f] = Number(data[f]) || 0;
    if (kind === 'accounts') { if ('include' in data) data.include = !!data.include; if ('archived' in data) data.archived = !!data.archived; }
    data.updatedAt = new Date().toISOString(); data.updatedBy = who;
    const id = b.id ? String(b.id) : 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await coll.doc(id).set(data, { merge: true });
    return json(res, 200, { id }), true;
  }
  if (req.method === 'DELETE' && m[2]) {
    if (kind === 'categories') {   // a category takes its subcategories with it
      const subs = await ws.collection(COLL.subCategories).where('catId', '==', m[2]).get();
      await Promise.all(subs.docs.map(d => d.ref.delete()));
    }
    await coll.doc(m[2]).delete();
    return json(res, 200, { ok: true }), true;
  }
  return false;
}

module.exports = { handle };
