"""Photos from every camera for each car visit (Mario 2026-10-11: "show more photos from diff cameras for this event").
For each car day (RAV4, BMW, Tacoma, Dodge) and each known arrival / departure time, one frame from every camera that
recorded then: continuous d1 up, D2 up, D3 up, U3 up (cut from the SD video), D1 Entrance (nearest event frame within
90 s) and D2 (nearest app snapshot within 90 s; its file name carries the true epoch time).
python scripts/car-series.py [car …]   -> public/excavation/<car>/<YYYYMMDD>_<a|l><HHMM><cam>.jpg and days[].series (+ series_meta)
"""
import bisect, datetime as dt, glob, json, os, re, subprocess
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPD = 'C:/Users/MARIO_~1/AppData/Local/Temp/claude/d--vscode/8b29d3d7-102e-453d-a28b-5e07fe369946/scratchpad'
CARS = {'georges': 'georges.json', 'bmw': 'bmw.json', 'tacoma': 'tacoma.json', 'dodge': 'dodge.json', 'visitors': 'visitors.json'}
SRC = {'d1 up': ('D:/camera/d1 up', 'u1'), 'D2 up': ('D:/camera/d2 up', 'u2'), 'D3 up': ('D:/camera/d3 up', 'u3'), 'U3 up': ('D:/camera/u3 up', 'o3')}
W = 1024
FONT = ImageFont.truetype('arialbd.ttf', 24)
FILES = {c: (lambda fs: ([dt.datetime.strptime(os.path.basename(f)[:15], '%Y%m%d_%H%M%S') for f in fs], fs))(sorted(glob.glob(d + '/2026*.mp4'))) for c, (d, _) in SRC.items()}
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


ENT = []
for e in json.load(open(SPD + '/sd/d1 entrance_idx.json'))['events']:
    for tt, pth in e['frames']:
        ENT.append((dt.datetime.fromisoformat(e['start'][:10] + 'T' + tt), os.path.basename(os.path.dirname(pth)), int(os.path.basename(pth)[:-4])))
ENT.sort()
SNAP = sorted((dt.datetime.fromtimestamp(int(os.path.basename(p).split('_')[0])), p) for p in glob.glob('D:/camera/d2/snapshot/2026*/*/*.jpg'))


def nearest(lst, t, win=90):
    i = bisect.bisect_left(lst, (t,))
    c = [x for x in lst[max(0, i - 3):i + 3] if abs((x[0] - t).total_seconds()) <= win]
    return min(c, key=lambda x: abs((x[0] - t).total_seconds())) if c else None


def save(im, out, label):
    im = im.convert('RGB'); im.thumbnail((W, W)); d = ImageDraw.Draw(im)
    d.rectangle((0, im.height - 34, im.width, im.height), fill=(0, 0, 0)); d.text((8, im.height - 31), label, fill=(255, 220, 60), font=FONT)
    im.save(out, quality=74)


def job(j):
    out, kind, src, off, label = j
    if kind == 'img':
        save(Image.open(src), out, label); return out, True
    tmp = out + '.tmp.jpg'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-threads', '2', '-ss', f'{max(0, off):.1f}', '-i', src, '-frames:v', '1', '-vf', f'scale={W}:-2', '-q:v', '4', tmp], capture_output=True)
    if not os.path.exists(tmp): return out, False
    save(Image.open(tmp), out, label); os.remove(tmp); return out, True


jobs, plan = [], {}
data = {}
import sys
for car, fn in CARS.items():
    if sys.argv[1:] and car not in sys.argv[1:]: continue
    p = os.path.join(ROOT, 'data', fn)
    if not os.path.exists(p): continue
    G = json.load(open(p, encoding='utf-8')); data[car] = (p, G)
    od = os.path.join(ROOT, 'public', 'excavation', car)
    for di, d in enumerate(G['days']):
        if not d.get('present'): continue
        for n in d.get('series') or []:
            q = os.path.join(od, n)
            if os.path.exists(q) and n != d.get('photo'): os.remove(q)
        plan[(car, di)] = []
        times = []
        for v in d.get('visits') or []:
            for tag, s in (('a', v.get('arrive')), ('l', v.get('leave'))):
                m = re.match(r'(\d{1,2}):(\d{2})', s or '')
                if m: times.append((tag, dt.datetime.fromisoformat(f"{d['date']}T{int(m[1]):02d}:{m[2]}:00")))
        for tag, t in times:
            base = f"{d['date'].replace('-', '')}_{tag}{t:%H%M}"
            what = 'arrives' if tag == 'a' else 'leaves'
            for cam, (_, short) in SRC.items():
                f, off = locate(cam, t + dt.timedelta(seconds=30))
                if f:
                    jobs.append((os.path.join(od, base + short + '.jpg'), 'vid', f, off, f'{cam} · {t:%Y-%m-%d %H:%M} · {what}'))
                    plan[(car, di)].append((base + short + '.jpg', cam, t.isoformat()))
            e = nearest(ENT, t)
            if e and os.path.exists(f'D:/camera/d1 entrance/{e[1]}.mp4'):
                f = f'D:/camera/d1 entrance/{e[1]}.mp4'
                if f not in RATE:
                    a, b = (probe(f, ['-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate']).split('/') + ['1'])[:2]; RATE[f] = float(a) / float(b)
                jobs.append((os.path.join(od, base + 'en.jpg'), 'vid', f, e[2] / RATE[f], f'Entrance · {e[0]:%Y-%m-%d %H:%M:%S} · {what}'))
                plan[(car, di)].append((base + 'en.jpg', 'Entrance', e[0].isoformat()))
            s = nearest(SNAP, t)
            if s:
                jobs.append((os.path.join(od, base + 'd2.jpg'), 'img', s[1], 0, f'D2 (pit) · {s[0]:%Y-%m-%d %H:%M:%S} · {what}'))
                plan[(car, di)].append((base + 'd2.jpg', 'D2', s[0].isoformat()))
ok = set()
with ThreadPoolExecutor(3) as ex:
    for out, good in ex.map(job, jobs):
        if good: ok.add(os.path.basename(out))
for car, (p, G) in data.items():
    for di, d in enumerate(G['days']):
        got = [x for x in plan.get((car, di), []) if x[0] in ok]
        d['series'] = [x[0] for x in got]; d['series_meta'] = got
    json.dump(G, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(jobs), 'frames planned,', len(ok), 'cut')
