#!/usr/bin/env python3
"""Draw a song's Cosmo track over sample frames, to check it by eye.

    python3 tools/sheet.py SONG [OUT.jpg] [--first]

After tools/reference.mjs SONG. Red skeleton = what the game compares
against; it should sit on Cosmo in every tile that says "ok".
"""
import json, os, sys
from PIL import Image, ImageDraw
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = [a for a in sys.argv[1:] if not a.startswith('--')]
song = args[0]
first = '--first' in sys.argv   # pass 1's pick only (tools/reference.mjs SONG --pick --first)
out = args[1] if len(args) > 1 else os.path.join(ROOT, f'tools/cache/{song}/sheet{"-first" if first else ""}.jpg')
ref = json.load(open(os.path.join(ROOT, f'web/ref/{song}.json')))
if first:
    ref['frames'] = json.load(open(os.path.join(ROOT, f'tools/cache/{song}/first.json')))
frames = os.path.join(ROOT, f'tools/cache/{song}/frames')
B = [(1,2),(1,3),(3,5),(2,4),(4,6),(1,7),(2,8),(7,8),(7,9),(9,11),(8,10),(10,12)]
n = len(ref['frames']); fps = ref['fps']
secs = [round(1.5 + k * (n / fps - 2) / 27, 1) for k in range(28)]
tiles = []
for sec in secs:
    i = min(n - 1, int(sec * fps))
    im = Image.open(os.path.join(frames, 'f%04d.jpg' % (i + 1))).resize((320, 180)); d = ImageDraw.Draw(im)
    f = ref['frames'][i]
    if f:
        for a, b in B:
            if f[a][2] > .5 and f[b][2] > .5:
                d.line([f[a][0]*320, f[a][1]*180, f[b][0]*320, f[b][1]*180], fill=(255, 0, 0), width=3)
    d.text((4, 4), f"{sec}s {'ok' if f else 'NONE'}", fill=(255, 255, 0))
    tiles.append(im)
sheet = Image.new('RGB', (320 * 4, 180 * 7))
for k, t in enumerate(tiles): sheet.paste(t, ((k % 4) * 320, (k // 4) * 180))
sheet.save(out); print(out)
