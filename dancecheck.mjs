// dancecheck: the scoring, then the real page in headless Chromium.
//
//   node dancecheck.mjs          # everything (~3 minutes)
//   node dancecheck.mjs --quick  # the scoring only, no browser (seconds)
//   node dancecheck.mjs --verbose  # also every window's fit, per dancer
//
// Part 1 feeds score.js made-up dancers built from Cosmo's own reference
// pose: a dancer who copies him a beat late, one who is half the size in a
// differently shaped camera (a kid on a phone), one who copies him like a
// mirror, one who stands still, and one who flails at random. The copies
// must score high and the others low.
//
// Part 2 opens web/index.html with ?testcam=, so a video file stands in for
// the camera, in step with the song: a camera following Cosmo through the
// clip (tools/testcam-cosmo.webm, made by tools/testcam.py), the same
// flipped (a mirror copy), a frozen frame, and the whole stadium shot.
// It checks the page loads the model, finds dancers, grades every window,
// reaches the results screen with no errors, and that dancing beats
// standing still. Then one short run with Chromium's fake camera device, to
// cover the real getUserMedia path.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as S from './web/score.js';
import { serve } from './tools/serve.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let failed = 0;
function check(ok, what) { console.log((ok ? '  ok   ' : '  FAIL ') + what); if (!ok) failed++; }

// ---------------- part 1: scoring ----------------
const ref = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/ref.json'), 'utf8'));
const R = S.prepareRef(ref);
const W = S.windows(R.length);
const found = ref.frames.filter(Boolean).length;
console.log(`reference: ${ref.frames.length} frames, Cosmo in ${found}; ${W.length} graded windows`);
check(found / ref.frames.length > 0.85, 'Cosmo is tracked through most of the clip');
check(W.length > 50 && W[0][0] >= S.SCORE_FROM - 1e-6, `scoring starts at 0:08 (clip ${W[0][0].toFixed(2)} s)`);

// Simulated camera: produce the dancer's pose at time t, ~15 detections a second.
function simulate(poseAt, aspect, fps = 15) {
  const grades = [];
  for (const w of W) {
    const samples = [];
    for (let t = w[0]; t < w[1]; t += 1 / fps) {
      const pose = poseAt(t); if (!pose) continue;
      const angs = S.angles(pose, aspect), mir = S.angles(pose, aspect, true);
      samples.push({ t, angs, mir });
    }
    const g = S.gradeWindow(R, w, samples);
    if (g) grades.push(g.grade);
  }
  const counts = {}; grades.forEach(g => counts[g.name] = (counts[g.name] || 0) + 1);
  return { pct: S.percent(grades), counts };
}
const refAt = t => { const i = Math.round(t * R.fps); return i >= 0 && i < ref.frames.length ? ref.frames[i] : null; };
// same body, different camera: re-express in a camera of another aspect, scaled and moved
function recamera(pose, aspect, scale, dx, dy) {
  return pose.map(([x, y, v]) => [0.5 + ((x - 0.5) * ref.aspect * scale) / aspect + dx, 0.5 + (y - 0.5) * scale + dy, v]);
}
const SWAPI = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11];
const mirrorCopy = pose => SWAPI.map(j => pose[j]).map(([x, y, v]) => [1 - x, y, v]);
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
// a dancer who moves smoothly but makes up their own moves: a new random pose every beat, eased between
const base = ref.frames.find(Boolean);
const keys = Array.from({ length: Math.ceil(R.length / S.BEAT) + 2 }, () => base.map((q, k) => k < 3 || k > 8 ? q.slice()
  : [q[0] + (rnd() - 0.5) * 0.12, q[1] + (rnd() - 0.5) * 0.14, 1]));
// legs: keep them under the hips but shuffle the feet
keys.forEach(p => { for (const k of [9, 10, 11, 12]) p[k] = [base[k][0] + (rnd() - 0.5) * 0.05, base[k][1] + (rnd() - 0.5) * 0.03, 1]; });
const madeUp = t => { const f = t / S.BEAT, i = Math.floor(f), e = f - i; return keys[i].map((q, k) => [q[0] + e * (keys[i + 1][k][0] - q[0]), q[1] + e * (keys[i + 1][k][1] - q[1]), 1]); };
const still = refAt(S.SCORE_FROM) || ref.frames.find(Boolean);

let seed2 = 11; const rnd2 = () => (seed2 = (seed2 * 16807) % 2147483647) / 2147483647;
const jitter = (p, a) => p && p.map(([x, y, v]) => [x + (rnd2() - 0.5) * a, y + (rnd2() - 0.5) * a, v]);
const cases = {
  'copying, with shaky tracking, 0.4 s late': simulate(t => jitter(refAt(t - 0.4), 0.03), ref.aspect),
  'copying Cosmo, 0.25 s late': simulate(t => refAt(t - 0.25), ref.aspect),
  'a kid: half size, 4:3 phone camera, off to one side': simulate(t => { const p = refAt(t - 0.3); return p && recamera(p, 4 / 3, 0.5, 0.2, 0.15); }, 4 / 3),
  'copying like a mirror': simulate(t => { const p = refAt(t - 0.25); return p && mirrorCopy(p); }, ref.aspect),
  'standing still': simulate(() => still, ref.aspect),
  'making up their own moves': simulate(madeUp, ref.aspect),
  'dancing a different part of the song (6 s off)': simulate(t => refAt(t + 6) || refAt(t - 6), ref.aspect),
};
for (const [k, v] of Object.entries(cases)) console.log(`  ${k.padEnd(52)} ${String(v.pct).padStart(3)}%  ${JSON.stringify(v.counts)}`);
check(cases['copying Cosmo, 0.25 s late'].pct >= 85, 'a good copy scores 85% or more');
check(cases['a kid: half size, 4:3 phone camera, off to one side'].pct >= 85, 'size, position and camera shape do not matter');
check(cases['copying like a mirror'].pct >= 85, 'mirror-image dancing counts');
check(cases['copying, with shaky tracking, 0.4 s late'].pct >= 70, 'a late copy through shaky tracking still scores 70% or more');
check(cases['standing still'].pct <= 15, 'standing still scores 15% or less');
check(cases['making up their own moves'].pct <= 20, 'making up your own moves scores 20% or less');
check(cases['dancing a different part of the song (6 s off)'].pct <= 25, 'the wrong part of the song scores 25% or less');

