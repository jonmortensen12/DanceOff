#!/usr/bin/env python3
"""Measure a clip's tempo and where its beats fall.

    python3 tools/beats.py web/media/field.mp4 [--from SEC]

Prints the tempo (BPM) and the clip time of the first beat, for
web/songs.json ("bpm", "firstBeat"). Spectral flux (how much louder each
frequency got since the last instant) is the onset signal; its
autocorrelation, checked at 1, 2 and 4 beats, gives the tempo; the phase is
the offset whose beat grid lands on the most onset energy. --from skips an
intro that is not the song (crowd noise, an announcer).
"""
import subprocess, sys
import numpy as np

path = sys.argv[1]
start = float(sys.argv[sys.argv.index('--from') + 1]) if '--from' in sys.argv else 0.0
sr, hop, n = 11025, 256, 1024
pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'],
                     capture_output=True, check=True).stdout
x = np.frombuffer(pcm, dtype=np.float32)
frames = np.lib.stride_tricks.sliding_window_view(x, n)[::hop] * np.hanning(n)
spec = np.log1p(np.abs(np.fft.rfft(frames, axis=1)) * 10)
flux = np.maximum(0, np.diff(spec, axis=0)).sum(1)
flux = np.maximum(flux - np.convolve(flux, np.ones(16) / 16, 'same'), 0)
fr = sr / hop
f = flux[int(start * fr):]
ac = np.correlate(f - f.mean(), f - f.mean(), 'full')[len(f) - 1:]
idx = np.arange(len(ac))
scores = []
for bpm in np.arange(70, 180, 0.25):
    lag = 60 / bpm * fr
    scores.append((sum(np.interp(lag * k, idx, ac) for k in (1, 2, 4)), bpm))
scores.sort(reverse=True)
bpm = scores[0][1]
period = 60 / bpm * fr
fi = np.arange(len(flux))
phase = max((sum(np.interp(np.arange(ph, len(flux), period), fi, flux)), ph) for ph in np.arange(0, period, 0.25))[1]
print(f'{path}: {bpm:.2f} BPM, first beat at {phase / fr:.3f} s   (runners-up: {", ".join(f"{b:.2f}" for _, b in scores[1:5])})')
