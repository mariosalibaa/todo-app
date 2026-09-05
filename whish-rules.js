// Standing orders: "every $60 to this number is the Naccache internet".
//
// A Whish statement line is a payment, not a document. Odoo wants a bill behind it,
// and typing the same bill every month is exactly the sort of thing that gets skipped.
// A rule remembers the whole answer once — vendor, company, expense account, project —
// and every later line from that number is offered back as a ready draft.
//
// Two rules of the house, both deliberate:
//   * Nothing happens by itself. A bill is created, posted and paid only when a person
//     presses Book on that one line; without `post` it stays a draft.
//   * A line Odoo already knows (the matcher found its payment) is never offered.
//     That is what the matcher is for: it means the money is already booked.
//
// The bill carries ref = WHISH-<transaction id>, so re-uploading a statement or
// pressing the button twice finds the existing draft instead of making a second one.
//
//   GET  /api/accounting/whish/rules              the rules
//   POST /api/accounting/whish/rules              save one ({ id? , ... }) or delete ({ id, remove:true })
//   POST /api/accounting/whish/<acc>/book-preview what the rules would book, nothing written
//   POST /api/accounting/whish/<acc>/book         { ids: [...], post?: true } create the bills;
//                                                 with post, also post them and pay them from
//                                                 the rule's cash journal, dated as the Whish line

const accounts = require('./accounts');

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise((resolve, reject) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 4e6) req.destroy(); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

// idempotency key on the bill: <ACCOUNT>-<line id>; Whish keeps its historical prefix
const REF = (t, a) => (a && a.provider !== 'whish' ? String(a.id).toUpperCase().replace(/[^A-Z0-9]+/g, '') : 'WHISH') + '-' + t.id;
const money = n => Math.round(Number(n || 0) * 100) / 100;

// What a rule may say. Everything but the phone is optional, so a rule can be as loose as
// "this number is always Patrick" or as tight as "$60 out, and only $60".
const FIELDS = ['label', 'phone', 'contains', 'amount', 'direction', 'partnerId', 'partnerName', 'book', 'accountId',
  'companyId', 'companyName', 'journalId', 'accountId', 'accountCode', 'analyticId', 'analyticName',
  'paymentJournalId', 'paymentJournalName', 'description', 'active'];

// Does this line belong to this rule? The amount is compared to the cent, because
// "about $60" is how a $600 transfer ends up booked as an internet bill.
function fits(rule, t) {
  if (rule.active === false) return false;
  // A rule with neither a phone nor a text to look for would claim the whole
  // statement, so it claims nothing instead.
  if (!rule.phone && !rule.contains) return false;
  if (rule.phone && String(t.phone || '') !== String(rule.phone)) return false;
  if (rule.contains && !String(t.description || '').toLowerCase().includes(String(rule.contains).toLowerCase())) return false;
  const out = money(t.debit), inn = money(t.credit);
  const dir = rule.direction || 'out';
  if (dir === 'out' && !out) return false;
  if (dir === 'in' && !inn) return false;
  if (rule.amount != null && rule.amount !== '' && money(rule.amount) !== (dir === 'out' ? out : inn)) return false;
  return true;
}

const alreadyInOdoo = t => !!(t.odoo && (t.odoo.matches || []).some(x => x.chosen));

