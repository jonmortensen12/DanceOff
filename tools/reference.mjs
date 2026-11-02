// The reference pass: turns the dance clip into Cosmo's pose, frame by frame.
//
//   node tools/reference.mjs            # detect (slow, cached) + pick Cosmo -> web/ref.json
//   node tools/reference.mjs --pick     # only re-run the picking, from the cache
//
// Step 1 (detect) extracts the clip's frames with ffmpeg, runs every frame
// through MediaPipe's *heavy* pose model in headless Chromium (the game uses
// lite/full live; heavy is only worth its 30 MB offline) and keeps every
// person found, with how tan their limbs are. Cached in tools/cache/.
//
// Step 2 (crops) runs the model again on a square crop round where Cosmo
// is (interpolated across frames where step 1 lost him): there he fills the
// picture and is found nearly every frame. Cached in tools/cache/crops.json.
//
// Step 3 (pick) follows Cosmo through the clip: he is the one with tan fur on
// his legs and forearms (the Cougarettes wear navy), he starts near the
// middle, and he does not teleport between frames. Then the picked track is
// cleaned (short gaps filled, jitter smoothed) and written to web/ref.json.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'tools/cache');
const FRAMES = path.join(CACHE, 'frames');
const RAW = path.join(CACHE, 'raw.json');
const CLIP = path.join(ROOT, 'web/media/rolex.mp4');
const FPS = 30;

async function detect() {
  fs.mkdirSync(FRAMES, { recursive: true });
  for (const f of fs.readdirSync(FRAMES)) fs.unlinkSync(path.join(FRAMES, f));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', CLIP, '-vf', `fps=${FPS}`, '-q:v', '3',
    path.join(FRAMES, 'f%04d.jpg')]);
  const count = fs.readdirSync(FRAMES).length;
  const model = fs.existsSync(path.join(CACHE, 'pose_heavy.task')) ? '/tools/cache/pose_heavy.task' : '/web/models/pose_full.task';
  console.log(count, 'frames, model', model, '(put pose_heavy.task in tools/cache/ for the best reference)');
  const { server, url } = await serve(ROOT, { '/frames/': FRAMES });
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', m => console.log('  page:', m.text()));
  page.on('pageerror', e => console.log('  page error:', e.message));
  await page.goto(url + '/tools/extract.html');
  await page.waitForFunction(() => window.ready);
  const t0 = Date.now();
  const raw = await page.evaluate(([c, f, m]) => window.runAll(c, f, m), [count, FPS, model]);
  console.log('detected in', ((Date.now() - t0) / 1000).toFixed(0), 's');
  await browser.close(); server.close();
  fs.writeFileSync(RAW, JSON.stringify({ fps: FPS, frames: raw }));
}

// ---- picking Cosmo ----
const L_SH = 11, R_SH = 12, L_HIP = 23, R_HIP = 24;
function centre(lm) {
  const pts = [L_SH, R_SH, L_HIP, R_HIP].map(i => lm[i]);
  return [pts.reduce((s, p) => s + p[0], 0) / 4, pts.reduce((s, p) => s + p[1], 0) / 4];
}
function size(lm) {        // shoulder-to-hip length, a scale that survives arms flying about
  const s = [(lm[L_SH][0] + lm[R_SH][0]) / 2, (lm[L_SH][1] + lm[R_SH][1]) / 2];
  const h = [(lm[L_HIP][0] + lm[R_HIP][0]) / 2, (lm[L_HIP][1] + lm[R_HIP][1]) / 2];
  return Math.hypot(s[0] - h[0], (s[1] - h[1]) * 9 / 16);
}

function pick(raw) {
  const frames = raw.frames;
  const track = new Array(frames.length).fill(null);
  const why = [];
  let prev = null, lost = 0;
  for (let i = 0; i < frames.length; i++) {
    let best = null, bestScore = -Infinity;
    for (const p of frames[i].people) {
      const c = centre(p.lm), s = size(p.lm);
      const tan = p.tan == null ? 0.2 : p.tan;
      let score = 3 * tan + 0.6 * Math.min(s / 0.12, 2);   // tan fur, and he is big
      if (prev) {
        const d = Math.hypot(c[0] - prev.c[0], c[1] - prev.c[1]);
        const allowed = 0.06 + 0.03 * lost + prev.s * 0.8;
        score -= 4 * Math.max(0, d - allowed) / allowed;    // no teleporting
        score -= 1.5 * Math.abs(Math.log(s / prev.s));       // nor sudden growth
      } else {
        score -= 2 * Math.abs(c[0] - 0.5);                   // starts in the middle
      }
      if (score > bestScore) { bestScore = score; best = { p, c, s, tan }; }
    }
    // Accept: clearly tan, or (when following) a confident continuation.
    if (best && (best.tan > 0.25 || (prev && bestScore > 0.5 && best.tan > 0.08))) {
      track[i] = best.p.lm; prev = { c: best.c, s: best.s }; lost = 0;
      why.push(best.tan);
    } else {
      lost++; why.push(null);
      if (lost > 45) prev = null;   // 1.5 s gone: look again from scratch
    }
  }
  return track;
}

