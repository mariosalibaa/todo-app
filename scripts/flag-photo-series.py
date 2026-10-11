"""For every suspicious event, add a short series of camera frames from the event window (Mario 2026-10-11:
"show more photos with arrows left right").
python scripts/flag-photo-series.py <scratchpad sd folder>
-> public/excavation/flags/<stem>_sNN.jpg (720 px, time + camera burned in) and flags[].series = [names]
Sources: d1 up / D2 up / D3 up / U3 up (continuous frame indexes), D1 Entrance and D2 (event frames).
"""
import bisect, datetime as dt, json, os, re, sys
from PIL import Image, ImageDraw, ImageFont

SD = sys.argv[1]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FL = os.path.join(ROOT, 'data', 'excavation-flags.json')
OUT = os.path.join(ROOT, 'public', 'excavation', 'flags')
MAX_PER_CAM, MAX_TOTAL, W = 6, 10, 720
FONT = ImageFont.truetype('arialbd.ttf', 20)


def load_cont(name):
    p = os.path.join(SD, name)
    if not os.path.exists(p): return None
    rows = json.load(open(p)); return [r[0] for r in rows], rows


CONT = {'d1 up': load_cont('up_frames.json'), 'D2 up': load_cont('d2 up_frames.json'),
        'D3 up': load_cont('d3 up_frames.json'), 'U3 up': load_cont('u3 up_frames.json')}
ent = json.load(open(os.path.join(SD, 'd1 entrance_idx.json')))['events']
ENT = []
for e in ent:
    day = e['start'][:10]
    for t, f in e['frames']: ENT.append((day + 'T' + t, f))
ENT.sort()
D2 = sorted((e['start'].replace(' ', 'T'), e['f']) for e in json.load(open(os.path.join(SD, 'snap', 'd2.json'))))
EVT = {'Entrance': ([r[0] for r in ENT], ENT), 'D2': ([r[0] for r in D2], D2)}


def cams_of(s):
    s = s.lower(); out = []
    if 'd1 up' in s: out.append('d1 up')
    if re.search(r'd2[ _]?up', s): out.append('D2 up')
    if re.search(r'd3 up', s) or 'd2-d3 + d3' in s: out.append('D3 up')
    if 'u3' in s: out.append('U3 up')
    if 'entrance' in s: out.append('Entrance')
    if re.search(r'\bd2\b(?![ _-]?(up|d3))', s) or s.strip().startswith('d2 (') or s.strip() == 'd2': out.append('D2')
    return out or ['D2 up', 'D3 up']


def window(date, tstr):
    ts = re.findall(r'(\d{1,2}):(\d{2})', tstr)
    if not ts: return None
    t = [dt.datetime.fromisoformat(f'{date}T{int(h):02d}:{m}:00') for h, m in ts]
    a, b = min(t), max(t)
    if b - a < dt.timedelta(minutes=4): a -= dt.timedelta(minutes=2); b += dt.timedelta(minutes=3)
    if b - a > dt.timedelta(hours=3): b = a + dt.timedelta(hours=3)
    return a, b


def pick(idx, a, b, n):
    keys, rows = idx
    i, j = bisect.bisect_left(keys, a.isoformat()), bisect.bisect_right(keys, b.isoformat())
    sel = rows[i:j]
    if len(sel) <= n: return sel
    return [sel[round(k * (len(sel) - 1) / (n - 1))] for k in range(n)]


F = json.load(open(FL, encoding='utf-8'))
done = 0
for f in F:
    w = window(f['date'], f.get('time', ''))
    if not w: continue
    frames = []
    for c in cams_of(f.get('camera', '')):
        idx = CONT.get(c) or EVT.get(c)
        if not idx: continue
        frames += [(c, t, p) for t, p in pick(idx, *w, MAX_PER_CAM)]
    frames = sorted(frames, key=lambda x: x[1])[:MAX_TOTAL]
    stem = (f.get('photo') or f"{f['date'].replace('-', '')}_{abs(hash(f['what'])) % 10**6}.jpg")[:-4]
    names, meta = [], []
    for k, (c, t, p) in enumerate(frames):
        try: im = Image.open(p).convert('RGB')
        except Exception: continue
        im.thumbnail((W, W)); d = ImageDraw.Draw(im)
        d.rectangle((0, 0, im.width, 28), fill=(0, 0, 0)); d.text((6, 3), f'{c}  {t.replace("T", " ")}', fill=(255, 220, 60), font=FONT)
        name = f'{stem}_s{k:02d}.jpg'; im.save(os.path.join(OUT, name), quality=70); names.append(name); meta.append([name, c, t])
    f['series'] = names; f['series_meta'] = meta; done += bool(names)
json.dump(F, open(FL, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(done, 'events with a series of', sum(len(f.get('series', [])) for f in F), 'frames')
