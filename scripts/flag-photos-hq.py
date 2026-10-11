"""Higher-quality photos for the suspicious events (Mario 2026-10-11: "upload higher quality to hub").
Every series frame from a continuous camera (d1 up, D2 up, D3 up, U3 up) is re-cut from the SD-card video at 1280 px,
and an event whose main photo is a small app thumbnail gets the first such frame as its main photo.
python scripts/flag-photos-hq.py
"""
import bisect, datetime as dt, glob, json, os, re, subprocess
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FL = os.path.join(ROOT, 'data', 'excavation-flags.json')
OUT = os.path.join(ROOT, 'public', 'excavation', 'flags')
SRC = {'d1 up': 'D:/camera/d1 up', 'D2 up': 'D:/camera/d2 up', 'D3 up': 'D:/camera/d3 up', 'U3 up': 'D:/camera/u3 up'}
W = 1280
FONT = ImageFont.truetype('arialbd.ttf', 28)
FILES = {}
for c, d in SRC.items():
    fs = sorted(glob.glob(d + '/2026*.mp4'))
    FILES[c] = ([dt.datetime.strptime(os.path.basename(f)[:15], '%Y%m%d_%H%M%S') for f in fs], fs)


def locate(cam, t):
    starts, fs = FILES[cam]
    i = bisect.bisect_right(starts, t) - 1
    return (fs[i], (t - starts[i]).total_seconds()) if i >= 0 else (None, None)


SD = 'C:/Users/MARIO_~1/AppData/Local/Temp/claude/d--vscode/8b29d3d7-102e-453d-a28b-5e07fe369946/scratchpad/sd'
ENTP = {}
for e in json.load(open(SD + '/d1 entrance_idx.json'))['events']:
    for tt, pth in e['frames']: ENTP[e['start'][:10] + 'T' + tt] = pth
RATE = {}


def locate_ent(t):
    pth = ENTP.get(t.isoformat())
    if not pth: return None, None
    stem = os.path.basename(os.path.dirname(pth)); f = f'D:/camera/d1 entrance/{stem}.mp4'
    if f not in RATE:
        r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', f], capture_output=True, text=True).stdout.strip()
        a, b = (r.split('/') + ['1'])[:2]; RATE[f] = float(a) / float(b)
    return f, int(os.path.basename(pth)[:-4]) / RATE[f]


def cut(job):
    name, cam, t = job
    f, off = locate_ent(t) if cam == 'Entrance' else locate(cam, t)
    if not f or off > 12 * 3600: return name, False
    tmp = os.path.join(OUT, name + '.tmp.jpg')
    r = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{off:.1f}', '-i', f, '-frames:v', '1', '-vf', f'scale={W}:-2', '-q:v', '4', tmp], capture_output=True)
    if r.returncode or not os.path.exists(tmp): return name, False
    im = Image.open(tmp).convert('RGB'); d = ImageDraw.Draw(im)
    d.rectangle((0, 0, im.width, 40), fill=(0, 0, 0)); d.text((8, 4), f'{cam}  {t:%Y-%m-%d %H:%M:%S}', fill=(255, 220, 60), font=FONT)
    im.save(os.path.join(OUT, name), quality=78); im.close()
    os.remove(tmp)
    return name, True


F = json.load(open(FL, encoding='utf-8'))
jobs = []
for f in F:
    meta = f.get('series_meta') or []
    for n, cam, iso in meta:
        if cam in SRC or cam == 'Entrance': jobs.append((n, cam, dt.datetime.fromisoformat(iso)))
print(len(jobs), 'frames to re-cut')
ok = 0
with ThreadPoolExecutor(4) as ex:
    for name, good in ex.map(cut, jobs): ok += good
print(ok, 'done')
for f in F:
    meta = [m for m in (f.get('series_meta') or []) if m[1] in SRC or m[1] == 'Entrance']
    p = os.path.join(OUT, f.get('photo') or '')
    if meta and f.get('photo') and os.path.exists(p):
        with Image.open(p) as im: small = im.width < 1000
        if small:
            mid = meta[len(meta) // 2][0]
            f['photo_low'] = f['photo']; f['photo'] = mid
            f['series'] = [n for n in f['series'] if n != mid] + [f['photo_low']]
json.dump(F, open(FL, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
