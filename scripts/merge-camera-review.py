"""Merge a camera review's days.json into the hub data (Ajaltoun machines page).
python scripts/merge-camera-review.py <days.json> [<days.json> ...]
- data/excavation-days.json: hitachi / komatsu / loads / cams / notes / confidence per day (old figures kept in d1up)
- data/excavation-flags.json: suspicious items with an image (resized into public/excavation/flags/)
"""
import json, os, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DAYS = os.path.join(ROOT, 'data', 'excavation-days.json')
FLAGS = os.path.join(ROOT, 'data', 'excavation-flags.json')
FDIR = os.path.join(ROOT, 'public', 'excavation', 'flags')

D = json.load(open(DAYS, encoding='utf-8'))
F = json.load(open(FLAGS, encoding='utf-8'))
by = {d['date']: d for d in D['days']}
for src in sys.argv[1:]:
    for r in json.load(open(src, encoding='utf-8')):
        d = by.get(r['date'])
        if d is None:
            continue
        d.setdefault('d1up', dict(hitachi=d.get('hitachi'), komatsu=d.get('komatsu'), loads=d.get('loads')))
        for k in ('hitachi', 'komatsu', 'loads'):
            if r.get(k) is not None:
                d[k] = r[k]
        d['cams'] = r.get('cameras_used') or d.get('cams')
        d['notes'] = r.get('notes') or d.get('notes')
        d['confidence'] = r.get('confidence') or d.get('confidence')
        if any(r.get(k) is not None for k in ('hitachi', 'komatsu')):
            d.pop('range', None)
            d['est'] = False
        n = 0
        for s in r.get('suspicious') or []:
            if not s.get('image_path') or not os.path.exists(s['image_path']):
                continue
            tag = os.path.basename(os.path.dirname(src)).replace('_', '')[-6:]   # e.g. d2upb / d3u3b — unique per review
            name = f"{r['date'].replace('-', '')}_{tag}{n:02d}.jpg"; n += 1
            im = Image.open(s['image_path']).convert('RGB'); im.thumbnail((1100, 1100)); im.save(os.path.join(FDIR, name), quality=80)
            F = [f for f in F if f.get('photo') != name]
            F.append(dict(date=r['date'], time=s.get('time', ''), camera=s.get('camera', ''), what=s.get('what', ''), photo=name, strong=bool(s.get('strong'))))
F.sort(key=lambda f: (f['date'], f['time']))
json.dump(D, open(DAYS, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
json.dump(F, open(FLAGS, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(F), 'flags')
