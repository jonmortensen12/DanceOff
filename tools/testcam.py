#!/usr/bin/env python3
"""Make tools/testcam-cosmo.webm: the dance clip as a webcam would see Cosmo.

A square crop that follows Cosmo (from web/ref.json), smoothed over about a
second so it moves like a slowly panning camera rather than snapping to him.
Everything outside a box round Cosmo is greyed out, so the Cougarettes do
not wander through the shot: one dancer in a living room, not a stadium.
dancecheck.mjs plays it as the camera: a dancer who does Cosmo's moves
exactly, seen through a real pose model, should score high.

    python3 tools/testcam.py          # after tools/reference.mjs

Reads the frames tools/reference.mjs left in tools/cache/frames/ (or
extracts them again). Only the first 24 s of the clip: the check stops at 20.
"""
import json, os, subprocess, sys
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRAMES = os.path.join(ROOT, 'tools/cache/frames')
OUT = os.path.join(ROOT, 'tools/testcam-cosmo.webm')
SECONDS, SIZE = 24, 480

ref = json.load(open(os.path.join(ROOT, 'web/ref.json')))
fps = ref['fps']
n = int(SECONDS * fps)
if not os.path.isdir(FRAMES) or len(os.listdir(FRAMES)) < n:
    os.makedirs(FRAMES, exist_ok=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', os.path.join(ROOT, 'web/media/rolex.mp4'),
                    '-vf', f'fps={fps}', '-q:v', '3', os.path.join(FRAMES, 'f%04d.jpg')], check=True)

W, H = Image.open(os.path.join(FRAMES, 'f0001.jpg')).size
# Cosmo's centre and torso length per frame (13-point layout: 1,2 shoulders; 7,8 hips)
raw = []
for f in ref['frames'][:n]:
    if not f:
        raw.append(None); continue
    sx, sy = (f[1][0] + f[2][0]) / 2 * W, (f[1][1] + f[2][1]) / 2 * H
    hx, hy = (f[7][0] + f[8][0]) / 2 * W, (f[7][1] + f[8][1]) / 2 * H
    raw.append(((sx + hx) / 2, (sy + hy) / 2, ((sx - hx) ** 2 + (sy - hy) ** 2) ** 0.5))
# a box round Cosmo per frame (his points plus a margin), held through gaps
boxes, lastbox = [], None
for f in ref['frames'][:n]:
    if f:
        xs = [p[0] * W for p in f]; ys = [p[1] * H for p in f]
        sx, sy = (f[1][0] + f[2][0]) / 2 * W, (f[1][1] + f[2][1]) / 2 * H
        hx, hy = (f[7][0] + f[8][0]) / 2 * W, (f[7][1] + f[8][1]) / 2 * H
        m = ((sx - hx) ** 2 + (sy - hy) ** 2) ** 0.5   # torso length
        # his points plus a little: the mascot head sits well above the nose
        lastbox = (min(xs) - 0.3 * m, min(ys) - 0.8 * m, max(xs) + 0.3 * m, max(ys) + 0.25 * m)
    boxes.append(lastbox)
boxes = [b or next(x for x in boxes if x) for b in boxes]
# fill gaps from the nearest known frame, then smooth over ~1 s
last = next(r for r in raw if r)
for i, r in enumerate(raw):
    if r: last = r
    else: raw[i] = last
k = fps // 2
smooth = []
for i in range(n):
    win = raw[max(0, i - k): i + k + 1]
    smooth.append(tuple(sum(w[j] for w in win) / len(win) for j in range(3)))

tmp = os.path.join(ROOT, 'tools/cache/testcam')
os.makedirs(tmp, exist_ok=True)
for i, (cx, cy, torso) in enumerate(smooth):
    side = min(H, max(200, 5 * torso))
    cy = cy + 0.08 * side            # the legs are longer below the centre than the head above
    box = (int(cx - side / 2), int(cy - side / 2), int(cx + side / 2), int(cy + side / 2))
    frame = Image.open(os.path.join(FRAMES, 'f%04d.jpg' % (i + 1)))
    grey = Image.new('RGB', frame.size, (92, 104, 96))
    mask = Image.new('L', frame.size, 0)
    ImageDraw.Draw(mask).rectangle([int(v) for v in boxes[i]], fill=255)
    grey.paste(frame, (0, 0), mask)
    grey.crop(box).resize((SIZE, SIZE), Image.BILINEAR) \
        .save(os.path.join(tmp, 'c%04d.jpg' % (i + 1)), quality=90)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', str(fps), '-i', os.path.join(tmp, 'c%04d.jpg'),
                '-c:v', 'libvpx-vp9', '-b:v', '700k', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p', OUT],
               check=True)
print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB')
