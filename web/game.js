// Cosmo Dance-Off: the song on screen, the camera watching up to four
// dancers, every two beats graded against Cosmo's pose (web/ref.json, made
// by tools/reference.mjs from the same clip). Scoring is in score.js.
//
// URL options (mostly for testing):
//   ?model=lite|full   pose model (default: lite on phones, full elsewhere)
//   ?cpu=1             no GPU for the pose model
//   ?testcam=URL       use a video file as the camera, kept in sync with the song
//   ?end=SEC           stop the song early (clip time)
//   ?debug=1           show detection speed
import { FilesetResolver, PoseLandmarker } from './lib/mediapipe/vision_bundle.mjs';
import * as S from './score.js';

const $ = id => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const PHONE = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
const MODEL = Q.get('model') || (PHONE ? 'lite' : 'full');
const TESTCAM = Q.get('testcam');
const END = Q.has('end') ? +Q.get('end') : null;
const COLORS = ['--p1', '--p2', '--p3', '--p4'].map(v => getComputedStyle(document.documentElement).getPropertyValue(v).trim());
const GRADE_COLORS = { PERFECT: '--perfect', GOOD: '--good', OK: '--ok', MISS: '--miss' };
const MAX_DANCERS = 4;
// seconds between the dancer moving and the frame reaching us, roughly (a
// video file standing in for the camera has none)
const CAM_LAG = TESTCAM ? 0 : 0.08;

const song = $('song'), cam = $('cam'), overlay = $('overlay'), octx = overlay.getContext('2d');

// Everything a check (or a curious person in the console) might want.
const state = window.__dance = {
  phase: 'title', errors: [], detectMs: 0, detections: 0, seen: 0,
  players: [], windowsGraded: 0, windowsTotal: 0, model: MODEL, delegate: null,
};
addEventListener('error', e => state.errors.push(String(e.message || e)));
addEventListener('unhandledrejection', e => state.errors.push(String(e.reason && e.reason.message || e.reason)));

let R = null, WINDOWS = [], landmarker = null, stream = null, wakeLock = null;
let latest = [];          // the latest detections: [{pose13, c, s}]
let players = [];         // slots, see newPlayer
let wi = 0;               // next window to grade
let lastCamTime = -1, lastStamp = 0;

function status(msg, err) { const el = $('status'); el.textContent = msg; el.classList.toggle('err', !!err); }

// ---------------- loading ----------------
async function loadRef() {
  const r = await (await fetch('ref.json')).json();
  R = S.prepareRef(r);
  WINDOWS = S.windows(END != null ? Math.min(END, R.length) : R.length);
  state.windowsTotal = WINDOWS.length;
}