async function handle(req, res, url, user, ctx) {
  const { db, TEAM_ID, odooCall } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const who = user.email || user.uid;
  const now = () => new Date().toISOString();
  let m;

  if (url === '/api/accounting/whish/rules' && req.method === 'GET') {
    const snap = await ws.collection('whishRules').get();
    json(res, 200, snap.docs.map(d => ({ id: d.id, ...d.data() })));
    return true;
  }

  if (url === '/api/accounting/whish/rules' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.remove) {
      if (!b.id) { json(res, 400, { error: 'id required' }); return true; }
      await ws.collection('whishRules').doc(String(b.id)).delete();
      json(res, 200, { ok: true, removed: b.id });
      return true;
    }
    const ref = b.id ? ws.collection('whishRules').doc(String(b.id)) : ws.collection('whishRules').doc();
    // A change may send one field. What has to hold is the rule AFTER the merge:
    // a rule with neither a number nor a word would match the whole statement.
    const before = b.id ? ((await ref.get()).data() || {}) : {};
    const after = { ...before, ...b };
    if (!after.phone && !after.contains) { json(res, 400, { error: 'a rule needs a phone number or a word to look for' }); return true; }
    const data = { updatedAt: now(), updatedBy: who };
    for (const k of FIELDS) if (k in b) data[k] = b[k];
    if (!b.id) data.createdAt = now();
    await ref.set(data, { merge: true });
    json(res, 200, { ok: true, id: ref.id });
    return true;
  }

  // What would be booked, and what already has a draft. Nothing is written here.
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/book-preview$/)) && req.method === 'POST') {
    const account = await accounts.resolve(ws, m[1]);
    if (!account) { json(res, 404, { error: 'no such account' }); return true; }
    const rules = (await ws.collection('whishRules').get()).docs.map(d => ({ id: d.id, ...d.data() })).filter(r => !r.accountId || r.accountId === account.id);
    if (!rules.length) { json(res, 200, { rules: 0, candidates: [] }); return true; }
    const txs = (await accounts.txCol(account).get()).docs.map(d => d.data());
    const cand = [];
    for (const t of txs) {
      if (alreadyInOdoo(t)) continue;
      const rule = rules.find(r => fits(r, t));
      if (rule) cand.push({ t, rule });
    }
    let existing = {};
    if (cand.length) {
      try {
        const companies = await odooCall('res.company', 'search_read', [[]], { fields: ['id'] });
        const found = await odooCall('account.move', 'search_read', [[['ref', 'in', cand.map(c => REF(c.t, account))], ['move_type', '=', 'in_invoice']]],
          { fields: ['id', 'name', 'ref', 'state', 'amount_total'], context: { allowed_company_ids: companies.map(c => c.id) } });
        existing = Object.fromEntries(found.map(f => [f.ref, f]));
      } catch { /* Odoo unreachable: still list the candidates, just without the "already there" flag */ }
    }
    json(res, 200, {
      rules: rules.length,
      candidates: cand.map(({ t, rule }) => ({
        id: t.id, date: t.date, ref: t.ref, description: t.description, phone: t.phone,
        amount: money(t.debit || t.credit), direction: t.debit ? 'out' : 'in',
        rule: {
          id: rule.id, label: rule.label || '', partnerName: rule.partnerName, companyName: rule.companyName,
          accountCode: rule.accountCode, analyticName: rule.analyticName,
        },
        booked: existing[REF(t, account)] || null,
      })).sort((a, b) => (a.date < b.date ? 1 : -1)),
    });
    return true;
  }

  // Create the drafts. One line at a time on purpose: a failure on line 4 must not
  // leave lines 1-3 in a state nobody can explain.
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/book$/)) && req.method === 'POST') {
    const account = await accounts.resolve(ws, m[1]);
    if (!account) { json(res, 404, { error: 'no such account' }); return true; }
    const b = await readBody(req);
    const ids = (b.ids || []).map(String);
    if (!ids.length) { json(res, 400, { error: 'nothing selected' }); return true; }
    if (ids.length > 20) { json(res, 400, { error: 'up to 20 lines at a time' }); return true; }

    const rules = (await ws.collection('whishRules').get()).docs.map(d => ({ id: d.id, ...d.data() })).filter(r => !r.accountId || r.accountId === account.id);
    const col = accounts.txCol(account);
    const out = [];
    for (const id of ids) {
      const snap = await col.doc(id).get();
      if (!snap.exists) { out.push({ id, error: 'no such line' }); continue; }
      const t = snap.data();
      const rule = rules.find(r => fits(r, t));
      if (!rule) { out.push({ id, error: 'no rule matches this line any more' }); continue; }
      if (alreadyInOdoo(t)) { out.push({ id, error: 'Odoo already has this payment' }); continue; }
      // book:false = the rule only classifies. Astro and Solaris need the official
      // bill in hand (and attached) before anything is posted.
      if (rule.book === false) { out.push({ id, error: 'this rule classifies only — book it from the bill itself' }); continue; }
      if (!rule.partnerId || !rule.journalId || !rule.accountId || !rule.companyId) {
        out.push({ id, error: 'the rule is missing the vendor, company, journal or account' }); continue;
      }
      const ref = REF(t, account);
      const octx = {
        allowed_company_ids: [rule.companyId], company_id: rule.companyId,
        default_move_type: 'in_invoice', check_move_validity: false,
      };
      try {
        // the payment's memo carries the same WHISH ref, so ask for the bill by type
        const dup = await odooCall('account.move', 'search_read', [[['ref', '=', ref], ['move_type', '=', 'in_invoice']]],
          { fields: ['id', 'name', 'state', 'payment_state'], context: octx, limit: 1 });
        let moveId = dup.length ? dup[0].id : null, already = !!moveId;
        if (!moveId) {
        const line = {
          name: rule.description || rule.label || t.description || 'Whish payment',
          quantity: 1,
          price_unit: money(t.debit || t.credit),
          account_id: rule.accountId,
          tax_ids: [[6, 0, []]],                        // these bills carry no VAT
        };
        // analytic_distribution is keyed by the analytic account id, the value is the % of the line
        if (rule.analyticId) line.analytic_distribution = { [String(rule.analyticId)]: 100 };

        moveId = await odooCall('account.move', 'create', [{
          move_type: 'in_invoice',
          partner_id: rule.partnerId,
          journal_id: rule.journalId,
          company_id: rule.companyId,
          invoice_date: t.date,
          date: t.date,
          ref,                                          // the idempotency key
          narration: ((account.provider === 'whish' ? 'Whish ' : account.name + ' ') + t.date + ' · ref ' + (t.ref || '') + ' · ' + (t.description || '')).trim(),
          invoice_line_ids: [[0, 0, line]],
        }], { context: octx });
        }

        // Book it for real: post, then pay from the rule's cash journal on the Whish date.
        // The payment memo is the bill's ref, i.e. WHISH-<id>, so a re-run finds it too.
        let payment = null;
        if (b.post) {
          if (!rule.paymentJournalId) { out.push({ id, moveId, error: 'the rule has no cash journal to pay from' }); continue; }
          let [mv] = await odooCall('account.move', 'read', [[moveId], ['state', 'payment_state', 'amount_residual']], { context: octx });
          if (mv.state === 'draft') await odooCall('account.move', 'action_post', [[moveId]], { context: octx });
          [mv] = await odooCall('account.move', 'read', [[moveId], ['state', 'payment_state', 'amount_residual']], { context: octx });
          if (mv.payment_state !== 'paid' && mv.payment_state !== 'in_payment' && mv.amount_residual > 0) {
            const [method] = await odooCall('account.payment.method.line', 'search_read',
              [[['journal_id', '=', rule.paymentJournalId], ['payment_type', '=', t.debit ? 'outbound' : 'inbound']]],
              { fields: ['id'], context: octx, limit: 1 });
            const wctx = { ...octx, active_model: 'account.move', active_ids: [moveId], active_id: moveId };
            const vals = { journal_id: rule.paymentJournalId, payment_date: t.date, amount: mv.amount_residual };
            if (method) vals.payment_method_line_id = method.id;
            const wiz = await odooCall('account.payment.register', 'create', [vals], { context: wctx });
            const act = await odooCall('account.payment.register', 'action_create_payments', [[wiz]], { context: wctx });
            const payId = act && act.res_id;
            if (payId) {
              const [py] = await odooCall('account.payment', 'read', [[payId], ['name', 'date', 'amount']], { context: octx });
              payment = { id: payId, name: py.name, date: py.date, amount: py.amount };
            }
          }
        }

        const [mv] = await odooCall('account.move', 'read', [[moveId], ['name', 'amount_total', 'state', 'payment_state']], { context: octx });
        const booked = { moveId, move: mv.name, ref, state: mv.state, paymentState: mv.payment_state, at: now(), by: who, ruleId: rule.id };
        if (payment) booked.payment = payment;
        const data = { booked };
        // the row inherits the rule's answers, unless you already chose your own
        if (!t.partnerId && rule.partnerId) { data.partnerId = rule.partnerId; data.partnerName = rule.partnerName; data.partnerSrc = 'odoo'; }
        if (!t.company && rule.companyName) { data.company = rule.companyName; data.companySrc = 'odoo'; data.kind = 'work'; data.kindSrc = 'odoo'; }
        if (t.analyticSrc !== 'manual' && rule.analyticId) { data.analyticId = rule.analyticId; data.analyticName = rule.analyticName; data.analyticSrc = 'odoo'; data.analyticFrom = mv.name; }
        await col.doc(id).set(data, { merge: true });
        out.push({ id, moveId, move: mv.name, amount: mv.amount_total, state: mv.state, paymentState: mv.payment_state, payment, already });
      } catch (e) {
        out.push({ id, error: String(e.message || e).slice(0, 300) });
      }
    }
    json(res, 200, { results: out, created: out.filter(o => o.moveId && !o.already).length, booked: out.filter(o => o.paymentState === 'paid').length });
    return true;
  }

  return false;
}

module.exports = { handle, fits };
