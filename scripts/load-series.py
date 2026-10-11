"""Truck-load photo series from ALL cameras (Mario 2026-10-11: "for every truck loaded, 5 pictures 0-80 %, from
different angles" -> "add more photos from all cameras, to see all the phases of the truck filling").
Loading is taken as the 20 min before the truck left (load.time). For each load:
  - the closest continuous camera that recorded (D2 up, D3 up, else d1 up): every 10 % (0-90 %)
  - the other close continuous cameras: every 20 % (0-80 %)
  - U3 up (far overview): 0 / 40 / 80 %
  - D2 pit camera (event clips): up to 5 clips in the window
  - D1 Entrance (event frames, from 28 Aug): up to 3 frames in the window
1024 px, time-sorted; the departure photo stays last in the viewer. Old series files are replaced.
python scripts/load-series.py   -> public/excavation/loads/<stem>_*.jpg and loads[].series (+ series_meta)
"""
import bisect, datetime as dt, glob, json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LJ = os.path.join(ROOT, 'data', 'excavation-loads.json')
OUT = os.path.join(ROOT, 'public', 'excavation', 'loads')
SPD = 'C:/Users/MARIO_~1/AppData/Local/Temp/claude/d--vscode/8b29d3d7-102e-453d-a28b-5e07fe369946/scratchpad'
sys.path.insert(0, SPD)
import d2clip  # noqa: E402  segments(t0, t1) -> [(file, offset, length, start)]

SRC = {'D2 up': 'D:/camera/d2 up', 'D3 up': 'D:/camera/d3 up', 'd1 up': 'D:/camera/d1 up', 'U3 up': 'D:/camera/u3 up'}
W, LOAD_MIN = 1024, 20
FONT = ImageFont.truetype('arialbd.ttf', 24)
FILES = {}
for c, d in SRC.items():
    fs = sorted(glob.glob(d + '/2026*.mp4'))
    FILES[c] = ([dt.datetime.strptime(os.path.basename(f)[:15], '%Y%m%d_%H%M%S') for f in fs], fs)
DUR, RATE = {}, {}


def probe(f, what):
    return subprocess.run(['ffprobe', '-v', 'error'] + what + ['-of', 'csv=p=0', f], capture_output=True, text=True).stdout.strip()


def locate(cam, t):
    starts, fs = FILES[cam]
    i = bisect.bisect_right(starts, t) - 1
    if i < 0: return None, None
    f = fs[i]
    if f not in DUR: DUR[f] = float(probe(f, ['-show_entries', 'format=duration']) or 0)
    off = (t - starts[i]).total_seconds()
    return (f, off) if 0 <= off < DUR[f] - 1 else (None, None)


ENT = []  # (time, video, frame-number)
for e in json.load(open(SPD + '/sd/d1 entrance_idx.json'))['events']:
    for tt, pth in e['frames']:
        ENT.append((dt.datetime.fromisoformat(e['start'][:10] + 'T' + tt), os.path.basename(os.path.dirname(pth)), int(os.path.basename(pth)[:-4])))
ENT.sort()


def ent_frames(t0, t1, n=3):
    xs = ENT[bisect.bisect_left(ENT, (t0,)):bisect.bisect_right(ENT, (t1, 'zzzz', 0))]
    if len(xs) > n: xs = [xs[round(k * (len(xs) - 1) / (n - 1))] for k in range(n)]
    out = []
    for t, stem, fr in xs:
        f = f'D:/camera/d1 entrance/{stem}.mp4'
        if not os.path.exists(f): continue
        if f not in RATE:
            a, b = (probe(f, ['-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate']).split('/') + ['1'])[:2]
            RATE[f] = float(a) / float(b)
        out.append((t, f, fr / RATE[f]))
    return out


def cut(job):
    name, f, off, label = job
    tmp = os.path.join(OUT, name + '.tmp.jpg')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-threads', '2', '-ss', f'{max(0, off):.1f}', '-i', f, '-frames:v', '1', '-vf', f'scale={W}:-2', '-q:v', '4', tmp], capture_output=True)
    if not os.path.exists(tmp): return name, False
    im = Image.open(tmp).convert('RGB'); d = ImageDraw.Draw(im)
    d.rectangle((0, 0, im.width, 34), fill=(0, 0, 0)); d.text((8, 4), label, fill=(255, 220, 60), font=FONT)
    im.save(os.path.join(OUT, name), quality=72); im.close(); os.remove(tmp)
    return name, True


L = json.load(open(LJ, encoding='utf-8'))
for l in L:  # drop the previous series files
    for n in l.get('series') or []:
        p = os.path.join(OUT, n)
        if os.path.exists(p): os.remove(p)
jobs, plan = [], {}
for i, l in enumerate(L):
    end = dt.datetime.fromisoformat(f"{l['date']}T{l['time']}:00")
    start = end - dt.timedelta(minutes=LOAD_MIN)
    at = lambda pct: start + (end - start) * pct / 100
    stem = (l.get('photo') or f"x/{l['date'].replace('-', '')}_{l['time'].replace(':', '')}.jpg").split('/')[-1][:-4]
    plan[i] = []

    def add(name, f, off, cam, t, pct):
        jobs.append((name, f, off, f'{pct}% loaded · {cam} · {t:%Y-%m-%d %H:%M:%S}')); plan[i].append((name, cam, t.isoformat(), pct))
    close = [c for c in ('D2 up', 'D3 up', 'd1 up') if locate(c, at(50))[0]]
    for k, c in enumerate(close):
        for pct in (range(0, 100, 10) if k == 0 else range(0, 100, 20)):
            f, off = locate(c, at(pct))
            if f: add(f'{stem}_p{pct:02d}_{c.replace(" ", "").lower()}.jpg', f, off, c, at(pct), pct)
    for pct in (0, 40, 80):
        f, off = locate('U3 up', at(pct))
        if f: add(f'{stem}_p{pct:02d}_u3up.jpg', f, off, 'U3 up', at(pct), pct)
    segs = d2clip.segments(start - dt.timedelta(minutes=2), end + dt.timedelta(minutes=1))
    if len(segs) > 5: segs = [segs[round(k * (len(segs) - 1) / 4)] for k in range(5)]
    for k, (f, off, ln, st) in enumerate(segs):
        s = min(max(ln, 0) / 2, 8); t = dt.datetime.fromisoformat(st.replace(' ', 'T')) + dt.timedelta(seconds=s)
        add(f'{stem}_d2_{k}.jpg', f, off + s, 'D2 (pit)', t, max(0, min(100, round((t - start).total_seconds() / 12))))
    for k, (t, f, off) in enumerate(ent_frames(start, end)):
        add(f'{stem}_ent_{k}.jpg', f, off, 'Entrance', t, max(0, min(100, round((t - start).total_seconds() / 12))))
ok = set()
with ThreadPoolExecutor(3) as ex:
    for name, good in ex.map(cut, jobs):
        if good: ok.add(name)
for i, l in enumerate(L):
    got = sorted([p for p in plan[i] if p[0] in ok], key=lambda p: p[2])
    l['series'] = [p[0] for p in got]; l['series_meta'] = got
json.dump(L, open(LJ, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
n = [len(l['series']) for l in L]
print(len(jobs), 'frames planned,', len(ok), 'cut;', sum(1 for x in n if x), 'of', len(L), 'loads have a series; min/avg/max', min(n), round(sum(n) / len(n), 1), max(n))
