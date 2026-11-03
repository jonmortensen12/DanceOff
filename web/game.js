// Cosmo Dance-Off: a song on screen, the camera watching up to four
// dancers, every two beats graded against Cosmo's pose (web/ref/SONG.json,
// made by tools/reference.mjs from the same clip). Scoring is in score.js,
// the touchdown start in gesture.js, the replay video in replay.js.
//
// URL options (mostly for testing):
//   ?song=ID           start on this song (an id in songs.json)
//   ?model=lite|full   pose model (default: lite on phones, full elsewhere)
//   ?cpu=1             no GPU for the pose model
//   ?testcam=URL       use a video file as the camera, kept in step with the song
//   ?testcamAt=SEC     where that video sits during setup (default: when scoring starts)
//   ?testcamLag=SEC    keep that video SEC behind the song (a dancer copying late)
//   ?crops=0|always    no extra person crops / crops even when tracking is slow
//   ?end=SEC           stop the song early (clip time)
//   ?noreplay=1        do not record a replay
//   ?debug=1           show detection speed
import { FilesetResolver, PoseLandmarker, ObjectDetector } from './lib/mediapipe/vision_bundle.mjs';
import * as S from './score.js';
import { Touchdown } from './gesture.js';
import * as Replay from './replay.js';

const $ = id => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const PHONE = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
const MODEL = Q.get('model') || (PHONE ? 'lite' : 'full');
const TESTCAM = Q.get('testcam');
const END = Q.has('end') ? +Q.get('end') : null;
const COLORS = ['--p1', '--p2', '--p3', '--p4', '--p5', '--p6', '--p7', '--p8'].map(v => getComputedStyle(document.documentElement).getPropertyValue(v).trim());
const GRADE_COLORS = { PERFECT: '--perfect', GOOD: '--good', OK: '--ok', MISS: '--miss' };
// Four at a time. Room for 8 cost nothing in speed by itself, but the extra
// crop looks that came with it cut looks a second by 30-40% and found
// people who were not there, who then joined mid-song (a 7-year-old was
// tracked badly in a real room). ?dancers=N for testing.
const MAX_DANCERS = +Q.get('dancers') || 4;
// seconds between the dancer moving and the frame reaching us, roughly (a
// video file standing in for the camera has none)
const CAM_LAG = TESTCAM ? 0 : 0.08;
const RECORD = !Q.has('noreplay') && Replay.supported();

const song = $('song'), cam = $('cam'), overlay = $('overlay'), octx = overlay.getContext('2d');

// Everything a check (or a curious person in the console) might want.
const state = window.__dance = {
  phase: 'title', errors: [], detectMs: 0, detections: 0, seen: 0, song: null,
  players: [], windowsGraded: 0, windowsTotal: 0, model: MODEL, delegate: null,
  touchdown: { progress: 0, ready: false, up: 0 }, startedBy: null, replay: null, record: RECORD,
};
addEventListener('error', e => state.errors.push(String(e.message || e)));
addEventListener('unhandledrejection', e => state.errors.push(String(e.reason && e.reason.message || e.reason)));

let SONGS = [], SONG = null, R = null, WINDOWS = [], landmarker = null, stream = null, wakeLock = null;
let latest = [];          // the latest detections: [{pose, c, s, sig}]
let players = [];         // slots, see newPlayer
let wi = 0;               // next window to grade
let lastCamTime = -1, lastStamp = 0;
let recorder = null, replay = null;   // replay: {blob, url, ext}
const touchdown = new Touchdown();
// The timing allowance (how far ahead of / behind Cosmo a move may be). The
// results screen's sliders re-grade the song with other values; "Use these
// from now on" keeps them on this device.
let TIMING = loadTiming();
function loadTiming() {
  try { const t = JSON.parse(localStorage.getItem('danceoff.timing')); if (t && t.early >= 0 && t.late > 0) return { early: t.early, late: t.late }; } catch (e) {}
  return { ...S.TIMING };
}
state.timing = TIMING;
let tdState = { up: [], progress: 0 };

function status(msg, err) { const el = $('status'); el.textContent = msg; el.classList.toggle('err', !!err); }

// ---------------- songs ----------------
async function loadSongs() {
  SONGS = await (await fetch('songs.json')).json();
  let want = Q.get('song');
  if (!want) try { want = localStorage.getItem('danceoff.song'); } catch (e) {}
  await pickSong(SONGS.some(s => s.id === want) ? want : SONGS[0].id);
  $('songs').innerHTML = SONGS.map(s => `
    <button data-id="${s.id}" aria-pressed="${s.id === SONG.id}"><img src="${s.poster}" alt="">
      <span>${escapeHtml(s.title)}<small>${escapeHtml(s.sub)}</small></span></button>`).join('');
  $('songs').querySelectorAll('button').forEach(b => b.onclick = () => pickSong(b.dataset.id).catch(e => state.errors.push(e.message)));
}

async function pickSong(id) {
  const s = SONGS.find(x => x.id === id);
  const r = await (await fetch(s.ref)).json();
  SONG = s; state.song = s.id;
  R = S.prepareRef(r, s);
  WINDOWS = S.windows(R, END != null ? END : R.length);
  state.windowsTotal = WINDOWS.length;
  if (!song.src.endsWith(s.video)) { song.src = s.video; song.load(); }
  try { localStorage.setItem('danceoff.song', id); } catch (e) {}
  $('songs').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
  if (TESTCAM && state.phase === 'setup') cam.currentTime = testcamAt();
}
function testcamAt() { return Q.has('testcamAt') ? +Q.get('testcamAt') : R.scoreFrom; }

