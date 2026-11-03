// dancecheck: the scoring, the touchdown start, then the real page in
// headless Chromium.
//
//   node dancecheck.mjs            # everything (~6 minutes)
//   node dancecheck.mjs --quick    # the scoring and the touchdown only, no browser (seconds)
//   node dancecheck.mjs --verbose  # also every window's fit, per dancer
//
// Part 1, for every song with a reference: score.js against made-up
// dancers built from Cosmo's own reference pose. One copies him late, one
// is half the size in a differently shaped camera (a kid on a phone), one
// copies like a mirror, one stands still, one makes up their own moves, one
// dances the wrong part of the song. The copies must score high and the
// others low.
//
// Part 2, the touchdown start (gesture.js): arms up in all sorts of lenient
// ways counts, arms down does not, everyone has to be up, and it only fires
// after arms have been down first.
//
// Part 3 opens web/index.html with ?testcam=, so a video file stands in for
// the camera, in step with the song: a camera following Cosmo through the
// original clip (tools/testcam-cosmo.webm, made by tools/testcam.py; the
// song is started by his arms going up, and the replay is recorded), the
// same flipped (a mirror copy), a frozen frame, and the whole stadium shot.
// Then pause, resume and end; the other songs; and Chromium's fake camera
// device for the real getUserMedia path.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as S from './web/score.js';
import { armsUp, Touchdown, HOLD_MS, READY_MS } from './web/gesture.js';
import { serve } from './tools/serve.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SONGS = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/songs.json'), 'utf8'));
let failed = 0;
function check(ok, what) { console.log((ok ? '  ok   ' : '  FAIL ') + what); if (!ok) failed++; }

// ---------------- part 1: scoring, per song ----------------
const SWAPI = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11];
const mirrorCopy = pose => SWAPI.map(j => pose[j]).map(([x, y, v]) => [1 - x, y, v]);