async function loadModel() {
  const vision = await FilesetResolver.forVisionTasks(new URL('lib/mediapipe/wasm', location.href).href.replace(/\/$/, ''));
  const opts = delegate => ({
    baseOptions: { modelAssetPath: `models/pose_${MODEL}.task`, delegate },
    runningMode: 'VIDEO', numPoses: MAX_DANCERS,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  if (!Q.has('cpu')) {
    try { landmarker = await PoseLandmarker.createFromOptions(vision, opts('GPU')); state.delegate = 'GPU'; return; }
    catch (e) { console.warn('GPU pose failed, using CPU', e); }
  }
  landmarker = await PoseLandmarker.createFromOptions(vision, opts('CPU'));
  state.delegate = 'CPU';
}

async function openCamera(deviceId) {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  if (TESTCAM) {
    cam.src = TESTCAM; cam.loop = false; cam.muted = true;
    // during setup it shows the moment scoring starts, when the dancer is in place
    await cam.play().catch(() => {}); cam.pause(); cam.currentTime = S.SCORE_FROM;
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser has no camera access (it needs https).');
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  cam.srcObject = stream;
  await cam.play();
  // let a laptop with a second webcam pick it
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const pick = $('camPick');
  if (devs.length > 1) {
    const cur = stream.getVideoTracks()[0].getSettings().deviceId;
    pick.innerHTML = devs.map((d, i) => `<option value="${d.deviceId}" ${d.deviceId === cur ? 'selected' : ''}>${d.label || 'Camera ' + (i + 1)}</option>`).join('');
    pick.hidden = false;
  }
}
$('camPick').onchange = e => openCamera(e.target.value).catch(err => state.errors.push(err.message));

// ---------------- detection ----------------
function toPose13(lm) { return S.POINTS.map(i => [lm[i].x, lm[i].y, lm[i].visibility ?? 1]); }
function centreOf(p) {   // between shoulders and hips, in camera coords
  return [(p[1][0] + p[2][0] + p[7][0] + p[8][0]) / 4, (p[1][1] + p[2][1] + p[7][1] + p[8][1]) / 4];
}
function sizeOf(p, aspect) {
  const sx = (p[1][0] + p[2][0]) / 2, sy = (p[1][1] + p[2][1]) / 2, hx = (p[7][0] + p[8][0]) / 2, hy = (p[7][1] + p[8][1]) / 2;
  return Math.hypot((sx - hx) * aspect, sy - hy);
}

function detect() {
  if (!landmarker || cam.readyState < 2 || !cam.videoWidth) return false;
  if (cam.currentTime === lastCamTime && !TESTCAM) return false;
  lastCamTime = cam.currentTime;
  let stamp = performance.now(); if (stamp <= lastStamp) stamp = lastStamp + 1; lastStamp = stamp;
  const t0 = performance.now();
  const res = landmarker.detectForVideo(cam, stamp);
  state.detectMs = state.detectMs * 0.9 + (performance.now() - t0) * 0.1;
  state.detections++;
  const aspect = cam.videoWidth / cam.videoHeight;
  latest = res.landmarks.map(lm => {
    const pose = toPose13(lm);
    return { pose, c: centreOf(pose), s: sizeOf(pose, aspect) };
  }).filter(d => d.s > 0.04)   // ignore tiny far-off people (and posters)
    .sort((a, b) => b.s - a.s);
  // The model sometimes reports one person twice, slightly apart. Two
  // bodies whose middles are closer than half a torso are one dancer.
  latest = latest.filter((d, i) => !latest.slice(0, i).some(e => Math.hypot(d.c[0] - e.c[0], (d.c[1] - e.c[1]) / aspect) < 0.5 * e.s));
  state.seen = latest.length;
  return true;
}

// ---------------- players ----------------
function newPlayer(i, d) {
  const names = loadNames();
  return { i, name: names[i] || 'P' + (i + 1), color: COLORS[i], c: d ? d.c : [0.5, 0.5], s: d ? d.s : 0.2,
    pose: d ? d.pose : null, lastSeen: performance.now(), samples: [], grades: [], last: null, lastAt: 0,
    combo: 0, bestCombo: 0, present: 0, log: [], counts: { PERFECT: 0, GOOD: 0, OK: 0, MISS: 0 } };
}
function loadNames() { try { return JSON.parse(localStorage.getItem('danceoff.names')) || []; } catch (e) { return []; } }
function saveNames() { try { localStorage.setItem('danceoff.names', JSON.stringify(players.map(p => p.name))); } catch (e) {} }

// Who is who: each detection goes to the nearest player, nearest pairs
// first. A detection nobody claims becomes a new player while there is room.
function assign() {
  const now = performance.now();
  const pairs = [];
  latest.forEach((d, di) => players.forEach((p, pi) => {
    const dist = Math.hypot(d.c[0] - p.c[0], d.c[1] - p.c[1]);
    if (dist < Math.max(0.12, p.s * 2.5)) pairs.push([dist, di, pi]);
  }));
  pairs.sort((a, b) => a[0] - b[0]);
  const usedD = new Set(), usedP = new Set();
  for (const [, di, pi] of pairs) {
    if (usedD.has(di) || usedP.has(pi)) continue;
    usedD.add(di); usedP.add(pi);
    const p = players[pi], d = latest[di];
    p.c = d.c; p.s = d.s; p.pose = d.pose; p.lastSeen = now;
  }
  latest.forEach((d, di) => {
    if (usedD.has(di)) return;
    // A detection nobody claimed is, first, someone we just lost track of
    // (they moved fast, or were hidden for a moment): the nearest player not
    // matched this frame takes it. Only when everyone is accounted for is it
    // a new dancer. Without this one dancer split into P1 and P2.
    // Someone lost a moment ago is a far better guess than someone gone for
    // seconds, so time away counts as distance.
    let lost = null, ld = Infinity;
    players.forEach((p, pi) => {
      if (usedP.has(pi)) return;
      const away = Math.min(1, (now - p.lastSeen) / 2000);
      const cost = Math.hypot(d.c[0] - p.c[0], d.c[1] - p.c[1]) + 0.5 * away;
      if (cost < ld) { ld = cost; lost = pi; }
    });
    if (lost != null) {
      usedD.add(di); usedP.add(lost);
      Object.assign(players[lost], { c: d.c, s: d.s, pose: d.pose, lastSeen: now });
      return;
    }
    if (players.length >= MAX_DANCERS) return;
    // not a ghost double of someone already playing
    if (players.some(p => Math.hypot(d.c[0] - p.c[0], d.c[1] - p.c[1]) < p.s * 1.2)) return;
    players.push(newPlayer(players.length, d));
    usedP.add(players.length - 1);
    buildCards();
  });
  players.forEach(p => { if (!usedP.has(p.i)) p.pose = null; });
  state.players = players.map(p => ({ name: p.name, pct: S.percent(p.grades), counts: p.counts, graded: p.grades.length, bestCombo: p.bestCombo }));
}

// In setup, the players are whoever is in view right now, numbered left to
// right as the dancers see themselves (the mirror view).
function setupPlayers() {
  const sorted = latest.slice().sort((a, b) => b.c[0] - a.c[0]);
  players = sorted.slice(0, MAX_DANCERS).map((d, i) => newPlayer(i, d));
}

// ---------------- the song ----------------
function songTime() { return song.currentTime; }

function sample() {
  const t = songTime() - CAM_LAG;
  const aspect = cam.videoWidth / cam.videoHeight;
  for (const p of players) {
    if (!p.pose) continue;
    const angs = S.angles(p.pose, aspect), mir = S.angles(p.pose, aspect, true);
    p.samples.push({ t, angs, mir });
  }
}

function gradeDue() {
  const t = songTime() - CAM_LAG;
  while (wi < WINDOWS.length && t > WINDOWS[wi][1]) {
    const w = WINDOWS[wi];
    for (const p of players) {
      const inW = p.samples.filter(x => x.t >= w[0] && x.t < w[1]);
      const res = S.gradeWindow(R, w, inW);
      if (!res) continue;            // Cosmo not tracked here: not graded
      if (inW.length >= 2) p.present++;
      p.log.push({ t: +w[0].toFixed(2), s: +res.s.toFixed(2), lag: res.lag, mirror: res.mirror, n: inW.length });
      const g = res.grade;
      p.grades.push(g); p.counts[g.name]++;
      p.combo = g.pts >= 2 ? p.combo + 1 : 0; p.bestCombo = Math.max(p.bestCombo, p.combo);
      p.last = g; p.lastAt = performance.now();
      p.samples = p.samples.filter(x => x.t >= w[1] - S.LATE);
    }
    wi++; state.windowsGraded = wi;
    updateCards();
  }
}

// ---------------- drawing ----------------
const BONES = [[1, 2], [1, 3], [3, 5], [2, 4], [4, 6], [1, 7], [2, 8], [7, 8], [7, 9], [9, 11], [8, 10], [10, 12]];
function drawOverlay() {
  const W = overlay.clientWidth, H = overlay.clientHeight, dpr = Math.min(2, devicePixelRatio || 1);
  if (overlay.width !== Math.round(W * dpr) || overlay.height !== Math.round(H * dpr)) {
    overlay.width = Math.round(W * dpr); overlay.height = Math.round(H * dpr);
  }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, W, H);
  if (!cam.videoWidth) return;
  // the camera is drawn object-fit: cover, mirrored
  const vw = cam.videoWidth, vh = cam.videoHeight, sc = Math.max(W / vw, H / vh);
  const ox = (W - vw * sc) / 2, oy = (H - vh * sc) / 2;
  const X = x => ox + (1 - x) * vw * sc, Y = y => oy + y * vh * sc;
  const now = performance.now();
  const list = state.phase === 'setup' ? latest.map((d, i) => ({ pose: d.pose, color: '#ffffff', name: null }))
    : players.filter(p => p.pose);
  for (const p of list) {
    const pose = p.pose;
    octx.lineCap = 'round'; octx.lineWidth = Math.max(3, W / 120);
    octx.strokeStyle = p.color; octx.globalAlpha = 0.9;
    for (const [a, b] of BONES) {
      if (pose[a][2] < 0.5 || pose[b][2] < 0.5) continue;
      octx.beginPath(); octx.moveTo(X(pose[a][0]), Y(pose[a][1])); octx.lineTo(X(pose[b][0]), Y(pose[b][1])); octx.stroke();
    }
    octx.globalAlpha = 1;
    const hx = X(pose[0][0]), hy = Y(pose[0][1]) - W / 22;
    if (p.name) {
      octx.font = `900 ${Math.max(12, W / 26)}px system-ui, sans-serif`; octx.textAlign = 'center';
      octx.fillStyle = p.color; octx.fillText(p.name, hx, hy);
      if (p.last && now - p.lastAt < 700) {
        const k = (now - p.lastAt) / 700;
        octx.globalAlpha = 1 - k * k;
        octx.font = `900 ${Math.max(16, W / 15)}px system-ui, sans-serif`;
        octx.fillStyle = cssVar(GRADE_COLORS[p.last.name]);
        octx.strokeStyle = '#000a'; octx.lineWidth = 4;
        const gy = hy - W / 20 - k * 20;
        octx.strokeText(p.last.name, hx, gy); octx.fillText(p.last.name, hx, gy);
        octx.globalAlpha = 1;
      }
    }
  }
}
const cssCache = {};
function cssVar(v) { return cssCache[v] || (cssCache[v] = getComputedStyle(document.documentElement).getPropertyValue(v).trim()); }

function buildCards() {
  $('cards').innerHTML = players.map(p => `
    <div class="card" id="card${p.i}" style="--c:${p.color}">
      <div class="who">${escapeHtml(p.name)}</div><div class="pct">0%</div>
      <div class="last"></div>
      <div class="bar"><i></i></div>
    </div>`).join('');
  players.forEach(p => {
    $('card' + p.i).onclick = () => {
      const n = prompt('Name for ' + p.name + '?', p.name);
      if (n && n.trim()) { p.name = n.trim().slice(0, 14); saveNames(); buildCards(); updateCards(); }
    };
  });
}
function updateCards() {
  const now = performance.now();
  for (const p of players) {
    const el = $('card' + p.i); if (!el) continue;
    el.querySelector('.pct').textContent = S.percent(p.grades) + '%';
    const last = el.querySelector('.last');
    if (p.last) {
      last.textContent = p.last.name + (p.combo >= 3 ? ` ×${p.combo}` : '');
      last.style.color = cssVar(GRADE_COLORS[p.last.name]);
    }
    el.querySelector('.bar i').style.width = (100 * p.grades.length / Math.max(1, WINDOWS.length)) + '%';
    el.classList.toggle('gone', now - p.lastSeen > 1500);
  }
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function banner(big, small) {
  $('banner').innerHTML = big ? `<div class="big display">${big}</div>${small ? `<div class="small">${small}</div>` : ''}` : '';
}

// ---------------- the loop ----------------
function tick() {
  requestAnimationFrame(tick);
  if (state.phase === 'playing' && TESTCAM) {
    // keep the pretend camera in step with the song
    const want = songTime();
    if (Math.abs(cam.currentTime - want) > 0.15) cam.currentTime = want;
  }
  const fresh = detect();
  if (state.phase === 'setup') {
    const n = latest.length;
    $('seen').textContent = n ? `${n} dancer${n > 1 ? 's' : ''} ready` : 'Looking for dancers…';
  } else if (state.phase === 'playing') {
    if (fresh) { assign(); sample(); }
    gradeDue();
    const t = songTime();
    if (t < S.SCORE_FROM) {
      const left = Math.ceil(S.SCORE_FROM - t);
      banner(left > 2 ? 'Get ready' : String(left), left > 2 ? 'Here comes Cosmo…' : '');
    } else if (t < S.SCORE_FROM + 0.7) banner('Dance!');
    else banner('');
    $('progress').style.width = (100 * t / (END ?? song.duration ?? 53)) + '%';
    if (performance.now() % 500 < 20) updateCards();
    if ((END != null && t >= END) || song.ended) finish();
  }
  if (Q.has('debug') || state.phase === 'setup') {
    $('meter').textContent = `${state.delegate || '…'} ${MODEL} · ${state.detectMs.toFixed(0)} ms`;
  } else $('meter').textContent = '';
  drawOverlay();
}

// ---------------- phases ----------------
async function begin() {
  $('go').disabled = true;
  try {
    status('Loading the dance judge…');
    const ref = loadRef();
    await openCamera();
    status('Loading the dance judge…');
    await loadModel();
    await ref;
    try { song.load(); } catch (e) {}
    $('title').hidden = true; $('setup').hidden = false;
    state.phase = 'setup';
    banner('', '');
  } catch (e) {
    console.error(e);
    status(e.name === 'NotAllowedError' ? 'The camera was blocked. Allow it in the browser and try again.'
      : 'Could not start: ' + (e.message || e), true);
    state.errors.push(String(e.message || e));
    $('go').disabled = false;
  }
}

async function startSong() {
  setupPlayers();
  buildCards();
  wi = 0; state.windowsGraded = 0;
  $('setup').hidden = true;
  state.phase = 'playing';
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) {}
  song.currentTime = 0;
  if (TESTCAM) { cam.currentTime = 0; cam.play().catch(() => {}); }
  try { await song.play(); } catch (e) { state.errors.push('song: ' + e.message); }
}

function finish() {
  if (state.phase !== 'playing') return;
  // grade anything left (the last window ends right at the end of the clip)
  const t = songTime() + 10;
  while (wi < WINDOWS.length && t > WINDOWS[wi][1]) {
    const w = WINDOWS[wi];
    for (const p of players) {
      const res = S.gradeWindow(R, w, p.samples.filter(x => x.t >= w[0] && x.t < w[1]));
      if (res) { p.grades.push(res.grade); p.counts[res.grade.name]++; }
    }
    wi++;
  }
  state.windowsGraded = wi;
  state.phase = 'results';
  song.pause();
  if (TESTCAM) cam.pause();
  try { wakeLock && wakeLock.release(); } catch (e) {}
  banner('');
  showResults();
}

function showResults() {
  // someone the camera only glimpsed (a passer-by, a false detection) is not on the podium
  const ranked = players.filter(p => p.present >= Math.max(1, 0.25 * p.grades.length))
    .map(p => ({ p, pct: S.percent(p.grades) }))
    .sort((a, b) => b.pct - a.pct || b.p.counts.PERFECT - a.p.counts.PERFECT);
  const tie = ranked.length > 1 && ranked[0].pct === ranked[1].pct && ranked[0].p.counts.PERFECT === ranked[1].p.counts.PERFECT;
  state.players = ranked.map(({ p, pct }) => ({ name: p.name, pct, counts: p.counts, graded: p.grades.length, bestCombo: p.bestCombo, log: p.log }));
  $('winner').textContent = !ranked.length ? 'Nobody danced!' : ranked.length === 1 ? `${ranked[0].pct}%`
    : tie ? "It's a tie!" : `${ranked[0].p.name} wins!`;
  $('podium').innerHTML = ranked.map(({ p, pct }, i) => `
    <div class="line ${i === 0 && ranked.length > 1 && !tie ? 'win' : ''}" style="--c:${p.color}">
      <div class="rank">${i + 1}</div>
      <div><div class="name">${escapeHtml(p.name)}</div><div class="ttl">${S.title(pct)}</div>
        <div class="counts">${p.counts.PERFECT} perfect · ${p.counts.GOOD} good · ${p.counts.OK} ok · ${p.counts.MISS} miss · best streak ${p.bestCombo}</div></div>
      <div class="pct">${pct}%</div>
    </div>`).join('') || '<p>The camera could not see anyone. Step back so it sees you head to toe.</p>';
  let best = 0;
  try { best = +localStorage.getItem('danceoff.best') || 0; } catch (e) {}
  const top = ranked.length ? ranked[0].pct : 0;
  if (top > best) { best = top; try { localStorage.setItem('danceoff.best', String(best)); } catch (e) {} $('best').textContent = `New best on this device: ${best}%!`; }
  else $('best').textContent = `Best on this device: ${best}%`;
  $('results').hidden = false;
}

$('go').onclick = begin;
$('start').onclick = startSong;
$('again').onclick = () => {
  $('results').hidden = true; $('setup').hidden = false;
  state.phase = 'setup'; players = []; buildCards();
  song.currentTime = 0;
};
song.addEventListener('ended', finish);
// the camera panel takes the camera's shape, so nobody at the edge is cut off
cam.addEventListener('loadedmetadata', () => { $('camBox').style.aspectRatio = `${cam.videoWidth} / ${cam.videoHeight}`; });
requestAnimationFrame(tick);
