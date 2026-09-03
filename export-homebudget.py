import sqlite3, json, os, sys
src = os.path.expandvars(r'%USERPROFILE%\OneDrive\Documents\HomeBudgetData\Data\homebudget.db')
out = sys.argv[1]
c = sqlite3.connect(src); c.row_factory = sqlite3.Row
rows = lambda q: [dict(r) for r in c.execute(q)]
yes = lambda v: v == 'Y'
exp = rows("select * from Expense"); inc = rows("select * from Income"); trf = rows("select * from Transfer")
print('split masters', sum(1 for e in exp if e['isCategorySplit']=='Y'), 'children', sum(1 for e in exp if e['masterKey']!=-1), 'detailN', sum(1 for e in exp if e['isDetailEntry']!='Y'))
print('acctrans types', rows("select transType,count(*) n,sum(transAmount) s from AccountTrans group by transType"))
# per-account net from documents
net = {}
def add(k, v):
    if k: net[k] = net.get(k, 0) + v
for e in exp:
    if e['masterKey'] == -1: add(e['payFrom'], -e['amount'])
for i in inc: add(i['addIncomeTo'], i['amount'])
for t in trf: add(t['fromAccount'], -t['amount']); add(t['toAccount'], t['amount'])
# per-account net from AccountTrans (1 exp,2 inc,3 out,4 in ?)
net2 = {}
for r in rows("select * from AccountTrans"):
    s = -r['transAmount'] if r['transType'] in (1, 3) else r['transAmount']
    net2[r['accountKey']] = net2.get(r['accountKey'], 0) + s
bad = [(k, round(net.get(k,0),2), round(net2.get(k,0),2)) for k in set(net)|set(net2) if abs(net.get(k,0)-net2.get(k,0))>0.01]
print('mismatch doc-vs-acctrans', len(bad), bad[:8])
# AccountTrans is HomeBudget's own per-account ledger: type 0 opening, 1 expense, 2 income, 3 transfer out, 4 transfer in
at = {}
opening = {}
for r in rows("select * from AccountTrans"):
    if r['transType'] == 0: opening[r['accountKey']] = r['transAmount']
    else: at[(r['transType'], r['transKey'], r['accountKey'])] = r['transAmount']
accounts = []
for a in rows("select * from Account"):
    accounts.append({ 'id': str(a['key']), 'name': a['name'].strip(), 'type': (a['accountType'] or '').strip(), 'currency': a['currency'] or 'USD',
        'opening': opening.get(a['key'], a['balance']), 'include': yes(a['includeAccount']), 'seq': a['seqNum'] or 0 })
cats = [{ 'id': str(r['key']), 'name': r['name'].strip(), 'icon': r['icon'] or '', 'seq': r['seqNum'] or 0 } for r in rows("select * from Category")]
subs = [{ 'id': str(r['key']), 'catId': str(r['catKey']), 'name': r['name'].strip(), 'icon': r['icon'] or '', 'seq': r['seqNum'] or 0 } for r in rows("select * from SubCategory")]
payees = [{ 'id': str(r['key']), 'name': r['name'].strip(), 'phone': r['phoneNum'] or '', 'notes': r['notes'] or '' } for r in rows("select * from Payee")]
fnum = lambda v: float(str(v).replace(',', '')) if v not in (None, '') else None
expenses = [{ 'id': str(e['key']), 'date': e['date'], 'catId': str(e['catKey']), 'subId': str(e['subCatKey']), 'amount': e['amount'],
    'currency': e['currency'] or 'USD', 'currencyAmount': fnum(e['currencyAmount']), 'notes': e['notes'] or '', 'accountId': str(e['payFrom'] or ''),
    'payeeId': str(e['payeeKey'] or ''), 'accAmount': at.get((1, e['key'], e['payFrom'])), 'masterId': str(e['masterKey']) if e['masterKey'] != -1 else '', 'split': yes(e['isCategorySplit']), 'ts': e['timeStamp'] } for e in exp]
income = [{ 'id': str(i['key']), 'date': i['date'], 'name': i['name'] or '', 'amount': i['amount'], 'currency': i['currency'] or 'USD',
    'currencyAmount': fnum(i['currencyAmount']), 'notes': i['notes'] or '', 'accountId': str(i['addIncomeTo'] or ''), 'accAmount': at.get((2, i['key'], i['addIncomeTo'])), 'ts': i['timeStamp'] } for i in inc]
transfers = [{ 'id': str(t['key']), 'date': t['transferDate'], 'fromId': str(t['fromAccount']), 'toId': str(t['toAccount']), 'amount': t['amount'],
    'currency': t['currency'] or 'USD', 'currencyAmount': fnum(t['currencyAmount']), 'fromAmount': at.get((3, t['key'], t['fromAccount'])), 'toAmount': at.get((4, t['key'], t['toAccount'])), 'notes': t['notes'] or '' } for t in trf]
cur = [{ 'code': r['code'], 'name': r['name'], 'rate': float(r['exchangeRate']) if r['exchangeRate'] else None } for r in rows("select * from Currency")]
s = dict(c.execute("select * from Settings").fetchone())
settings = { 'baseCurrency': s['currency'] or 'USD', 'currencies': cur, 'cycleStart': s['monthlyCycleStart'] or 1 }
json.dump({ 'accounts': accounts, 'categories': cats, 'subCategories': subs, 'payees': payees, 'expenses': expenses, 'income': income, 'transfers': transfers, 'settings': settings }, open(out, 'w'), indent=0)
print('written', out, {k: len(v) for k, v in [('accounts',accounts),('expenses',expenses),('income',income),('transfers',transfers)]})