// ---------------- part 2: the page ----------------
if (!process.argv.includes('--quick')) {
  const CACHE = path.join(ROOT, 'tools/cache');
  fs.mkdirSync(CACHE, { recursive: true });
  const clip = path.join(ROOT, 'web/media/rolex.webm');
  const make = (name, vf, extra = []) => {
    const out = path.join(CACHE, name);
    if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(clip).mtimeMs) {
      execFileSync('ffmpeg', ['-v', 'error', '-y', ...extra, '-i', clip, '-t', '24', '-an', '-vf', vf,
        '-c:v', 'libvpx-vp9', '-b:v', '900k', '-deadline', 'realtime', '-cpu-used', '8', out]);
    }
    return '/testcam/' + name;
  };
  console.log('preparing pretend cameras...');
  // the main one, committed: a camera that follows Cosmo (tools/testcam.py)
  fs.copyFileSync(path.join(ROOT, 'tools/testcam-cosmo.webm'), path.join(CACHE, 'cam-cosmo.webm'));
  const cosmo = path.join(CACHE, 'cam-cosmo.webm');
  const mirrorOut = path.join(CACHE, 'cam-cosmo-mirror.webm');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', cosmo, '-vf', 'hflip', '-c:v', 'libvpx-vp9', '-b:v', '700k',
    '-deadline', 'realtime', '-cpu-used', '8', mirrorOut]);
  const cams = {
    dance: '/testcam/cam-cosmo.webm',
    mirror: '/testcam/cam-cosmo-mirror.webm',
    crowd: make('cam-crowd.webm', 'scale=960:-2'),
    frozen: make('cam-frozen.webm', `select=eq(n\\,${Math.round(10 * 30)}),scale=960:-2,loop=loop=-1:size=1,fps=30`, []),
  };
  const { server, url } = await serve(path.join(ROOT, 'web'), { '/testcam/': CACHE });
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const END = 20;

  async function run(label, query, { expectDancers = true } = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    // MediaPipe prints its own INFO/W lines through console.error: not errors
    page.on('console', m => { if (m.type() === 'error' && !/^(INFO:|[IW]\d{4} )/.test(m.text())) errors.push(m.text()); });
    await page.goto(`${url}/index.html?${query}`);
    await page.click('#go');
    await page.waitForFunction(() => window.__dance.phase === 'setup' || window.__dance.errors.length, null, { timeout: 120000 });
    const setup = await page.evaluate(() => ({ ...window.__dance }));
    if (setup.phase !== 'setup') { check(false, `${label}: reached setup (${setup.errors.join('; ')})`); await page.close(); return null; }
    await page.waitForTimeout(1500);
    await page.click('#start');
    if (label === 'dance') { await page.waitForTimeout(9000); await page.screenshot({ path: path.join(CACHE, 'playing.png') }); }
    await page.waitForFunction(() => window.__dance.phase === 'results', null, { timeout: (END + 60) * 1000 });
    const st = await page.evaluate(() => ({ ...window.__dance, banner: document.getElementById('winner').textContent,
      src: document.getElementById('song').currentSrc }));
    if (label === 'dance') await page.screenshot({ path: path.join(CACHE, 'results.png') });
    const best = st.players.length ? Math.max(...st.players.map(p => p.pct)) : 0;
    console.log(`  ${label.padEnd(8)} model ${st.model}/${st.delegate}, ${st.detections} detections (${st.detectMs.toFixed(0)} ms each), ` +
      `${st.players.length} dancer(s): ${st.players.map(p => `${p.name} ${p.pct}%`).join(', ') || 'none'}; song ${st.src.split('/').pop()}`);
    if (process.argv.includes('--verbose')) for (const p of st.players)
      console.log(`     ${p.name}: ` + p.log.map(l => `${l.t}:${l.s}${l.mirror ? 'm' : ''}/${l.n}`).join(' '));
    check(!errors.length && !st.errors.length, `${label}: no page errors ${[...errors, ...st.errors].slice(0, 3).join(' | ')}`);
    check(st.windowsGraded === st.windowsTotal && st.windowsTotal > 0, `${label}: every window graded (${st.windowsGraded}/${st.windowsTotal})`);
    if (expectDancers) check(st.players.length >= 1, `${label}: found someone dancing`);
    await page.close();
    return best;
  }

  const q = `cpu=1&model=full&end=${END}&testcam=`;
  const dance = await run('dance', q + cams.dance);
  const mirror = await run('mirror', q + cams.mirror);
  const frozen = await run('frozen', q + cams.frozen);
  const crowd = await run('crowd', q + cams.crowd);   // the whole stadium shot: just must not break
  check(dance >= 75, `Cosmo himself, as the camera, scores well (best dancer ${dance}%)`);
  check(mirror >= 75, `Cosmo flipped (a mirror copy), as the camera, scores well (best dancer ${mirror}%)`);
  check(frozen != null && frozen <= 30, `a frozen frame scores badly (best ${frozen}%)`);
  await run('fakecam', `cpu=1&model=lite&end=6`, { expectDancers: false });
  await browser.close(); server.close();
  console.log('  screenshot of the dance run\'s results: tools/cache/results.png');
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
