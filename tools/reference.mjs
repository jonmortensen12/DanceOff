// The reference pass: turns the dance clip into Cosmo's pose, frame by frame.
//
//   node tools/reference.mjs SONG          # detect (slow, cached) + pick Cosmo -> web/ref/SONG.json
//   node tools/reference.mjs SONG --pick   # only re-run the picking, from the cache
//   node tools/reference.mjs SONG --pick --recrop   # re-pick, then redo the crops round the new pick
//   node tools/reference.mjs SONG --pick --first    # just pass 1's pick, for tools/sheet.py SONG --first
//
// SONG is an id from web/songs.json; the clip is web/media/SONG.mp4.
// Everything cached goes under tools/cache/SONG/.
//
// Step 1 (detect) extracts the clip's frames with ffmpeg, runs every frame
// through MediaPipe's *heavy* pose model in headless Chromium (the game uses
// lite/full live; heavy is only worth its 30 MB offline) and keeps every
// person found, with how tan their limbs are. Cached in tools/cache/SONG/.
//
// Then (arms) the upper-arm colour of everyone found, from the frames.
// Cached in tools/cache/SONG/arms.json.
//
// Step 2 (pick) finds Cosmo: everyone is linked into short tracks (no jumps,
// colours staying alike), and his tracks are the ones whose median colours
// are tan fur on the legs AND the upper arms. The Cougarettes wear navy or
// white; in Center Court a dancer in khaki trousers is tan below the waist
// and another has bare arms, but neither has both.
//
// Step 3 (crops) runs the model again on a square crop round where Cosmo
// is (interpolated across frames where step 2 lost him): there he fills the
// picture and is found far more often. Cached in tools/cache/SONG/crops.json.
// A crop result is used where pass 1 has nothing, or to sharpen him, never
// to swap him for someone beside him.
//
// Then the track is cleaned (frames far from his path over the surrounding
// half second dropped, short gaps filled, jitter smoothed) and written to
// web/ref/SONG.json. Check it by eye: python3 tools/sheet.py SONG.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SONG = process.argv.slice(2).find(a => !a.startsWith('--')) || 'rolex';
const CACHE = path.join(ROOT, 'tools/cache');          // pose_heavy.task lives here
const SC = path.join(CACHE, SONG);                       // this song's frames and detections
const FRAMES = path.join(SC, 'frames');
const RAW = path.join(SC, 'raw.json');
const CLIP = path.join(ROOT, `web/media/${SONG}.mp4`);
if (!fs.existsSync(CLIP)) { console.error('no clip', CLIP); process.exit(1); }
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

// Pass 1's pick, by tracks rather than frame by frame. First everyone is
// linked across frames into short tracks (nearest, no jumps, no sudden
// growth, gaps up to 6 frames). Then each WHOLE track is judged by its
// median colours: Cosmo's tracks have tan legs AND tan upper arms (medians
// both >= 0.2, measured over all three songs: his are 0.24-0.99; a dancer in
// khaki trousers has arms <= 0.16, a bare-armed dancer in dark trousers legs
// <= 0.10, Cougarettes ~0). In each frame the person on the most Cosmo-like
// track is him.
// Hard-won: following him frame by frame, one frame where a stranger's arm
// happened to read tan was enough to switch to them for good (Center Court).
// running colours of a track (last ~10 frames), for linking
function running(t, p) {
  if (p.tan != null) t.runTan = t.runTan == null ? p.tan : t.runTan * 0.8 + p.tan * 0.2;
  if (p.arm != null) t.runArm = t.runArm == null ? p.arm : t.runArm * 0.8 + p.arm * 0.2;
}
function tracklets(frames) {
  const tracks = [];
  frames.forEach((f, i) => {
    const people = f.people.map(p => ({ p, c: centre(p.lm), s: size(p.lm) }));
    const pairs = [];
    for (const t of tracks) {
      const gap = i - t.last.i; if (gap > 6) continue;
      people.forEach((q, qi) => {
        const d = Math.hypot(q.c[0] - t.last.c[0], q.c[1] - t.last.c[1]);
        if (d >= 0.03 + 0.012 * gap + 0.5 * t.last.s || Math.abs(Math.log(q.s / t.last.s)) >= 0.5) return;
        // and looks like the same person: a track that has been tan fur does
        // not continue as a navy Cougarette standing beside him
        if (q.p.tan != null && t.runTan != null && Math.abs(q.p.tan - t.runTan) > 0.3) return;
        if (q.p.arm != null && t.runArm != null && Math.abs(q.p.arm - t.runArm) > 0.45) return;
        pairs.push([d, t, qi]);
      });
    }
    pairs.sort((x, y) => x[0] - y[0]);
    const usedT = new Set(), usedQ = new Set();
    for (const [, t, qi] of pairs) {
      if (usedT.has(t) || usedQ.has(qi)) continue;
      usedT.add(t); usedQ.add(qi);
      t.items.push({ i, p: people[qi].p }); t.last = { i, ...people[qi] }; running(t, people[qi].p);
    }
    people.forEach((q, qi) => { if (!usedQ.has(qi)) { const t = { items: [{ i, p: q.p }], last: { i, ...q } }; running(t, q.p); tracks.push(t); } });
  });
  const med = v => { v = v.slice().sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
  for (const t of tracks) {
    t.tan = med(t.items.map(x => x.p.tan ?? 0));
    const arms = t.items.map(x => x.p.arm).filter(v => v != null);
    t.arm = arms.length ? med(arms) : null;
  }
  return tracks;
}
function isCosmo(t) {
  const short = t.items.length < 5;   // a median of a few frames is noisy: ask more
  const minTan = short ? 0.3 : 0.2, minArm = short ? 0.4 : 0.2;
  return t.tan >= minTan && (t.arm == null ? t.tan >= 0.3 : t.arm >= minArm);
}
function pick(raw) {
  const track = new Array(raw.frames.length).fill(null);
  const best = new Array(raw.frames.length).fill(-1);
  const tracks = tracklets(raw.frames);
  for (const t of tracks) {
    if (!isCosmo(t)) continue;
    const score = t.tan + (t.arm ?? t.tan) + Math.min(1, t.items.length / 30);
    for (const { i, p } of t.items) if (score > best[i]) { best[i] = score; track[i] = p.lm; }
  }
  return track;
}

function clean(track) {
  const n = track.length;
  const out = track.map(t => t && t.map(p => p.slice()));
  // Outliers: a frame whose middle is far from where Cosmo is over the
  // surrounding half second (median of the frames either side) is someone
  // else, picked in a gap. Drop it; the gap filling below covers short ones.
  const mids = track.map(t => t && centre(t));
  let dropped = 0;
  for (let i = 0; i < n; i++) {
    if (!mids[i]) continue;
    const xs = [], ys = [];
    for (let k = i - 15; k <= i + 15; k++) if (k !== i && mids[k]) { xs.push(mids[k][0]); ys.push(mids[k][1]); }
    if (xs.length < 6) continue;
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    const mx = xs[xs.length >> 1], my = ys[ys.length >> 1];
    if (Math.hypot(mids[i][0] - mx, mids[i][1] - my) > Math.max(0.05, 0.8 * size(track[i]))) { out[i] = null; dropped++; }
  }
  if (dropped) console.log(`dropped ${dropped} frames far from Cosmo's path`);
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
const CROPS = path.join(SC, 'crops.json');
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
      const tan = p.tan ?? 0, arm = p.arm ?? tan * 0.6;   // an arm we could not see is not evidence
      const sc = 2 * tan + 2 * arm + 3 * Math.min(tan, arm) - 4 * p.off;
      if (sc > bestScore) { bestScore = sc; best = p; }
    }
    if (!best) return lm;
    const tan = best.tan ?? 0, arm = best.arm ?? tan * 0.6, fur = Math.min(tan, arm);
    // fur needs a SEEN arm: a partial body with only tan legs could be anyone in khaki
    const seenFur = best.arm == null ? 0 : fur;
    if (!(seenFur > 0.2 && best.off < 0.25 || best.off < 0.12 && tan > 0.2 && (best.arm ?? 0) > 0.15)) return lm;
    // where pass 1 already has him, the crop may only sharpen HIM, not swap
    // him for whoever was beside him in the crop
    if (lm && Math.hypot(centre(lm)[0] - centre(best.lm)[0], centre(lm)[1] - centre(best.lm)[1]) > 0.6 * size(lm)) return lm;
    fromCrop++;
    return best.lm;
  });
  console.log(`crop pass used for ${fromCrop} frames`);
  return track;
}