function scoring(song) {
  const file = path.join(ROOT, 'web', song.ref);
  if (!fs.existsSync(file)) { check(false, `${song.id}: reference ${song.ref} exists`); return; }
  const ref = JSON.parse(fs.readFileSync(file, 'utf8'));
  const R = S.prepareRef(ref, song);
  const W = S.windows(R);
  const found = ref.frames.filter(Boolean).length;
  console.log(`\n${song.id} (${song.title}): ${ref.frames.length} frames, Cosmo in ${found}; ${W.length} graded windows from clip ${W[0][0].toFixed(2)} s`);
  check(found / ref.frames.length > 0.8, `${song.id}: Cosmo is tracked through most of the clip (${Math.round(100 * found / ref.frames.length)}%)`);
  check(W.length > 25 && W[0][0] >= song.scoreFrom - 1e-6, `${song.id}: scoring starts at or after clip ${song.scoreFrom} s`);

  function simulate(poseAt, aspect, fps = 15, T = S.TIMING) {
    const grades = [];
    for (const w of W) {
      const samples = [];
      for (let t = w[0]; t < w[1]; t += 1 / fps) {
        const pose = poseAt(t); if (!pose) continue;
        samples.push({ t, angs: S.angles(pose, aspect), mir: S.angles(pose, aspect, true) });
      }
      const g = S.gradeWindow(R, w, samples, T);
      if (g) grades.push(g.grade);
    }
    const counts = {}; grades.forEach(g => counts[g.name] = (counts[g.name] || 0) + 1);
    return { pct: S.percent(grades), counts };
  }
  const refAt = t => { const i = Math.round(t * R.fps); return i >= 0 && i < ref.frames.length ? ref.frames[i] : null; };
  const recamera = (pose, aspect, scale, dx, dy) =>
    pose.map(([x, y, v]) => [0.5 + ((x - 0.5) * ref.aspect * scale) / aspect + dx, 0.5 + (y - 0.5) * scale + dy, v]);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // a dancer who moves smoothly but makes up their own moves: a new random pose every beat, eased between
  const base = ref.frames.find(Boolean);
  const keys = Array.from({ length: Math.ceil(R.length / R.beat) + 2 }, () => base.map((q, k) => k < 3 || k > 8 ? q.slice()
    : [q[0] + (rnd() - 0.5) * 0.12, q[1] + (rnd() - 0.5) * 0.14, 1]));
  keys.forEach(p => { for (const k of [9, 10, 11, 12]) p[k] = [base[k][0] + (rnd() - 0.5) * 0.05, base[k][1] + (rnd() - 0.5) * 0.03, 1]; });
  const madeUp = t => { const f = t / R.beat, i = Math.floor(f), e = f - i; return keys[i].map((q, k) => [q[0] + e * (keys[i + 1][k][0] - q[0]), q[1] + e * (keys[i + 1][k][1] - q[1]), 1]); };
  const still = refAt(song.scoreFrom) || base;
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
  // the timing allowance can be widened afterwards: a slow copier
  cases['copying 0.8 s late (default allowance)'] = simulate(t => refAt(t - 0.8), ref.aspect);
  cases['copying 0.8 s late, Behind widened to 1.0 s'] = simulate(t => refAt(t - 0.8), ref.aspect, 15, { early: S.EARLY, late: 1.0 });
  const WIDE = { early: 0.8, late: 1.5 };   // the sliders' far ends
  cases['making up their own moves, widest allowance'] = simulate(madeUp, ref.aspect, 15, WIDE);
  cases['standing still, widest allowance'] = simulate(() => still, ref.aspect, 15, WIDE);
  for (const [k, v] of Object.entries(cases)) console.log(`  ${k.padEnd(52)} ${String(v.pct).padStart(3)}%  ${JSON.stringify(v.counts)}`);
  check(cases['copying Cosmo, 0.25 s late'].pct >= 85, `${song.id}: a good copy scores 85% or more`);
  check(cases['a kid: half size, 4:3 phone camera, off to one side'].pct >= 85, `${song.id}: size, position and camera shape do not matter`);
  check(cases['copying like a mirror'].pct >= 85, `${song.id}: mirror-image dancing counts`);
  check(cases['copying, with shaky tracking, 0.4 s late'].pct >= 70, `${song.id}: a late copy through shaky tracking still scores 70% or more`);
  check(cases['standing still'].pct <= 15, `${song.id}: standing still scores 15% or less`);
  check(cases['making up their own moves'].pct <= 20, `${song.id}: making up your own moves scores 20% or less`);
  check(cases['copying 0.8 s late (default allowance)'].pct < 60 && cases['copying 0.8 s late, Behind widened to 1.0 s'].pct >= 85,
    `${song.id}: a slow copier fails the default allowance and passes a wider one`);
  check(cases['making up their own moves, widest allowance'].pct <= 30 && cases['standing still, widest allowance'].pct <= 15,
    `${song.id}: even at the widest allowance, made-up moves and standing still score low`);
  check(cases['dancing a different part of the song (6 s off)'].pct <= 25, `${song.id}: the wrong part of the song scores 25% or less`);
}
for (const song of SONGS) scoring(song);

