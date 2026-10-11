"""Truck-load photo series (Mario 2026-10-11: "for every truck loaded, 5 pictures: 0% 20% 40% 60% 80%, from
different angles"). Loading is taken as the 20 min before the truck left (load.time); frames at 0/20/40/60/80 % of
that window are cut from the SD videos of up to two close cameras (D2 up, D3 up; d1 up before September), 1024 px.
python scripts/load-series.py   -> public/excavation/loads/<stem>_p<k>_<cam>.jpg and loads[].series (+ series_meta)
"""
import bisect, datetime as dt, glob, json, os, subprocess
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LJ = os.path.join(ROOT, 'data', 'excavation-loads.json')
OUT = os.path.join(ROOT, 'public', 'excavation', 'loads')
SRC = {'D2 up': 'D:/camera/d2 up', 'D3 up': 'D:/camera/d3 up', 'd1 up': 'D:/camera/d1 up'}
W, LOAD_MIN = 1024, 20
FONT = ImageFont.truetype('arialbd.ttf', 24)
FILES = {}
for c, d in SRC.items():
    fs = sorted(glob.glob(d + '/2026*.mp4'))
    FILES[c] = ([dt.datetime.strptime(os.path.basename(f)[:15], '%Y%m%d_%H%M%S') for f in fs], fs)
DUR = {}


def locate(cam, t):
    starts, fs = FILES[cam]
    i = bisect.bisect_right(starts, t) - 1
    if i < 0: return None, None
    f = fs[i]
    if f not in DUR:
        DUR[f] = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], capture_output=True, text=True).stdout or 0)
    off = (t - starts[i]).total_seconds()
    return (f, off) if 0 <= off < DUR[f] - 1 else (None, None)


def cut(job):
    name, cam, t, pct = job
    f, off = locate(cam, t)
    if not f: return name, False
    tmp = os.path.join(OUT, name + '.tmp.jpg')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-threads', '2', '-ss', f'{off:.1f}', '-i', f, '-frames:v', '1', '-vf', f'scale={W}:-2', '-q:v', '4', tmp], capture_output=True)
    if not os.path.exists(tmp): return name, False
    im = Image.open(tmp).convert('RGB'); d = ImageDraw.Draw(im)
    d.rectangle((0, 0, im.width, 34), fill=(0, 0, 0)); d.text((8, 4), f'{pct}% loaded · {cam} · {t:%Y-%m-%d %H:%M:%S}', fill=(255, 220, 60), font=FONT)
    im.save(os.path.join(OUT, name), quality=74); im.close(); os.remove(tmp)
    return name, True


L = json.load(open(LJ, encoding='utf-8'))
jobs, plan = [], {}
for i, l in enumerate(L):
    end = dt.datetime.fromisoformat(f"{l['date']}T{l['time']}:00")
    start = end - dt.timedelta(minutes=LOAD_MIN)
    cams = ['D2 up', 'D3 up'] if l['date'] >= '2026-09-02' else ['d1 up']
    stem = (l.get('photo') or f"x/{l['date'].replace('-', '')}_{l['time'].replace(':', '')}.jpg").split('/')[-1][:-4]
    plan[i] = []
    for k, pct in enumerate((0, 20, 40, 60, 80)):
        t = start + (end - start) * pct / 100
        for c in cams:
            name = f'{stem}_p{pct:02d}_{c.replace(" ", "").lower()}.jpg'
            jobs.append((name, c, t, pct)); plan[i].append((name, c, t.isoformat(), pct))
ok = set()
with ThreadPoolExecutor(3) as ex:
    for name, good in ex.map(cut, jobs):
        if good: ok.add(name)
for i, l in enumerate(L):
    got = [p for p in plan[i] if p[0] in ok]
    l['series'] = [p[0] for p in got]; l['series_meta'] = got
json.dump(L, open(LJ, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(jobs), 'frames planned,', len(ok), 'cut;', sum(1 for l in L if l['series']), 'of', len(L), 'loads have a series')