// ---- upper-arm colour, for every person found (both passes) ----
// Cosmo's upper arms are fur in every video. Legs alone are not enough: a
// dancer in khaki trousers (Center Court) is as tan below the waist.
async function armColours(frames, file) {
  const { server, url } = await serve(ROOT, { '/frames/': FRAMES });
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url + '/tools/extract.html');
  await page.waitForFunction(() => window.ready);
  const jobs = frames.map((f, i) => ({ i, people: f.people.map(p => p.lm) }));
  const out = await page.evaluate(j => window.colours(j), jobs);
  await browser.close(); server.close();
  fs.writeFileSync(file, JSON.stringify(out));
}
function withArms(frames, file) {
  const arms = JSON.parse(fs.readFileSync(file, 'utf8'));
  frames.forEach((f, i) => f.people.forEach((p, k) => { p.arm = arms[i][k]; }));
}

// Keep only the 13 body points the scoring uses (no face/hands detail) to keep the file small.
const KEEP = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const ARMS = path.join(SC, 'arms.json'), CROP_ARMS = path.join(SC, 'arms-crops.json');
const fresh = !process.argv.includes('--pick');
if (fresh || !fs.existsSync(RAW)) await detect();
const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
if (fresh || !fs.existsSync(ARMS) || fs.statSync(ARMS).mtimeMs < fs.statSync(RAW).mtimeMs) await armColours(raw.frames, ARMS);
withArms(raw.frames, ARMS);
const first = pick(raw);
console.log(`whole-frame pass found Cosmo in ${first.filter(Boolean).length} frames`);
fs.writeFileSync(path.join(SC, 'first.json'), JSON.stringify(first.map(t => t && KEEP.map(i => t[i]))));
if (process.argv.includes('--first')) process.exit(0);   // just pass 1, for tools/sheet.py SONG --first
// the crops are made round pass 1's Cosmo, so a changed pick needs them again: --recrop
if (fresh || process.argv.includes('--recrop') || !fs.existsSync(CROPS)) await crops(raw, first);
const cropped = JSON.parse(fs.readFileSync(CROPS, 'utf8'));
if (!fs.existsSync(CROP_ARMS) || fs.statSync(CROP_ARMS).mtimeMs < fs.statSync(CROPS).mtimeMs)
  await armColours(cropped.map(c => ({ people: c.people })), CROP_ARMS);
withArms(cropped, CROP_ARMS);
const track = clean(combine(first, cropped));
const found = track.filter(Boolean).length;
console.log(`Cosmo found in ${found}/${track.length} frames`);
fs.mkdirSync(path.join(ROOT, 'web/ref'), { recursive: true });
fs.writeFileSync(path.join(ROOT, `web/ref/${SONG}.json`), JSON.stringify({
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