// ---------------- part 2: the touchdown start ----------------
console.log('\ntouchdown start');
{
  // a standing person: 13 points, shoulders at y .30, hips at .55
  const P = (lw, rw, le, re) => [[0.5, 0.2, 1], [0.45, 0.3, 1], [0.55, 0.3, 1], le || [0.42, 0.42, 1], re || [0.58, 0.42, 1],
    lw || [0.42, 0.52, 1], rw || [0.58, 0.52, 1], [0.46, 0.55, 1], [0.54, 0.55, 1], [0.46, 0.72, 1], [0.54, 0.72, 1], [0.46, 0.9, 1], [0.54, 0.9, 1]];
  const down = P();
  const straight = P([0.4, 0.05, 1], [0.6, 0.05, 1], [0.42, 0.17, 1], [0.58, 0.17, 1]);
  const bent = P([0.35, 0.25, 1], [0.65, 0.25, 1], [0.38, 0.22, 1], [0.62, 0.22, 1]);   // elbows out, hands near ears
  const lopsided = P([0.4, 0.08, 1], [0.66, 0.29, 0.2], [0.42, 0.2, 1], [0.62, 0.26, 1]); // one hand lost by the model, its elbow up
  const oneArm = P([0.4, 0.05, 1], undefined, [0.42, 0.17, 1]);
  check(!armsUp(down), 'arms down is not a touchdown');
  check(armsUp(straight), 'arms straight up is');
  check(armsUp(bent), 'bent arms with the elbows up count (kids, tired adults)');
  check(armsUp(lopsided), 'a hand the camera lost still counts if its elbow is up');
  check(!armsUp(oneArm), 'one arm up is not a touchdown');
  const run = (frames, dt = 50) => { const td = new Touchdown(); let t = 0, fired = null;
    for (const poses of frames) { t += dt; const r = td.update(poses, poses.map((p, i) => [0.2 + 0.3 * i, 0.4]), t); if (r.fired && fired == null) fired = t; } return fired; };
  const rep = (poses, ms) => Array(Math.ceil(ms / 50)).fill(poses);
  const firedAt = run([...rep([down, down], READY_MS + 100), ...rep([straight, bent], HOLD_MS + 200)]);
  check(firedAt != null, `two people, arms down then both up: starts (after ${firedAt} ms)`);
  check(run([...rep([down, down], READY_MS + 100), ...rep([straight, down], 3000)]) == null, 'only one of two up: does not start');
  check(run(rep([straight], 3000)) == null, 'arms already up when the screen appears (still celebrating): does not start');
  // the model drops an arm for a frame now and then
  const flicker = []; for (let i = 0; i < 30; i++) flicker.push([i % 5 === 2 ? down : straight]);
  check(run([...rep([down], READY_MS + 100), ...flicker]) != null, 'a one-frame flicker while holding still starts it');
}