function clean(track) {
  const n = track.length;
  const out = track.map(t => t && t.map(p => p.slice()));
  // fill gaps up to 8 frames (~1/4 s) by linear interpolation
  for (let i = 0; i < n; i++) {
    if (out[i]) continue;
    let j = i; while (j < n && !out[j]) j++;
    if (i > 0 && j < n && j - i <= 8) {
      for (let k = i; k < j; k++) {
        const t = (k - i + 1) / (j - i + 1);
        out[k] = out[i - 1].map((p, m) => [p[0] + t * (out[j][m][0] - p[0]), p[1] + t * (out[j][m][1] - p[1]),
          Math.min(p[2], out[j][m][2]) * 0.8]);
      }
    }
    i = j;
  }
  // light smoothing: centred 5-frame average of positions (keeps the beat, loses jitter)
  const sm = out.map((t, i) => {
    if (!t) return null;
    return t.map((p, m) => {
      let x = 0, y = 0, w = 0;
      for (let k = -2; k <= 2; k++) {
        const q = out[i + k]; if (!q) continue;
        const wk = 3 - Math.abs(k); x += q[m][0] * wk; y += q[m][1] * wk; w += wk;
      }
      return [+(x / w).toFixed(4), +(y / w).toFixed(4), p[2]];
    });
  });
  return sm;
}

// ---- pass 2: crops around Cosmo ----
const CROPS = path.join(CACHE, 'crops.json');
function cropJobs(raw, first) {
  const W = raw.frames[0].w, H = raw.frames[0].h, n = first.length;
  const known = [];
  first.forEach((lm, i) => { if (lm) known.push([i, centre(lm), size(lm)]); });
  const jobs = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    while (k + 1 < known.length && known[k + 1][0] <= i) k++;
    const a = known[k], b = known[Math.min(k + 1, known.length - 1)];
    let c, s;
    if (i <= a[0] || a === b) { c = a[1]; s = a[2]; }
    else { const t = (i - a[0]) / (b[0] - a[0]); c = [a[1][0] + t * (b[1][0] - a[1][0]), a[1][1] + t * (b[1][1] - a[1][1])]; s = a[2] + t * (b[2] - a[2]); }
    if (i < known[0][0]) { c = known[0][1]; s = known[0][2]; }
    const side = Math.min(H, Math.max(220, 5.5 * s * W));
    jobs.push({ i, cx: c[0] * W, cy: c[1] * H - 0.1 * side, side });
  }
  return jobs;
}
async function crops(raw, first) {
  const model = fs.existsSync(path.join(CACHE, 'pose_heavy.task')) ? '/tools/cache/pose_heavy.task' : '/web/models/pose_full.task';
  const { server, url } = await serve(ROOT, { '/frames/': FRAMES });
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', m => { if (/^crop/.test(m.text())) console.log('  page:', m.text()); });
  page.on('pageerror', e => console.log('  page error:', e.message));
  await page.goto(url + '/tools/extract.html');
  await page.waitForFunction(() => window.ready);
  const t0 = Date.now();
  const out = await page.evaluate(([j, m]) => window.runCrops(j, m), [cropJobs(raw, first), model]);
  console.log('cropped pass in', ((Date.now() - t0) / 1000).toFixed(0), 's');
  await browser.close(); server.close();
  fs.writeFileSync(CROPS, JSON.stringify(out));
}

// Final pick: the crop pass where it clearly found Cosmo (tan, near the
// middle of his crop), else the whole-frame pass.
function combine(first, cropped) {
  let fromCrop = 0;
  const track = first.map((lm, i) => {
    let best = null, bestScore = -Infinity;
    for (const p of cropped[i].people) {
      const tan = p.tan ?? 0, sc = 3 * tan - 4 * p.off;
      if (sc > bestScore) { bestScore = sc; best = p; }
    }
    if (best && ((best.tan ?? 0) > 0.2 && best.off < 0.25 || best.off < 0.12 && (best.tan ?? 0) > 0.08)) { fromCrop++; return best.lm; }
    return lm;
  });
  console.log(`crop pass used for ${fromCrop} frames`);
  return track;
}

if (!process.argv.includes('--pick') || !fs.existsSync(RAW)) await detect();
const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
const first = pick(raw);
console.log(`whole-frame pass found Cosmo in ${first.filter(Boolean).length} frames`);
if (!process.argv.includes('--pick') || !fs.existsSync(CROPS)) await crops(raw, first);
const track = clean(combine(first, JSON.parse(fs.readFileSync(CROPS, 'utf8'))));
const found = track.filter(Boolean).length;
console.log(`Cosmo found in ${found}/${track.length} frames`);
// Keep only the 13 body points the scoring uses (no face/hands detail) to keep the file small.
const KEEP = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
fs.writeFileSync(path.join(ROOT, 'web/ref.json'), JSON.stringify({
  fps: raw.fps, aspect: raw.frames[0].w / raw.frames[0].h, points: KEEP,
  frames: track.map(t => t ? KEEP.map(i => t[i]) : null),
}));
// A coverage line per second, for eyeballing: # = Cosmo found, . = not.
let line = '';
for (let s = 0; s < track.length / FPS; s++) {
  const seg = track.slice(s * FPS, (s + 1) * FPS);
  line += seg.filter(Boolean).length > FPS * 0.8 ? '#' : seg.filter(Boolean).length > 0 ? '+' : '.';
}
console.log('per second from clip start (game time 5 s):', line);