// ---------------- loading ----------------
async function loadModel() {
  const vision = await FilesetResolver.forVisionTasks(new URL('lib/mediapipe/wasm', location.href).href.replace(/\/$/, ''));
  const opts = delegate => ({
    baseOptions: { modelAssetPath: `models/pose_${MODEL}.task`, delegate },
    runningMode: 'VIDEO', numPoses: MAX_DANCERS,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  const cropOpts = delegate => ({
    baseOptions: { modelAssetPath: `models/pose_${MODEL}.task`, delegate },
    runningMode: 'IMAGE', numPoses: 1,
    minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4,
  });
  const personOpts = delegate => ({
    baseOptions: { modelAssetPath: 'models/person.tflite', delegate },
    runningMode: 'IMAGE', categoryAllowlist: ['person'], scoreThreshold: 0.35, maxResults: 12,
  });
  const extras = async delegate => {
    if (CROPS) cropPose = await PoseLandmarker.createFromOptions(vision, cropOpts(delegate));
    if (COUNT || CROPS) people = await ObjectDetector.createFromOptions(vision, personOpts(delegate));
  };
  if (!Q.has('cpu')) {
    try {
      landmarker = await PoseLandmarker.createFromOptions(vision, opts('GPU')); state.delegate = 'GPU';
      await extras('GPU');
      return;
    } catch (e) { console.warn('GPU pose failed, using CPU', e); }
  }
  landmarker = await PoseLandmarker.createFromOptions(vision, opts('CPU'));
  await extras('CPU');
  state.delegate = 'CPU';
}

// Groups. MediaPipe's pose model is built for one person: it finds people
// by their faces and, once it is following someone, mostly keeps to them.
// On six Cougarettes in a line it found ONE. A person detector (MediaPipe's
// object detector, EfficientDet-Lite0, `models/person.tflite`) finds people
// far better (5-6 of the 6), so:
// - about twice a second it counts everyone in view (state.inView), which
//   is how the game knows when it is following fewer people than are
//   there, and says to use fewer dancers (setupAdvice / resultsAdvice);
// - each frame, ONE extra pose look goes to someone in view the whole-frame
//   look missed, on a crop round just them, where they fill the picture.
//   Taking turns keeps it to about twice the work, whatever the crowd.
// Skipped while tracking runs under 10 looks a second (the whole-frame look
// comes first). ?crops=0 turns all this off; ?crops=always ignores the speed
// (for testing on a slow machine).
// The extra crop looks are OFF (?crops=1 or always to try them): they made
// tracking slower and invented dancers. The head count stays on (cheap, twice
// a second) for the advice; ?count=0 turns it off.
const CROPS = Q.get('crops') === '1' || Q.get('crops') === 'always';
const COUNT = Q.get('count') !== '0';
let cropPose = null, people = null, boxes = [], boxesAt = 0, cropTurn = 0;
const cropCanvas = document.createElement('canvas');
const cctx = cropCanvas.getContext('2d');
let inViewLog = [], recentFinds = [];   // [{at, inView, followed}] over the last few seconds
function countPeople(now) {
  if (!people || now - boxesAt < 500) return;
  boxesAt = now;
  const vw = cam.videoWidth, vh = cam.videoHeight;
  boxes = people.detect(cam).detections
    .map(d => ({ x: d.boundingBox.originX / vw, y: d.boundingBox.originY / vh, w: d.boundingBox.width / vw, h: d.boundingBox.height / vh }))
    .filter(b => b.h > 0.15);   // whole-ish people, not heads in the background
  state.inView = boxes.length;
}
function cropLook(found) {
  if (!cropPose || !boxes.length) return [];
  if (Q.get('crops') !== 'always' && detTimes.length > 10 && detectRate() < 10) return [];
  // people in view that no pose is inside yet
  const missed = boxes.filter(b => !found.some(d => d.c[0] > b.x && d.c[0] < b.x + b.w && d.c[1] > b.y && d.c[1] < b.y + b.h));
  state.missed = missed.length;
  if (!missed.length) return [];
  const b = missed[cropTurn++ % missed.length];
  const vw = cam.videoWidth, vh = cam.videoHeight;
  const side = Math.max(b.w * vw, b.h * vh) * 1.25;
  const x0 = (b.x + b.w / 2) * vw - side / 2, y0 = (b.y + b.h / 2) * vh - side / 2;
  cropCanvas.width = cropCanvas.height = 256;
  cctx.fillStyle = '#000'; cctx.fillRect(0, 0, 256, 256);
  cctx.drawImage(cam, x0, y0, side, side, 0, 0, 256, 256);
  const res = cropPose.detect(cropCanvas);
  state.cropFinds = (state.cropFinds || 0) + res.landmarks.length;
  // back to whole-frame coordinates
  return res.landmarks.map(lm => lm.map(p => ({ x: (x0 + p.x * side) / vw, y: (y0 + p.y * side) / vh, visibility: p.visibility })));
}

async function openCamera(deviceId) {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  if (TESTCAM) {
    cam.src = TESTCAM; cam.loop = false; cam.muted = true;
    await cam.play().catch(() => {}); cam.pause(); cam.currentTime = testcamAt();
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
// A small copy of each camera frame, for what people look like: the colours
// of their clothes (to tell them apart) and their photos' source.
const grab = document.createElement('canvas');
const gctx = grab.getContext('2d', { willReadFrequently: true });
let pixels = null;

function toPose13(lm) { return S.POINTS.map(i => [lm[i].x, lm[i].y, lm[i].visibility ?? 1]); }
function centreOf(p) {   // between shoulders and hips, in camera coords
  return [(p[1][0] + p[2][0] + p[7][0] + p[8][0]) / 4, (p[1][1] + p[2][1] + p[7][1] + p[8][1]) / 4];
}
function sizeOf(p, aspect) {
  const sx = (p[1][0] + p[2][0]) / 2, sy = (p[1][1] + p[2][1]) / 2, hx = (p[7][0] + p[8][0]) / 2, hy = (p[7][1] + p[8][1]) / 2;
  return Math.hypot((sx - hx) * aspect, sy - hy);
}

// What someone is wearing, as colour: the mean colour of the chest, the
// belly and the thighs. Chroma (r and g as shares of r+g+b) carries the
// most weight, because it changes least as people move in the light.
function signature(p) {
  if (!pixels) return null;
  const W = grab.width, H = grab.height, d = pixels.data;
  const box = (x0, x1, y0, y1) => {
    const xa = Math.max(0, Math.floor(Math.min(x0, x1) * W)), xb = Math.min(W - 1, Math.ceil(Math.max(x0, x1) * W));
    const ya = Math.max(0, Math.floor(Math.min(y0, y1) * H)), yb = Math.min(H - 1, Math.ceil(Math.max(y0, y1) * H));
    if (xb - xa < 2 || yb - ya < 2) return null;
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = ya; y <= yb; y += 2) for (let x = xa; x <= xb; x += 2) {
      const i = (y * W + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
    const sum = r + g + b + 1;
    return [r / sum, g / sum, sum / n / 765];
  };
  const shx = [p[1][0], p[2][0]], hpx = [p[7][0], p[8][0]];
  const inset = (a, b) => [a + (b - a) * 0.2, b - (b - a) * 0.2];
  const [sx0, sx1] = inset(Math.min(...shx), Math.max(...shx));
  const [hx0, hx1] = inset(Math.min(...hpx), Math.max(...hpx));
  const sy = (p[1][1] + p[2][1]) / 2, hy = (p[7][1] + p[8][1]) / 2, my = (sy + hy) / 2;
  const legs = p[9][2] > 0.5 && p[10][2] > 0.5;
  return [
    box(sx0, sx1, sy + (hy - sy) * 0.1, my),
    box(hx0, hx1, my, hy),
    legs ? box(Math.min(p[7][0], p[9][0]), Math.max(p[8][0], p[10][0]), hy + (p[9][1] - hy) * 0.15, (hy + (p[9][1] + p[10][1]) / 2) / 2) : null,
  ];
}
export function sigDistance(a, b) {
  if (!a || !b) return null;
  let tot = 0, n = 0;
  for (let k = 0; k < 3; k++) {
    if (!a[k] || !b[k]) continue;
    tot += Math.hypot((a[k][0] - b[k][0]) * 4, (a[k][1] - b[k][1]) * 4, a[k][2] - b[k][2]); n++;
  }
  return n ? tot / n : null;
}
function blendSig(old, cur, k) {
  if (!old) return cur;
  if (!cur) return old;
  return old.map((o, i) => !o ? cur[i] : !cur[i] ? o : o.map((v, j) => v + (cur[i][j] - v) * k));
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
  detTimes.push(t0); while (detTimes.length && t0 - detTimes[0] > 3000) detTimes.shift();
  const aspect = cam.videoWidth / cam.videoHeight;
  // the colours, from a 160 px wide copy of this frame (cheap)
  grab.width = 160; grab.height = Math.round(160 / aspect);
  gctx.drawImage(cam, 0, 0, grab.width, grab.height);
  try { pixels = gctx.getImageData(0, 0, grab.width, grab.height); } catch (e) { pixels = null; }
  const toDet = lm => { const pose = toPose13(lm); return { pose, c: centreOf(pose), s: sizeOf(pose, aspect) }; };
  const whole = res.landmarks.map(toDet);
  countPeople(t0);
  const cropped = cropLook(whole).map(toDet);
  // whole-frame people first: where both looks found someone, the whole-frame one is kept
  latest = whole.concat(cropped).filter(d => d.s > 0.04);   // ignore tiny far-off people (and posters)
  // The model sometimes reports one person twice, slightly apart, and a crop
  // can find someone the whole frame already has. Two bodies whose middles are
  // closer than half a torso are one dancer.
  latest = latest.filter((d, i) => !latest.slice(0, i).some(e => Math.hypot(d.c[0] - e.c[0], (d.c[1] - e.c[1]) / aspect) < 0.5 * Math.max(d.s, e.s)));
  latest.sort((a, b) => b.s - a.s);
  // Everyone found by any look in the last 0.8 s: the extra crop look visits
  // one missed person per frame, so a single frame undercounts.
  for (const d of latest) recentFinds.push({ c: d.c, at: t0 });
  while (recentFinds.length && t0 - recentFinds[0].at > 800) recentFinds.shift();
  const distinct = [];
  for (const f of recentFinds) if (!distinct.some(c => Math.hypot(c[0] - f.c[0], c[1] - f.c[1]) < 0.06)) distinct.push(f.c);
  state.followed = distinct.length;
  // people in view vs people followed, over the last 3 s, for the advice
  if (people) {
    const followed = state.phase === 'setup' ? state.followed : players.filter(p => p.pose || t0 - p.lastSeen < 700).length;
    inViewLog.push({ at: t0, inView: state.inView || 0, followed });
    while (inViewLog.length && t0 - inViewLog[0].at > 3000) inViewLog.shift();
  }
  latest.forEach(d => { d.sig = signature(d.pose); });
  state.seen = latest.length;
  return true;
}

// ---------------- tracking health ----------------
// How well tracking is keeping up, so the game can say "use fewer dancers"
// rather than quietly scoring people wrong. Two things go wrong with a crowd:
// the model slows (fewer looks a second at each dancer), and people overlap
// (hidden limbs, swapped identities).
const detTimes = [];
let health = { ticks: 0, seen: 0, minRate: Infinity };
function detectRate() {
  if (detTimes.length < 2) return 0;
  return (detTimes.length - 1) / ((detTimes[detTimes.length - 1] - detTimes[0]) / 1000);
}
const SLOW_RATE = 8;   // looks a second; below this, quick moves slip between frames
function overlapping(list) {
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (Math.abs(a.c[0] - b.c[0]) < 0.6 * Math.max(a.s, b.s)) return true;   // one in front of the other
  }
  return false;
}
// Over the last 3 s, did the camera see more people than it could follow,
// most of the time? (One look missing someone is normal; a steady gap is not.)
function followingGap() {
  if (inViewLog.length < 6) return null;
  const short = inViewLog.filter(x => x.inView > x.followed);
  if (short.length < 0.7 * inViewLog.length) return null;
  const med = k => { const v = inViewLog.map(x => x[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const inView = med('inView'), followed = med('followed');
  return inView > followed ? { inView, followed } : null;
}
function setupAdvice() {
  const n = latest.length, rate = detectRate();
  const tips = [];
  if (n >= 2 && overlapping(latest)) tips.push('Some dancers are in front of each other: spread out side by side.');
  const gap = followingGap();
  if (gap && gap.inView > MAX_DANCERS) tips.push(`I can see ${gap.inView} people: ${MAX_DANCERS} dance at a time. Take turns!`);
  else if (gap) tips.push(`I can see ${gap.inView} people but can only follow ${gap.followed}. Try ${gap.followed > 1 ? gap.followed : 'fewer'} dancers, more light, or more space between you.`);
  if (n >= 2 && cam.videoWidth && cam.videoWidth < cam.videoHeight * 1.2) tips.push('Turn the phone sideways: it fits more dancers and finds them better.');
  if (n >= 2 && detTimes.length > 10 && rate < SLOW_RATE)
    tips.push(`Tracking is slow with ${n} dancers (${rate.toFixed(0)} looks a second). ${n > 2 ? `Try ${Math.max(2, n - 2)}–${n - 1}` : 'Fewer dancers'} for fairer scores.`);
  return tips.join(' ');
}
function resultsAdvice() {
  const seen = health.ticks ? health.seen / health.ticks : 1;
  const tips = [];
  if (health.minRate < SLOW_RATE) tips.push(`Tracking was slow this round (as low as ${health.minRate.toFixed(0)} looks a second with ${players.length} dancer${players.length === 1 ? '' : 's'}).`);
  if (players.length > 1 && seen < 0.75) tips.push(`The camera lost dancers ${Math.round(100 * (1 - seen))}% of the time.`);
  if (health.gapTicks > 0.5 * health.ticks && health.maxInView > players.length && players.length < MAX_DANCERS)
    tips.push(`It could see ${health.maxInView} people but followed only ${players.length}.`);
  if (tips.length) tips.push(players.length > 2 ? 'Fewer dancers, or more space between them, will score more fairly.' : 'More light and space will help.');
  return tips.join(' ');
}

// ---------------- players ----------------
function newPlayer(i, d) {
  const names = loadNames();
  const p = { i, name: names[i] || 'P' + (i + 1), color: COLORS[i], c: d ? d.c : [0.5, 0.5], s: d ? d.s : 0.2,
    pose: d ? d.pose : null, sig: d ? d.sig : null, lastSeen: performance.now(), samples: [], grades: [], last: null, lastAt: 0,
    combo: 0, bestCombo: 0, present: 0, log: [], all: [], firstPts: null, joined: state.phase === 'playing' ? +songTime().toFixed(2) : 0, photo: null, img: null, counts: { PERFECT: 0, GOOD: 0, OK: 0, MISS: 0 } };
  if (d) takePhoto(p, d.pose);
  return p;
}
function loadNames() { try { return JSON.parse(localStorage.getItem('danceoff.names')) || []; } catch (e) { return []; } }
function saveNames() { try { localStorage.setItem('danceoff.names', JSON.stringify(players.map(p => p.name))); } catch (e) {} }

// A head-and-shoulders photo from the full-size camera frame, mirrored (as
// people see themselves), so the results say who was who.
function takePhoto(p, pose) {
  if (!cam.videoWidth) return;
  const vw = cam.videoWidth, vh = cam.videoHeight;
  const sx = (pose[1][0] + pose[2][0]) / 2 * vw, sy = (pose[1][1] + pose[2][1]) / 2 * vh;
  const hx = (pose[7][0] + pose[8][0]) / 2 * vw, hy = (pose[7][1] + pose[8][1]) / 2 * vh;
  const torso = Math.max(30, Math.hypot(sx - hx, sy - hy));
  const h = 1.9 * torso, w = h * 0.8;
  const cx = pose[0][2] > 0.5 ? pose[0][0] * vw : sx;
  const top = (pose[0][2] > 0.5 ? pose[0][1] * vh : sy - 0.6 * torso) - 0.5 * h;
  const c = document.createElement('canvas'); c.width = 160; c.height = 200;
  const x = c.getContext('2d');
  x.fillStyle = '#123'; x.fillRect(0, 0, 160, 200);
  x.translate(160, 0); x.scale(-1, 1);
  x.drawImage(cam, cx - w / 2, top, w, h, 0, 0, 160, 200);
  p.photo = c.toDataURL('image/jpeg', 0.85);
  p.img = new Image(); p.img.src = p.photo;
}

// Who is who. Each detection goes to the nearest player, nearest pairs
// first, where "near" is position plus how alike their clothes are. A
// detection nobody claims goes to someone we just lost track of; only when
// everyone is accounted for is it a new dancer.
const LOOK = 0.5;   // how much a difference in clothes counts, against frame widths of distance
function assign() {
  const now = performance.now();
  const pairs = [];
  latest.forEach((d, di) => players.forEach((p, pi) => {
    const dist = Math.hypot(d.c[0] - p.c[0], d.c[1] - p.c[1]);
    if (dist < Math.max(0.12, p.s * 2.5)) pairs.push([dist + LOOK * (sigDistance(d.sig, p.sig) ?? 0), di, pi]);
  }));
  pairs.sort((a, b) => a[0] - b[0]);
  const usedD = new Set(), usedP = new Set();
  for (const [, di, pi] of pairs) {
    if (usedD.has(di) || usedP.has(pi)) continue;
    usedD.add(di); usedP.add(pi);
    const p = players[pi], d = latest[di];
    p.c = d.c; p.s = d.s; p.pose = d.pose; p.lastSeen = now;
    p.sig = blendSig(p.sig, d.sig, 0.05);   // learn slowly what they look like
  }
  latest.forEach((d, di) => {
    if (usedD.has(di)) return;
    // Someone lost a moment ago is a far better guess than someone gone for
    // seconds (time away counts as distance), and someone in the same
    // clothes better than someone in different ones.
    // Hard-won: without this, one dancer split into P1 and P2 whenever they
    // moved fast, or swapped with a slot that had been empty for seconds.
    let lost = null, ld = Infinity;
    players.forEach((p, pi) => {
      if (usedP.has(pi)) return;
      const away = Math.min(1, (now - p.lastSeen) / 2000);
      const cost = Math.hypot(d.c[0] - p.c[0], d.c[1] - p.c[1]) + 0.5 * away + 1.5 * LOOK * (sigDistance(d.sig, p.sig) ?? 0);
      if (cost < ld) { ld = cost; lost = pi; }
    });
    if (lost != null) {
      usedD.add(di); usedP.add(lost);
      Object.assign(players[lost], { c: d.c, s: d.s, pose: d.pose, lastSeen: now });
      return;
    }
    if (players.length >= MAX_DANCERS) return;
    // The line-up is fixed once the dancing starts: someone walking through,
    // or a passing false detection, does not become a player. Latecomers
    // during the countdown still join.
    if (songTime() >= R.scoreFrom) return;
    // not a ghost double of someone already playing
    if (players.some(p => Math.hypot(d.c[0] - p.c[0], d.c[1] - p.c[1]) < p.s * 1.2)) return;
    players.push(newPlayer(players.length, d));
    usedP.add(players.length - 1);
    buildCards();
  });
  players.forEach(p => { if (!usedP.has(p.i)) p.pose = null; });
  publishPlayers(players);
}
function publishPlayers(list) {
  state.players = list.map(p => ({ name: p.name, joined: p.joined, pts: S.points(p.grades), pct: S.percent(p.grades), counts: p.counts, graded: p.grades.length,
    bestCombo: p.bestCombo, log: p.log, photo: !!p.photo }));
}

// At the start, the players are whoever is in view, numbered left to
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
    const x = { t, angs, mir };
    p.samples.push(x); p.all.push(x);   // all: the whole song, for re-grading afterwards
  }
  health.ticks++;
  const gap = followingGap();
  if (gap) { health.gapTicks = (health.gapTicks || 0) + 1; health.maxInView = Math.max(health.maxInView || 0, gap.inView); }
  health.seen += players.filter(p => p.pose).length / Math.max(1, players.length);
}

function gradeWindow(w, p, from = p.samples) {
  const inW = from.filter(x => x.t >= w[0] && x.t < w[1]);
  const res = S.gradeWindow(R, w, inW, TIMING);
  if (!res) return null;            // Cosmo not tracked here: not graded
  if (inW.length >= 2) p.present++;
  p.log.push({ t: +w[0].toFixed(2), s: +res.s.toFixed(2), lag: res.lag, mirror: res.mirror, edge: res.edge, n: inW.length });
  const g = res.grade;
  p.grades.push(g); p.counts[g.name]++;
  p.combo = g.name === 'PERFECT' || g.name === 'GOOD' ? p.combo + 1 : 0; p.bestCombo = Math.max(p.bestCombo, p.combo);
  return g;
}

function gradeDue(final) {
  const t = final ? Infinity : songTime() - CAM_LAG;
  while (wi < WINDOWS.length && t > WINDOWS[wi][1]) {
    const w = WINDOWS[wi];
    if (final && w[1] > songTime() + 0.5) break;   // ended early: windows not reached are not graded
    for (const p of players) {
      const g = gradeWindow(w, p);
      if (g) { p.last = g; p.lastAt = performance.now(); }
      p.samples = p.samples.filter(x => x.t >= w[1] - 2);
    }
    wi++; state.windowsGraded = wi;
    updateCards();
  }
}

// ---------------- drawing ----------------
const BONES = [[1, 2], [1, 3], [3, 5], [2, 4], [4, 6], [1, 7], [2, 8], [7, 8], [7, 9], [9, 11], [8, 10], [10, 12]];

// Name tags and grade pop-ups over each dancer: on screen and in the replay.
function drawTags(ctx, X, Y, scale, now) {
  for (const p of players) {
    if (!p.pose) continue;
    const pose = p.pose;
    const hx = X(pose[0][0]), hy = Y(pose[0][1]) - 46 * scale;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = `900 ${Math.round(26 * scale)}px system-ui, sans-serif`;
    ctx.lineWidth = 5 * scale; ctx.strokeStyle = '#000a'; ctx.lineJoin = 'round';
    ctx.strokeText(p.name, hx, hy); ctx.fillStyle = p.color; ctx.fillText(p.name, hx, hy);
    if (p.last && now - p.lastAt < 700) {
      const k = (now - p.lastAt) / 700;
      ctx.globalAlpha = 1 - k * k;
      ctx.font = `900 ${Math.round(44 * scale)}px system-ui, sans-serif`;
      ctx.fillStyle = cssVar(GRADE_COLORS[p.last.name]);
      const gy = hy - 36 * scale - k * 24 * scale;
      ctx.strokeText(p.last.name, hx, gy); ctx.fillText(p.last.name, hx, gy);
      ctx.globalAlpha = 1;
    }
  }
}

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
  const setup = state.phase === 'setup';
  const list = setup ? latest.map((d, i) => ({ pose: d.pose, color: tdState.up[i] ? cssVar('--perfect') : '#ffffff', up: tdState.up[i] }))
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
    if (setup && p.up) {   // a tick over everyone whose arms are up
      octx.font = `900 ${Math.max(18, W / 14)}px system-ui, sans-serif`; octx.textAlign = 'center';
      octx.fillStyle = cssVar('--perfect'); octx.fillText('✓', X(pose[0][0]), Y(pose[0][1]) - W / 14);
    }
  }
  if (!setup) drawTags(octx, X, Y, W / 720, now);
}
const cssCache = {};
function cssVar(v) { return cssCache[v] || (cssCache[v] = getComputedStyle(document.documentElement).getPropertyValue(v).trim()); }

function buildCards() {
  $('cards').innerHTML = players.map(p => `
    <div class="card" id="card${p.i}" style="--c:${p.color}">
      ${p.photo ? `<img class="face" src="${p.photo}" alt="">` : '<div class="face"></div>'}
      <div class="who">${escapeHtml(p.name)}</div><div class="pct">0</div>
      <div class="last"></div>
      <div class="bar"><i></i></div>
    </div>`).join('');
  players.forEach(p => {
    $('card' + p.i).onclick = () => {
      const n = prompt('Name for ' + p.name + '?', p.name);
      if (n && n.trim()) { p.name = n.trim().slice(0, 14); saveNames(); buildCards(); updateCards(); }
    };
  });
  updateCards();
}
function updateCards() {
  const now = performance.now();
  for (const p of players) {
    const el = $('card' + p.i); if (!el) continue;
    el.querySelector('.pct').textContent = S.fmt(S.points(p.grades));
    const last = el.querySelector('.last');
    if (p.last) {
      last.textContent = p.last.name + (p.combo >= 3 ? ` ×${p.combo}` : '');
      last.style.color = cssVar(GRADE_COLORS[p.last.name]);
    }
    el.querySelector('.bar i').style.width = (100 * p.grades.length / Math.max(1, WINDOWS.length)) + '%';
    el.classList.toggle('gone', now - p.lastSeen > 1500);
  }
  if (recorder) recorder.setChips(players.filter(p => p.present || p.pose).map(p => ({ name: p.name, color: p.color, score: S.fmt(S.points(p.grades)), photo: p.img })));
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function banner(big, small) {
  const html = big ? `<div class="big display">${big}</div>${small ? `<div class="small">${small}</div>` : ''}` : '';
  if ($('banner').innerHTML !== html) $('banner').innerHTML = html;
}

// ---------------- the loop ----------------
let lastCardUpdate = 0;
function tick() {
  requestAnimationFrame(tick);
  if (state.phase === 'playing' && TESTCAM) {
    // keep the pretend camera in step with the song (or ?testcamLag=SEC behind it: a slow copier)
    const want = Math.max(0, songTime() - (+Q.get('testcamLag') || 0));
    if (Math.abs(cam.currentTime - want) > 0.15) cam.currentTime = want;
  }
  const fresh = detect();
  const now = performance.now();
  if (state.phase === 'setup') {
    if (fresh) {
      tdState = touchdown.update(latest.map(d => d.pose), latest.map(d => d.c), now);
      state.touchdown = { progress: tdState.progress, ready: tdState.ready, up: tdState.up.filter(Boolean).length };
      const n = Math.max(latest.length, state.followed || 0), up = tdState.up.filter(Boolean).length;
      $('seen').textContent = !n ? 'Looking for dancers…'
        : up && up < n ? `${up} of ${n} arms up…` : up === n && tdState.ready ? 'Touchdown! Hold it…' : `${n} dancer${n > 1 ? 's' : ''} ready`;
      $('tdBar').firstElementChild.style.width = (100 * tdState.progress) + '%';
      const tip = setupAdvice();
      if ($('advice').textContent !== tip) $('advice').textContent = tip;
      state.advice = tip;
      if (tdState.fired) startSong('touchdown');
    }
  } else if (state.phase === 'playing') {
    if (fresh) {
      assign(); sample();
      if (detTimes.length > 15 && songTime() > 2) health.minRate = Math.min(health.minRate, detectRate());
    }
    gradeDue(false);
    const t = songTime();
    if (t < R.scoreFrom) {
      const left = Math.ceil(R.scoreFrom - t);
      banner(left > 2 ? 'Get ready' : String(left), left > 2 ? 'Here comes Cosmo…' : '');
    } else if (t < R.scoreFrom + 0.7) banner('Dance!');
    else banner('');
    $('progress').style.width = (100 * t / (END ?? (song.duration || R.length))) + '%';
    if (now - lastCardUpdate > 400) { lastCardUpdate = now; updateCards(); }
    if ((END != null && t >= END) || song.ended) finish();
  } else if (state.phase === 'paused') {
    banner('Paused', 'Press Resume (or the space bar) to carry on');
  }
  if (recorder && (state.phase === 'playing' || state.phase === 'paused')) recorder.draw(false);
  if (Q.has('debug') || state.phase === 'setup') {
    $('meter').textContent = `${state.delegate || '…'} ${MODEL} · ${state.detectMs.toFixed(0)} ms`;
  } else $('meter').textContent = '';
  drawOverlay();
}

// ---------------- phases ----------------
async function begin() {
  $('go').disabled = true;
  // Inside the tap, before anything is awaited: let the song play with sound
  // later (and be recorded), even when the touchdown, not a tap, starts it.
  // iPhones only allow that for a video first played from a tap.
  if (RECORD) Replay.unlockAudio(song);
  if (song.src) song.play().then(() => { if (state.phase !== 'playing') { song.pause(); song.currentTime = 0; } }).catch(() => {});
  try {
    status('Loading the dance judge…');
    await openCamera();
    await loadModel();
    await songsReady;
    enterSetup();
  } catch (e) {
    console.error(e);
    status(e.name === 'NotAllowedError' ? 'The camera was blocked. Allow it in the browser and try again.'
      : 'Could not start: ' + (e.message || e), true);
    state.errors.push(String(e.message || e));
    $('go').disabled = false;
  }
}

function enterSetup() {
  $('title').hidden = true; $('results').hidden = true; $('setup').hidden = false;
  $('controls').hidden = true;
  document.body.classList.add('lineup');
  state.phase = 'setup';
  players = []; buildCards();
  touchdown.reset();
  song.pause(); song.currentTime = 0;
  if (TESTCAM) { cam.pause(); cam.currentTime = testcamAt(); }
  banner('', '');
}

async function startSong(by) {
  if (state.phase !== 'setup') return;
  state.startedBy = by;
  if (RECORD) Replay.unlockAudio(song);
  setupPlayers();
  buildCards();
  wi = 0; state.windowsGraded = 0;
  health = { ticks: 0, seen: 0, minRate: Infinity };
  $('setup').hidden = true;
  document.body.classList.remove('lineup');
  $('controls').hidden = false; $('pause').textContent = 'Pause';
  state.phase = 'playing';
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) {}
  song.currentTime = 0;
  if (TESTCAM) { cam.currentTime = 0; cam.play().catch(() => {}); }
  replay = null; state.replay = null;
  if (replayUrl) { URL.revokeObjectURL(replayUrl); replayUrl = null; }
  try { await song.play(); } catch (e) { state.errors.push('song: ' + e.message); }
  if (RECORD) {
    try {
      recorder = new Replay.Recorder({ cam, song, songTitle: SONG.title, drawTags: (ctx, X, Y, scale) => drawTags(ctx, X, Y, scale, performance.now()) });
      recorder.start();
      updateCards();
    } catch (e) { console.warn('no replay', e); recorder = null; }
  }
}

function togglePause() {
  if (state.phase === 'playing') {
    state.phase = 'paused';
    song.pause(); if (TESTCAM) cam.pause();
    if (recorder) { recorder.draw(true); recorder.pause(); }
    $('pause').textContent = 'Resume';
  } else if (state.phase === 'paused') {
    state.phase = 'playing';
    banner('');
    if (RECORD) Replay.unlockAudio(song);   // wakes the audio if the phone suspended it meanwhile
    if (recorder) recorder.resume();
    if (TESTCAM) cam.play().catch(() => {});
    song.play().catch(e => state.errors.push('song: ' + e.message));
    $('pause').textContent = 'Pause';
  }
}

async function finish() {
  if (state.phase !== 'playing' && state.phase !== 'paused') return;
  gradeDue(true);
  state.phase = 'results';
  song.pause();
  if (TESTCAM) cam.pause();
  $('controls').hidden = true;
  try { wakeLock && wakeLock.release(); } catch (e) {}
  banner('');
  players.forEach(p => { p.firstPts = S.points(p.grades); });
  state.joined = players.map(p => p.joined);   // everyone, podium or not
  $('resultsAdvice').textContent = resultsAdvice();
  state.resultsAdvice = $('resultsAdvice').textContent;
  setupTuning();
  const ranked = showResults(true);
  if (recorder) {
    const rec = recorder; recorder = null;
    $('watch').disabled = true; $('watch').textContent = 'Making your replay…'; $('replayRow').hidden = false;
    try {
      const rows = ranked.map(({ p, pct, pts }) => ({ name: p.name, color: p.color, score: S.fmt(pts), title: S.title(pct), photo: p.img }));
      replay = await rec.finish(rows, $('winner').textContent);
      if (replay && replay.blob.size) {
        replayUrl = URL.createObjectURL(replay.blob);
        state.replay = { size: replay.blob.size, type: replay.type };
        $('watch').disabled = false; $('watch').textContent = '▶ Watch the replay';
      } else $('replayRow').hidden = true;
    } catch (e) { console.warn(e); state.errors.push('replay: ' + e.message); $('replayRow').hidden = true; }
  } else $('replayRow').hidden = true;
}
let replayUrl = null;

function showResults(first = false) {
  // someone the camera only glimpsed (a passer-by, a false detection) is not on the podium
  // Someone the camera saw for under half the song (a passer-by, a false
  // detection, a kid who wandered off) is not on the podium.
  const ranked = players.filter(p => p.present >= Math.max(1, 0.5 * p.grades.length))
    .map(p => ({ p, pts: S.points(p.grades), pct: S.percent(p.grades) }))
    .sort((a, b) => b.pts - a.pts || b.p.counts.PERFECT - a.p.counts.PERFECT);
  const tie = ranked.length > 1 && ranked[0].pts === ranked[1].pts && ranked[0].p.counts.PERFECT === ranked[1].p.counts.PERFECT;
  publishPlayers(ranked.map(r => r.p));
  $('winner').textContent = !ranked.length ? 'Nobody danced!' : ranked.length === 1 ? `${S.fmt(ranked[0].pts)} pts`
    : tie ? "It's a tie!" : `${ranked[0].p.name} wins!`;
  $('podium').innerHTML = ranked.map(({ p, pct, pts }, i) => `
    <div class="line ${i === 0 && ranked.length > 1 && !tie ? 'win' : ''}" style="--c:${p.color}">
      <div class="rank">${i + 1}</div>
      ${p.photo ? `<img class="face" src="${p.photo}" alt="">` : '<div class="face"></div>'}
      <div><div class="name">${escapeHtml(p.name)}</div><div class="ttl">${S.title(pct)}</div>
        <div class="counts">${p.counts.PERFECT} perfect · ${p.counts.GOOD} good · ${p.counts.OK} ok · ${p.counts.MISS} miss · best streak ${p.bestCombo}</div></div>
      <div class="pct">${S.fmt(pts)}<small>pts</small>${p.firstPts != null && p.firstPts !== pts ? `<small>${pts > p.firstPts ? '▲' : '▼'} was ${S.fmt(p.firstPts)}</small>` : ''}</div>
    </div>`).join('') || '<p>The camera could not see anyone. Step back so it sees you head to toe.</p>';
  let best = 0;
  const key = 'danceoff.bestpts.' + SONG.id;
  try { best = +localStorage.getItem(key) || 0; } catch (e) {}
  const top = ranked.length ? ranked[0].pts : 0;
  if (!first) { $('results').hidden = false; return ranked; }   // re-graded with the sliders: not a new record
  if (top > best) { best = top; try { localStorage.setItem(key, String(best)); } catch (e) {} $('best').textContent = `New best on this device for ${SONG.title}: ${S.fmt(best)} pts!`; }
  else $('best').textContent = `Best on this device for ${SONG.title}: ${S.fmt(best)} pts`;
  $('results').hidden = false;
  return ranked;
}

// ---------------- re-tuning the timing after a song ----------------
// Every camera sample of the song is kept (p.all), so the whole song can be
// graded again with another allowance: drag Ahead / Behind and watch the
// scores move. Each dancer's typical delay, and how often their best fit
// sat right at the limit, say which way to go.
function regrade() {
  for (const p of players) {
    Object.assign(p, { grades: [], counts: { PERFECT: 0, GOOD: 0, OK: 0, MISS: 0 }, combo: 0, bestCombo: 0, present: 0, log: [] });
    for (let k = 0; k < wi; k++) gradeWindow(WINDOWS[k], p, p.all);
  }
  showResults();
  timingStats();
}
function timingStats() {
  $('lagStats').innerHTML = players.filter(p => p.log.length).map(p => {
    const lags = p.log.filter(l => l.lag != null && l.n >= 2).map(l => l.lag).sort((a, b) => a - b);
    if (!lags.length) return '';
    const med = lags[lags.length >> 1];
    const late = p.log.filter(l => l.edge === 'late').length / lags.length, early = p.log.filter(l => l.edge === 'early').length / lags.length;
    const when = Math.abs(med) < 0.05 ? 'right on the beat' : med > 0 ? `${med.toFixed(2)} s behind` : `${(-med).toFixed(2)} s ahead`;
    const hint = late > 0.25 ? ' · often at the Behind limit: try more Behind' : early > 0.25 ? ' · often at the Ahead limit: try more Ahead' : '';
    return `<div style="--c:${p.color}"><b>${escapeHtml(p.name)}</b> usually ${when} · ${Math.round(100 * late)}% of moves at the Behind limit, ${Math.round(100 * early)}% at Ahead${hint}</div>`;
  }).join('');
}
function showTiming() {
  $('earlyVal').textContent = TIMING.early.toFixed(2) + ' s';
  $('lateVal').textContent = TIMING.late.toFixed(2) + ' s';
  $('early').value = TIMING.early; $('late').value = TIMING.late;
  const saved = loadTiming();
  $('keepTiming').disabled = saved.early === TIMING.early && saved.late === TIMING.late;
  state.timing = { ...TIMING };
}
function setupTuning() { showTiming(); timingStats(); }
let regradeTimer = null;
function onSlider() {
  TIMING = { early: +$('early').value, late: +$('late').value };
  showTiming();
  clearTimeout(regradeTimer);
  regradeTimer = setTimeout(regrade, 120);
}
$('early').oninput = onSlider;
$('late').oninput = onSlider;
$('keepTiming').onclick = () => {
  try { localStorage.setItem('danceoff.timing', JSON.stringify(TIMING)); } catch (e) {}
  showTiming(); $('timingNote').textContent = `Saved: ${TIMING.early.toFixed(2)} s ahead, ${TIMING.late.toFixed(2)} s behind, from now on on this device.`;
};
$('resetTiming').onclick = () => {
  try { localStorage.removeItem('danceoff.timing'); } catch (e) {}
  TIMING = { ...S.TIMING }; showTiming(); regrade();
  $('timingNote').textContent = `Back to the defaults (${S.EARLY} s ahead, ${S.LATE} s behind).`;
};

// ---------------- the replay viewer ----------------
function replayName() {
  const d = new Date(), z = n => String(n).padStart(2, '0');
  return `cosmo-danceoff-${SONG.id}-${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.${replay.ext}`;
}
$('watch').onclick = () => {
  if (!replayUrl) return;
  const v = $('replayVideo'); v.src = replayUrl;
  const file = new File([replay.blob], replayName(), { type: replay.type });
  $('share').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  $('replayView').hidden = false;
  v.play().catch(() => {});
};
$('save').onclick = () => {
  const a = document.createElement('a'); a.href = replayUrl; a.download = replayName();
  document.body.appendChild(a); a.click(); a.remove();
};
$('share').onclick = async () => {
  const file = new File([replay.blob], replayName(), { type: replay.type });
  try { await navigator.share({ files: [file], title: 'Cosmo Dance-Off' }); } catch (e) { /* cancelled */ }
};
$('closeReplay').onclick = () => { const v = $('replayVideo'); v.pause(); $('replayView').hidden = true; };

// ---------------- wiring ----------------
// the song list loads with the page, so the first tap can unlock the song
const songsReady = loadSongs().catch(e => { state.errors.push('songs: ' + e.message); status('Could not load the songs: ' + e.message, true); });
$('go').onclick = begin;
$('start').onclick = () => startSong('button');
$('pause').onclick = togglePause;
$('end').onclick = () => finish();
$('again').onclick = enterSetup;
addEventListener('keydown', e => {
  if (e.target.closest && e.target.closest('input, select, textarea')) return;
  if (e.code === 'Space' && (state.phase === 'playing' || state.phase === 'paused')) { e.preventDefault(); togglePause(); }
  else if (e.key === 'Escape' && (state.phase === 'playing' || state.phase === 'paused')) finish();
  else if (e.key === 'Escape' && !$('replayView').hidden) $('closeReplay').click();
  else if (e.key === 'Enter' && state.phase === 'setup') startSong('button');
});
song.addEventListener('ended', () => finish());
// the camera panel takes the camera's shape, so nobody at the edge is cut off
cam.addEventListener('loadedmetadata', () => { $('camBox').style.aspectRatio = `${cam.videoWidth} / ${cam.videoHeight}`; });
requestAnimationFrame(tick);