// ---------------- part 3: the page ----------------
if (!process.argv.includes('--quick')) {
  console.log('\nthe page');
  const CACHE = path.join(ROOT, 'tools/cache');
  fs.mkdirSync(CACHE, { recursive: true });
  const clip = path.join(ROOT, 'web/media/rolex.mp4');
  const make = (name, vf) => {
    const out = path.join(CACHE, name);
    if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(clip).mtimeMs) {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', clip, '-t', '24', '-an', '-vf', vf,
        '-c:v', 'libvpx-vp9', '-b:v', '900k', '-deadline', 'realtime', '-cpu-used', '8', out]);
    }
    return '/testcam/' + name;
  };
  // the main one, committed: a camera that follows Cosmo (tools/testcam.py)
  fs.copyFileSync(path.join(ROOT, 'tools/testcam-cosmo.webm'), path.join(CACHE, 'cam-cosmo.webm'));
  const mirrorOut = path.join(CACHE, 'cam-cosmo-mirror.webm');
  if (!fs.existsSync(mirrorOut) || fs.statSync(mirrorOut).mtimeMs < fs.statSync(path.join(CACHE, 'cam-cosmo.webm')).mtimeMs)
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(CACHE, 'cam-cosmo.webm'), '-vf', 'hflip', '-c:v', 'libvpx-vp9', '-b:v', '700k',
      '-deadline', 'realtime', '-cpu-used', '8', mirrorOut]);
  // a group: six Cougarettes from the start of Cougarettes in White, cropped and enlarged to
  // living-room size (tools/testcam-group.webm, committed)
  fs.copyFileSync(path.join(ROOT, 'tools/testcam-group.webm'), path.join(CACHE, 'testcam-group.webm'));
  const cams = {
    group: '/testcam/testcam-group.webm',
    cosmo: '/testcam/cam-cosmo.webm',
    mirror: '/testcam/cam-cosmo-mirror.webm',
    crowd: make('cam-crowd.webm', 'scale=960:-2'),
    frozen: make('cam-frozen.webm', `select=eq(n\\,${Math.round(10 * 30)}),scale=960:-2,loop=loop=-1:size=1,fps=30`),
  };
  const { server, url } = await serve(path.join(ROOT, 'web'), { '/testcam/': CACHE });
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const END = 20;
  const dance = () => window.__dance;

  // start: 'button' clicks Start; 'touchdown' shows an arms-down frame, then
  // jumps the pretend camera to Cosmo with his arms up (clip 4.1 s)
  async function run(label, query, { start = 'button', during = null, expectDancers = true, expectAll = true, replay = false } = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    // MediaPipe prints its own INFO/W lines through console.error: not errors
    page.on('console', m => { if (m.type() === 'error' && !/^(INFO:|[IW]\d{4} )/.test(m.text())) errors.push(m.text()); });
    await page.goto(`${url}/index.html?${query}${replay ? '' : '&noreplay=1'}`);
    await page.click('#go');
    await page.waitForFunction(() => window.__dance.phase === 'setup' || window.__dance.errors.length, null, { timeout: 120000 });
    const setup = await page.evaluate(() => ({ ...window.__dance }));
    if (setup.phase !== 'setup') { check(false, `${label}: reached setup (${setup.errors.join('; ')})`); await page.close(); return null; }
    if (start === 'touchdown') {
      await page.waitForTimeout(2000);
      const early = await page.evaluate(() => window.__dance.phase);
      check(early === 'setup', `${label}: arms down, the song waits`);
      await page.evaluate(() => { document.getElementById('cam').currentTime = 4.1; });
      await page.waitForFunction(() => window.__dance.phase === 'playing', null, { timeout: 10000 }).catch(() => {});
      const st = await page.evaluate(() => ({ phase: window.__dance.phase, by: window.__dance.startedBy }));
      check(st.phase === 'playing' && st.by === 'touchdown', `${label}: arms up (a touchdown) starts the song without a tap`);
      if (st.phase !== 'playing') await page.click('#start');
    } else {
      await page.waitForTimeout(1500);
      await page.click('#start');
    }
    if (during) await during(page);
    await page.waitForFunction(() => window.__dance.phase === 'results', null, { timeout: (END + 60) * 1000 });
    if (replay) await page.waitForFunction(() => window.__dance.replay || window.__dance.errors.length, null, { timeout: 30000 }).catch(() => {});
    const st = await page.evaluate(() => ({ ...window.__dance, src: document.getElementById('song').currentSrc,
      faces: [...document.querySelectorAll('#podium img.face')].map(i => i.naturalWidth) }));
    const best = st.players.length ? Math.max(...st.players.map(p => p.pct)) : 0;
    console.log(`  ${label.padEnd(8)} ${st.song}, model ${st.model}/${st.delegate}, ${st.detections} detections (${st.detectMs.toFixed(0)} ms each), ` +
      `${st.players.length} dancer(s): ${st.players.map(p => `${p.name} ${p.pts} pts (${p.pct}%)`).join(', ') || 'none'}`);
    if (process.argv.includes('--verbose')) for (const p of st.players)
      console.log(`     ${p.name}: ` + p.log.map(l => `${l.t}:${l.s}${l.mirror ? 'm' : ''}/${l.n}`).join(' '));
    check((st.joined || []).every(j => j < 3.5), `${label}: nobody joined after the dancing started (joined at ${(st.joined || []).join(', ')} s)`);
    check(!errors.length && !st.errors.length, `${label}: no page errors ${[...errors, ...st.errors].slice(0, 3).join(' | ')}`);
    if (!replay) check(await page.evaluate(() => getComputedStyle(document.getElementById('replayRow')).display === 'none'),
      `${label}: no replay recorded, so no replay button`);
    if (expectAll) check(st.windowsGraded === st.windowsTotal && st.windowsTotal > 0, `${label}: every window graded (${st.windowsGraded}/${st.windowsTotal})`);
    if (expectDancers) {
      check(st.players.length >= 1, `${label}: found someone dancing`);
      check(st.players.every(p => p.photo) && st.faces.length === st.players.length && st.faces.every(w => w > 0),
        `${label}: every dancer on the podium has a photo`);
    }
    let result = { best, st, page };
    if (label === 'late') {
      const pctOf = () => page.evaluate(() => Math.max(...window.__dance.players.map(p => p.pct)));
      const setT = async (e, l) => { await page.evaluate(([e, l]) => {
        for (const [id, v] of [['early', e], ['late', l]]) { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input')); }
      }, [e, l]); await page.waitForTimeout(1200); };
      await page.click('#tuning summary');
      const panel = await page.evaluate(() => document.querySelectorAll('#lagStats div').length > 0 && !!document.getElementById('late'));
      const base = await pctOf();
      await setT(0.25, 1.1); const wide = await pctOf();
      await page.screenshot({ path: path.join(CACHE, 'timing.png'), fullPage: true });
      const stats = await page.evaluate(() => document.getElementById('lagStats').textContent);
      await setT(0, 0.1); const tight = await pctOf();
      await setT(0.5, 1.0);
      await page.click('#keepTiming');
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('danceoff.timing')));
      await page.click('#resetTiming');
      result.timing = { panel, base, tight, wide, saved, stats };
    }
    if (label === 'cosmo') await page.screenshot({ path: path.join(CACHE, 'results.png') });
    if (replay) {
      check(st.replay && st.replay.size > 100000, `${label}: a replay video was made (${st.replay ? Math.round(st.replay.size / 1024) + ' KB ' + st.replay.type : 'none'})`);
      if (st.replay) {
        await page.click('#watch');
        const v = await page.waitForFunction(() => { const v = document.getElementById('replayVideo'); return v.readyState >= 2 && v.currentTime > 0.5 && { w: v.videoWidth, h: v.videoHeight }; }, null, { timeout: 15000 }).then(h => h.jsonValue()).catch(() => null);
        check(!!v, `${label}: the replay plays (${v ? v.w + 'x' + v.h : 'did not play'})`);
        await page.evaluate(() => { const v = document.getElementById('replayVideo'); v.pause(); v.currentTime = 6; });
        await page.waitForTimeout(800);
        await page.screenshot({ path: path.join(CACHE, `replay-${label}.png`) });
        // and the results card it ends on
        await page.evaluate(() => { const v = document.getElementById('replayVideo'); v.currentTime = v.duration - 0.3; });
        await page.waitForTimeout(800);
        await page.screenshot({ path: path.join(CACHE, `replay-${label}-end.png`) });
      }
    }
    await page.close();
    return result;
  }

  const q = `cpu=1&model=full&end=${END}&testcam=`;
  const cosmo = await run('cosmo', `song=rolex&${q}${cams.cosmo}`, { start: 'touchdown', replay: true,
    during: async page => { await page.waitForTimeout(9000); await page.screenshot({ path: path.join(CACHE, 'playing.png') }); } });
  // A group in view: the person detector counts them, the extra crop looks
  // follow more of them than the whole-frame look alone, and when it still
  // cannot follow everyone the line-up screen says to use fewer dancers.
  // (crops=always: this machine is too slow for the speed gate to allow them.)
  async function groupLook(crops) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${url}/index.html?cpu=1&model=full&noreplay=1&crops=${crops}&testcam=${cams.group}&testcamAt=0.5`);
    await page.click('#go');
    await page.waitForFunction(() => window.__dance.phase === 'setup', null, { timeout: 120000 });
    let most = 0, inView = 0, advice = '';
    for (const t of [0.5, 1.5, 2.5]) {
      await page.evaluate(t => { document.getElementById('cam').currentTime = t; }, t);
      await page.waitForTimeout(2500);
      const st = await page.evaluate(() => ({ f: window.__dance.followed, v: window.__dance.inView, a: document.getElementById('advice').textContent }));
      most = Math.max(most, st.f || 0); inView = Math.max(inView, st.v || 0); if (st.a) advice = st.a;
    }
    await page.close();
    return { most, inView, advice };
  }
  const withCrops = await groupLook('always'), without = await groupLook('0');
  console.log(`  group: followed ${without.most} without crops, ${withCrops.most} with; ${withCrops.inView} counted in view`);
  check(withCrops.inView >= 4, `group: the person detector counts the group (${withCrops.inView} in view)`);
  check(withCrops.most > without.most, `group: crops follow more dancers than the whole-frame look alone (${withCrops.most} vs ${without.most})`);
  const plain = await groupLook('');   // as shipped: no crops, head count on
  check(/can see \d+ people/.test(plain.advice), `group: line-up says how many it sees and to take turns ("${plain.advice}")`);

  const mirror = await run('mirror', `song=rolex&${q}${cams.mirror}`);
  const frozen = await run('frozen', `song=rolex&${q}${cams.frozen}`);
  await run('crowd', `song=rolex&${q}${cams.crowd}`);   // the whole stadium shot: just must not break
  // re-grading the finished song with the Ahead / Behind sliders: a dancer
  // copying 0.8 s late fails the default allowance, and passes once Behind is widened
  const late = await run('late', `song=rolex&${q}${cams.cosmo}&testcamLag=0.8`);
  if (late && late.timing) {
    const t = late.timing;
    console.log(`  timing: late dancer ${t.base}% at the default, ${t.wide}% with Behind 1.1 s, ${t.tight}% with almost none; panel says "${t.stats.slice(0, 90)}…"`);
    check(t.panel, 'timing: the results screen has the Ahead / Behind sliders and each dancer\'s typical delay');
    check(t.wide >= t.base + 20 && t.tight < t.base, `timing: widening Behind lifts a late dancer, narrowing drops them (${t.tight}% / ${t.base}% / ${t.wide}%)`);
    check(/limit/.test(t.stats), 'timing: the panel says how often moves hit the limit');
    check(t.saved && t.saved.late === 1 && t.saved.early === 0.5, 'timing: "Use these from now on" keeps the values on the device');
  } else check(false, 'timing: the late run reached results');
  check(cosmo && cosmo.best >= 75, `Cosmo himself, as the camera, scores well (best dancer ${cosmo && cosmo.best}%)`);
  check(mirror && mirror.best >= 75, `Cosmo flipped (a mirror copy), as the camera, scores well (best dancer ${mirror && mirror.best}%)`);
  check(frozen && frozen.best <= 30, `a frozen frame scores badly (best ${frozen && frozen.best}%)`);

  // pause, resume, end: the song stops while paused, nothing is graded,
  // End gives results for what was danced, and the replay still comes out
  await run('controls', `song=rolex&${q}${cams.cosmo}`, { expectAll: false, replay: true, during: async page => {
    await page.waitForFunction(() => document.getElementById('song').currentTime > 5);
    await page.click('#pause');
    const a = await page.evaluate(() => ({ t: document.getElementById('song').currentTime, g: window.__dance.windowsGraded, phase: window.__dance.phase }));
    await page.waitForTimeout(1500);
    const b = await page.evaluate(() => ({ t: document.getElementById('song').currentTime, g: window.__dance.windowsGraded, paused: document.getElementById('song').paused }));
    check(a.phase === 'paused' && b.paused && Math.abs(b.t - a.t) < 0.05 && b.g === a.g, `controls: Pause stops the song and the grading (at ${a.t.toFixed(1)} s)`);
    await page.click('#pause');
    await page.waitForTimeout(1500);
    const c = await page.evaluate(() => ({ t: document.getElementById('song').currentTime, phase: window.__dance.phase }));
    check(c.phase === 'playing' && c.t > b.t + 1, 'controls: Resume carries on from there');
    await page.waitForFunction(() => document.getElementById('song').currentTime > 9);
    await page.click('#end');
    const d = await page.evaluate(() => ({ phase: window.__dance.phase, g: window.__dance.windowsGraded, n: window.__dance.windowsTotal }));
    check(d.phase === 'results' && d.g > 3 && d.g < d.n, `controls: End shows results for what was danced (${d.g} of ${d.n} windows)`);
  } });

  // the other songs load, play and grade (short runs: their own clips, any camera)
  for (const s of SONGS.filter(s => s.id !== 'rolex' && fs.existsSync(path.join(ROOT, 'web', s.ref))))
    await run(s.id, `song=${s.id}&cpu=1&model=lite&end=${s.scoreFrom + 6}&testcam=${cams.cosmo}`, { expectDancers: false });
  await run('fakecam', `cpu=1&model=lite&end=6`, { expectDancers: false });
  await browser.close(); server.close();
  console.log('  screenshots: tools/cache/playing.png, results.png, replay-cosmo.png, replay-controls.png');
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
