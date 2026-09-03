// One-time import of the HomeBudget desktop database into Firestore (Budget app).
//   1. python export-homebudget.py <out.json>   (reads %USERPROFILE%\OneDrive\Documents\HomeBudgetData\Data\homebudget.db)
//   2. node migrate-homebudget.js <out.json> [--wipe]
// Re-running merges by id (HomeBudget keys). --wipe deletes the budget* collections first.
// Never runs on the server; the hub is the master once this has been done.
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const file = process.argv[2];
if (!file) { console.error('usage: node migrate-homebudget.js <export.json> [--wipe]'); process.exit(1); }
const wipe = process.argv.includes('--wipe');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

const serviceAccount = JSON.parse(fs.readFileSync(path.join(__dirname, 'firebase-service-account.json'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: serviceAccount.project_id });
const db = admin.firestore();
const TEAM_ID = process.env.TEAM_ID || 'team';
const ws = db.collection('workspaces').doc(TEAM_ID);

const COLL = { accounts: 'budgetAccounts', categories: 'budgetCategories', subCategories: 'budgetSubCategories',
  payees: 'budgetPayees', expenses: 'budgetExpenses', income: 'budgetIncome', transfers: 'budgetTransfers' };

async function commit(writes) {
  for (let i = 0; i < writes.length; i += 400) {
    const b = db.batch();
    writes.slice(i, i + 400).forEach(w => w.del ? b.delete(w.ref) : b.set(w.ref, w.data, { merge: true }));
    await b.commit();
  }
}

(async () => {
  if (wipe) {
    for (const c of [...Object.values(COLL), 'budgetWhish']) {
      const snap = await ws.collection(c).select().get();
      await commit(snap.docs.map(d => ({ ref: d.ref, del: true })));
      console.log('wiped', c, snap.size);
    }
  }
  const strip = o => Object.fromEntries(Object.entries(o).filter(([k, v]) => k !== 'id' && v !== undefined));
  for (const [k, c] of Object.entries(COLL)) {
    const list = data[k] || [];
    await commit(list.map(x => ({ ref: ws.collection(c).doc(String(x.id)), data: strip(x) })));
    console.log(c, list.length);
  }
  // Whish feed: the "whish money" account (HomeBudget key 106) shows the statement lines;
  // they land in the "Whish" category with W/P as subcategory unless overridden.
  const whishAcc = (data.accounts.find(a => /whish/i.test(a.name)) || {}).id || '';
  await commit([
    { ref: ws.collection('budgetCategories').doc('whish'), data: { name: 'Whish', icon: '', seq: 999 } },
    { ref: ws.collection('budgetSubCategories').doc('whish-work'), data: { catId: 'whish', name: 'Work', icon: '', seq: 0 } },
    { ref: ws.collection('budgetSubCategories').doc('whish-personal'), data: { catId: 'whish', name: 'Personal', icon: '', seq: 1 } },
    { ref: ws.collection('budgetSubCategories').doc('whish-untagged'), data: { catId: 'whish', name: 'Untagged', icon: '', seq: 2 } },
    { ref: ws.collection('budgetMeta').doc('settings'), data: { ...data.settings, whishAccountId: String(whishAcc), importedAt: new Date().toISOString(), source: path.basename(file) } },
  ]);
  console.log('settings written, whish account =', whishAcc);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
