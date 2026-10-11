"""D2 pit-camera photos for the truck loads, time-checked (Mario 2026-10-12: re-add them, "ok do it").
The D2 card stores event clips back to back and the old offset estimate was often several clips off, so each event is
now located by matching its app snapshot (whose file name carries the true epoch time) against the video around the
estimated offset. Only events that match are used; the photo is labelled with the snapshot's real time.
python scripts/load-series-d2.py   (after load-series.py)  -> public/excavation/loads/<stem>_d2v<k>.jpg added to loads[].series
"""
import bisect, datetime as dt, glob, json, os, subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LJ = os.path.join(ROOT, 'data', 'excavation-loads.json')
OUT = os.path.join(ROOT, 'public', 'excavation', 'loads')
MAP = 'C:/Users/MARIO_~1/AppData/Local/Temp/claude/d--vscode/8b29d3d7-102e-453d-a28b-5e07fe369946/scratchpad/sd/allcams/plates/d2map.json'
CAM = 'D:/camera/d2/'
SW, SH, SPAN, FPS = 160, 90, 240, 2
FONT = ImageFont.truetype('arialbd.ttf', 26)

EV = sorted((dt.datetime.strptime(e['t'], '%Y-%m-%d %H:%M:%S'), e) for e in json.load(open(MAP)))
TS = [e[0] for e in EV]


def small(img):
    return np.asarray(img.convert('L').resize((SW, SH)), dtype=np.float32)


def locate(e):
    """True offset of the event's snapshot inside its file, or None."""
    ref = small(Image.open(e['snap']))
    t0 = max(0.0, e['off'] - SPAN / 2)
    r = subprocess.run(['ffmpeg', '-v', 'error', '-threads', '2', '-ss', f'{t0:.1f}', '-t', str(SPAN), '-i', CAM + e['file'],
                        '-vf', f'fps={FPS},scale={SW}:{SH},format=gray', '-f', 'rawvideo', '-'], capture_output=True)
    n = len(r.stdout) // (SW * SH)
    if not n: return None
    fr = np.frombuffer(r.stdout[:n * SW * SH], dtype=np.uint8).reshape(n, SH, SW).astype(np.float32)
    d = np.abs(fr - ref).mean(axis=(1, 2))
    i = int(d.argmin())
    srt = np.sort(d)
    # accept a clear, close match only
    return t0 + i / FPS if d[i] < 14 and (len(srt) < 6 or srt[0] < 0.8 * np.median(srt)) else None


def cut(f, off, out, label):
    tmp = out + '.tmp.jpg'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-threads', '2', '-ss', f'{off:.2f}', '-i', CAM + f, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', tmp], capture_output=True)
    if not os.path.exists(tmp): return False
    im = Image.open(tmp).convert('RGB'); d = ImageDraw.Draw(im)
    d.rectangle((0, im.height - 40, im.width, im.height), fill=(0, 0, 0)); d.text((10, im.height - 36), label, fill=(255, 220, 60), font=FONT)
    im.save(out, quality=78); im.close(); os.remove(tmp)
    return True


L = json.load(open(LJ, encoding='utf-8'))
added = checked = rejected = 0
for l in L:
    end = dt.datetime.fromisoformat(f"{l['date']}T{l['time']}:00"); start = end - dt.timedelta(minutes=20)
    stem = (l.get('photo') or f"x/{l['date'].replace('-', '')}_{l['time'].replace(':', '')}.jpg").split('/')[-1][:-4]
    meta = [m for m in (l.get('series_meta') or []) if m[1] != 'D2 (pit)']
    evs = [e for t, e in EV[bisect.bisect_left(TS, start - dt.timedelta(minutes=2)):bisect.bisect_right(TS, end + dt.timedelta(minutes=1))] if os.path.exists(e['snap'])]
    if len(evs) > 6: evs = [evs[round(k * (len(evs) - 1) / 5)] for k in range(6)]
    k = 0
    for e in evs:
        checked += 1
        off = locate(e)
        if off is None: rejected += 1; continue
        t = dt.datetime.strptime(e['t'], '%Y-%m-%d %H:%M:%S')
        for s in (0, min(8, max(2, e['dur'] / 2))):
            tt = t + dt.timedelta(seconds=s); pct = max(0, min(100, round((tt - start).total_seconds() / 12)))
            name = f'{stem}_d2v{k}.jpg'
            if cut(e['file'], off + s, os.path.join(OUT, name), f'{pct}% · D2 (pit) · {tt:%Y-%m-%d %H:%M:%S}'):
                meta.append([name, 'D2 (pit)', tt.isoformat(), pct]); k += 1; added += 1
    meta.sort(key=lambda m: m[2])
    l['series'] = [m[0] for m in meta]; l['series_meta'] = meta
json.dump(L, open(LJ, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(f'{checked} D2 events checked, {rejected} rejected (no clear match), {added} photos added')
