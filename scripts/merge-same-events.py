"""Combine suspicious events that are the same moment seen by several cameras / reviews into one line
(Mario 2026-10-11: "combine the same event in one line"). Same date + overlapping time windows → one event:
cameras joined, descriptions kept (duplicates dropped), strong/theft = any, all photos in one series.
python scripts/merge-same-events.py
"""
import json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FL = os.path.join(ROOT, 'data', 'excavation-flags.json')
F = json.load(open(FL, encoding='utf-8'))


def win(f):
    ts = [int(h) * 60 + int(m) for h, m in re.findall(r'(\d{1,2}):(\d{2})', f.get('time', ''))]
    if not ts: return None
    a, b = min(ts), max(ts)
    return a, max(b, a + 3)


def cams(s):
    return [c.strip(' ()+') for c in re.split(r'\+|,|\(|\)', s or '') if c.strip(' ()+')]


out, used = [], set()
F.sort(key=lambda f: (f['date'], (win(f) or (9999, 0))[0]))
for i, f in enumerate(F):
    if i in used: continue
    g = [f]; w = win(f)
    if w:
        for j in range(i + 1, len(F)):
            h = F[j]; v = win(h)
            if j in used or h['date'] != f['date'] or not v: continue
            if v[0] <= w[1] + 2 and v[1] >= w[0] - 2:
                g.append(h); used.add(j); w = (min(w[0], v[0]), max(w[1], v[1]))
    if len(g) == 1: out.append(f); continue
    m = dict(g[0])
    a, b = w
    m['time'] = f'{a // 60:02d}:{a % 60:02d}-{b // 60:02d}:{b % 60:02d}'
    cs = []
    for x in g:
        for c in cams(x.get('camera')):
            c = c.replace('D2_Up', 'D2 up').replace('d2 up', 'D2 up')
            if c not in cs: cs.append(c)
    m['camera'] = ' + '.join(cs)
    texts = []
    for x in g:
        t = x['what'].strip()
        if not any(t[:60] in y or y[:60] in t for y in texts): texts.append(t)
    m['what'] = ' ‖ '.join(texts)
    for k in ('strong', 'theft', 'explained'): m[k] = any(x.get(k) for x in g)
    photos, meta = [], []
    for x in g:
        for p in [x.get('photo')] + (x.get('series') or []) + [x.get('photo_low')]:
            if p and p not in photos: photos.append(p)
        meta += x.get('series_meta') or []
    m['photo'] = photos[0]; m['series'] = photos[1:]; m['series_meta'] = meta; m.pop('photo_low', None)
    m['merged'] = len(g)
    out.append(m)
json.dump(out, open(FL, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(F), '->', len(out), 'events')
