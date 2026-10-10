"""Re-run diesel vs machine-hours between fills from data/excavation-days.json (all cameras combined).
python scripts/recompute-diesel.py   -> updates intervals in data/excavation-diesel.json and prints the totals
Expected: Hitachi with breaker 24 L/h, Komatsu 17 L/h. Days with no camera at all use the month average.
"""
import datetime as dt, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = json.load(open(os.path.join(ROOT, 'data', 'excavation-days.json'), encoding='utf-8'))['days']
P = os.path.join(ROOT, 'data', 'excavation-diesel.json')
X = json.load(open(P, encoding='utf-8'))
day = {d['date']: d for d in D}


def avg(m, k):
    v = [d[k] for d in D if d['date'].startswith(m) and d['hitachi'] is not None]
    return sum(v) / len(v)


fills = [(f['date'], f['litres']) for f in X['fills'] if f['date'] >= '2026-08-08']
prev = dt.date(2026, 8, 1); ints = []
for fd, L in fills:
    e = dt.date.fromisoformat(fd); s = prev + dt.timedelta(1); H = K = 0; nf = 0; d = s
    while d <= e:
        k = str(d); x = day.get(k)
        if x is None or x['hitachi'] is None:
            if k >= '2026-08-03': nf += 1
            H += avg(k[:7], 'hitachi'); K += avg(k[:7], 'komatsu')
        else:
            H += x['hitachi']; K += x['komatsu']
        d += dt.timedelta(1)
    exp = H * 24 + K * 17
    ints.append(dict(fill=fd, litres=L, start=str(s), end=fd, hit=round(H, 1), kom=round(K, 1), hours=round(H + K, 1),
                     lph=round(L / (H + K), 1) if H + K else None, expected=round(exp), diff=round(L - exp), nofootage=nf))
    prev = e
X['intervals'] = ints
json.dump(X, open(P, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
tL = sum(i['litres'] for i in ints); tH = sum(i['hours'] for i in ints); tE = sum(i['expected'] for i in ints)
for i in ints: print(i['fill'], i['litres'], i['hours'], i['lph'], i['expected'], i['diff'])
print('TOTAL', tL, round(tH, 1), round(tL / tH, 1), tE, tL - tE)
