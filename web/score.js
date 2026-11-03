// Scoring: how close is a dancer's pose to Cosmo's? Pure, no DOM, so the
// game and dancecheck.mjs share it.
//
// A pose here is 13 points [x, y, visibility] in the order of POINTS, with
// x and y normalised to the image they came from (0..1) and `aspect` that
// image's width / height. Only limb *directions* are compared, never
// positions or lengths: a 6-year-old at the back of the room and a tall
// adult at the front score the same for the same move.

// MediaPipe landmark numbers, in the order ref.json stores them.
export const POINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const NOSE = 0, LSH = 1, RSH = 2, LEL = 3, REL = 4, LWR = 5, RWR = 6,
  LHIP = 7, RHIP = 8, LKN = 9, RKN = 10, LAN = 11, RAN = 12;
const MID_SH = -1, MID_HIP = -2;

// [from, to, weight, isLeg]. Each limb is in twice: L and R.
const SEGMENTS = [
  // Weights follow how much each part moves in this routine (measured: upper
  // arms swing ~44 degrees, forearms ~80, thighs ~21, shins ~15, torso ~27).
  // Parts that hardly move would hand out points for standing there.
  [LSH, LEL, 1.0], [RSH, REL, 1.0],      // upper arms
  [LEL, LWR, 0.8], [REL, RWR, 0.8],      // forearms (noisier to detect)
  [LHIP, LKN, 0.35, 1], [RHIP, RKN, 0.35, 1], // thighs
  [LKN, LAN, 0.2, 1], [RKN, RAN, 0.2, 1],   // shins
  [MID_HIP, MID_SH, 0.3],                // torso lean
];
// the same list with left and right swapped, for mirror-image dancing
const SWAP = { [LSH]: RSH, [RSH]: LSH, [LEL]: REL, [REL]: LEL, [LWR]: RWR, [RWR]: LWR,
  [LHIP]: RHIP, [RHIP]: LHIP, [LKN]: RKN, [RKN]: LKN, [LAN]: RAN, [RAN]: LAN };
const sw = i => (i in SWAP ? SWAP[i] : i);

const VIS = 0.5;

function pt(pose, i) {
  if (i === MID_SH) return mid(pose[LSH], pose[RSH]);
  if (i === MID_HIP) return mid(pose[LHIP], pose[RHIP]);
  return pose[i];
}
function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.min(a[2], b[2])]; }

// angle of each segment, or null where a point is not visible
export function angles(pose, aspect, mirror = false) {
  return SEGMENTS.map(([a, b]) => {
    if (mirror) { a = sw(a); b = sw(b); }
    const p = pt(pose, a), q = pt(pose, b);
    if (p[2] < VIS || q[2] < VIS) return null;
    let dx = (q[0] - p[0]) * aspect, dy = q[1] - p[1];
    if (mirror) dx = -dx;
    if (dx * dx + dy * dy < 1e-8) return null;
    return Math.atan2(dy, dx);
  });
}

// 1 within FULL, falling to 0 at ZERO, falling to 0 at ZERO degrees
const FULL = 15 * Math.PI / 180, ZERO = 60 * Math.PI / 180;
function closeness(a, b) {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d <= FULL ? 1 : d >= ZERO ? 0 : 1 - (d - FULL) / (ZERO - FULL);
}

// Similarity of a dancer's angles to one reference frame's angles, 0..1.
// Reference limbs that are not visible (Cosmo's legs off the bottom of the
// shot) do not count. A dancer's limb we cannot see scores 0, except legs:
// if the camera cannot see the dancer's legs at all, legs are left out, but
// the result is capped so stepping back into the shot is still worth it.
export function similarity(dancer, ref) {
  let sum = 0, w = 0, legsSeen = false, legsWanted = false;
  for (let k = 0; k < SEGMENTS.length; k++) {
    if (SEGMENTS[k][3] && dancer[k] != null) legsSeen = true;
  }
  for (let k = 0; k < SEGMENTS.length; k++) {
    const r = ref[k]; if (r == null) continue;
    const [, , weight, leg] = SEGMENTS[k];
    if (leg) { legsWanted = true; if (!legsSeen) continue; }
    w += weight;
    if (dancer[k] != null) sum += weight * closeness(dancer[k], r);
  }
  if (!w) return null;
  const s = sum / w;
  return legsWanted && !legsSeen ? Math.min(s, 0.85) : s;
}

// How much a pose sequence moves: mean absolute change of limb angles per
// second. Used so that standing still while Cosmo flails does not score.
export function motion(seq, fps) {
  let tot = 0, n = 0;
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1], b = seq[i]; if (!a || !b) continue;
    for (let k = 0; k < 8; k++) {   // limbs only, not the torso
      if (a[k] == null || b[k] == null) continue;
      let d = Math.abs(a[k] - b[k]) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d;
      tot += d; n++;
    }
  }
  return n ? tot / n * fps : 0;
}

// ---- the reference, prepared once ----
// `song` is the song's entry in songs.json: its beat grid and when scoring
// starts. Everything time-based about a song hangs off R.
export function prepareRef(ref, song) {
  const angs = ref.frames.map(f => f ? angles(f, ref.aspect) : null);
  const mirs = ref.frames.map(f => f ? angles(f, ref.aspect, true) : null);
  return { fps: ref.fps, aspect: ref.aspect, frames: ref.frames, angs, mirs, length: ref.frames.length / ref.fps,
    beat: 60 / song.bpm, firstBeat: song.firstBeat, gradeBeats: song.gradeBeats || 2, scoreFrom: song.scoreFrom };
}

// Chance level for a window: how well Cosmo's own moves from OTHER parts of
// the routine fit it. Some moments are easy (arms down, standing tall:
// anyone matches those) and some are distinctive. A window pays out only
// for matching better than chance, so made-up moves score low everywhere.
export const MAX_CHANCE = 0.88;
const CHANCE_OFFSETS = [-12, -9, -6, -4, 4, 6, 9, 12];
export function chance(R, w, T = TIMING) {
  const vals = [];
  for (const off of CHANCE_OFFSETS) {
    const samples = [];
    for (let t = w[0]; t < w[1]; t += 1 / 15) {
      let i = Math.round((t + off) * R.fps);
      if (i < 0 || i >= R.angs.length) i = ((i % R.angs.length) + R.angs.length) % R.angs.length;
      if (R.angs[i]) samples.push({ t, angs: R.angs[i], mir: R.mirs[i] });
    }
    const f = samples.length >= 4 && fit(R, samples, T);
    if (f) vals.push(f.s);
  }
  if (!vals.length) return 0.5;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];   // the median: one lucky look-alike moment should not set it
}

// The timing grid: one window every gradeBeats beats, starting at the
// first boundary at or after scoreFrom (all clip times), up to `end`.
// Tempo and first beat are measured by tools/beats.py.
export function windows(R, end = R.length) {
  const out = [];
  const len = R.beat * R.gradeBeats;
  let t = R.firstBeat + Math.ceil((R.scoreFrom - R.firstBeat) / len - 1e-9) * len;
  for (; t + len <= Math.min(end, R.length) + 1e-6; t += len) out.push([t, t + len]);
  return out;
}

// Dancers are usually a little late (they are copying), and the camera adds
// its own delay; some dancers know the routine and anticipate the beat.
// Each window is compared at ONE delay, anywhere from EARLY seconds early to LATE seconds late, whichever fits best, and in one
// direction (straight or mirror). One delay for the whole window matters:
// letting every camera frame pick its own best moment of Cosmo's dance
// made up moves score 95%.
export const LATE = 0.5, EARLY = 0.25;
// The timing allowance as an object, so the results screen can re-grade a
// finished song with other values (the Ahead / Behind sliders).
export const TIMING = { early: EARLY, late: LATE };

// The best fit of a run of samples [{t, angs, mir}] to Cosmo: the mean
// similarity at the best single delay and direction. Each sample is a
// camera frame. The worst quarter of samples are dropped (a blurred frame,
// a bad detection) before averaging.
export function fit(R, samples, T = TIMING) {
  let best = null;
  const lo = -Math.round(T.early * R.fps), hi = Math.round(T.late * R.fps);
  for (let lagF = lo; lagF <= hi; lagF++) {
    for (const key of ['angs', 'mir']) {
      const sims = [];
      for (const x of samples) {
        const i = Math.round(x.t * R.fps) - lagF;
        const r = i >= 0 && i < R.angs.length ? R.angs[i] : null;
        if (!r || !x[key]) continue;
        const v = similarity(x[key], r);
        if (v != null) sims.push(v);
      }
      if (sims.length < 2) continue;
      sims.sort((p, q) => q - p);
      const keep = sims.slice(0, Math.max(2, Math.ceil(sims.length * 0.75)));
      const m = keep.reduce((p, q) => p + q, 0) / keep.length;
      // edge: the best delay is the most allowed, so a wider allowance might fit better
      if (!best || m > best.s) best = { s: m, lag: lagF / R.fps, mirror: key === 'mir', n: sims.length,
        edge: lagF === hi && hi > 0 ? 'late' : lagF === lo && lo < 0 ? 'early' : null };
    }
  }
  return best;
}

export const GRADES = [
  // on the 0..1 above-chance scale (see gradeWindow). Tuned with
  // dancecheck: a copy with heavy tracking noise has a median of ~0.7,
  // dancing the wrong part of the song a median of ~0.
  { name: 'PERFECT', min: 0.7, pts: 100 },
  { name: 'GOOD', min: 0.45, pts: 60 },
  { name: 'OK', min: 0.25, pts: 25 },
  { name: 'MISS', min: -1, pts: 0 },
];

// Grade one window from the samples a dancer produced in it,
// samples = [{t, angs, mir}]: the fit at the best delay, measured above the
// window's chance level (0 = no better than random moves from the routine,
// 1 = exactly Cosmo), then scaled down if the dancer barely moved while
// Cosmo did.
export function gradeWindow(R, w, samples, T = TIMING) {
  // Where Cosmo himself was not tracked (he left the shot, or the camera
  // lost him), there is nothing fair to grade: the window is skipped.
  if (!refCovers(R, w)) return null;
  const span = w[1] - w[0];
  const seen = samples.filter(x => x.angs);
  // need some detections in the window (at least ~2.5 a second)
  if (seen.length < Math.max(2, Math.floor(span * 2.5))) return { grade: GRADES[3], s: 0 };
  const f = fit(R, seen, T);
  if (!f) return { grade: GRADES[3], s: 0 };
  // the chance level depends on the allowance too; cached per window and allowance
  const key = T.early + '/' + T.late;
  const cache = w.chances || (w.chances = {});
  const base = cache[key] ?? (cache[key] = chance(R, w, T));
  // Where moves from anywhere else in the routine fit just as well (Cosmo
  // crouched or turned, only a limb or two visible), the window cannot tell
  // good dancing from bad: skip it, like a window where he was not tracked.
  // Center Court has ~15 of these, the original 4.
  if (base > MAX_CHANCE) return null;
  let s = Math.max(0, (f.s - base) / Math.max(0.15, 1 - base));
  const i0 = Math.max(0, Math.floor(w[0] * R.fps)), i1 = Math.min(R.angs.length, Math.ceil(w[1] * R.fps) + 1);
  const refMove = motion(R.angs.slice(i0, i1), R.fps);
  let dMove = 0;
  if (seen.length > 1) {
    const rate = (seen.length - 1) / Math.max(1e-3, seen[seen.length - 1].t - seen[0].t);
    dMove = motion(seen.map(x => x.angs), rate);
  }
  if (refMove > 1.0) {   // Cosmo is really moving (radians/s)
    // Standing still while Cosmo dances scores nothing, however well the
    // frozen pose happens to fit. (Tracking jitter alone moves a still
    // dancer's limbs about a fifth as much as the dance does.)
    const ratio = dMove / refMove;
    if (ratio < 0.5) s *= Math.max(0, (ratio - 0.15) / 0.35);
  }
  const grade = GRADES.find(g => s >= g.min);
  return { grade, s, lag: f.lag, mirror: f.mirror, edge: f.edge };
}

export function refCovers(R, w) {
  const i0 = Math.max(0, Math.floor((w[0] - LATE) * R.fps)), i1 = Math.min(R.angs.length - 1, Math.ceil((w[1] + EARLY) * R.fps));
  let n = 0; for (let i = i0; i <= i1; i++) if (R.angs[i]) n++;
  return n >= 0.4 * (i1 - i0 + 1);
}

// Overall: points earned over points possible, as a percentage.
export function percent(grades) {
  if (!grades.length) return 0;
  return Math.round(100 * points(grades) / (100 * grades.length));
}
// The score: points for every move graded. A dancer who was there for the
// whole song can earn more than one who joined late or was often hidden.
export function points(grades) { return grades.reduce((a, g) => a + g.pts, 0); }
export const fmt = n => n.toLocaleString('en-US');

export function title(pct) {
  if (pct >= 85) return 'Cosmo Certified';
  if (pct >= 70) return 'Cougarette Material';
  if (pct >= 55) return 'Student Section Legend';
  if (pct >= 40) return 'Tailgate Shuffler';
  if (pct >= 25) return 'Walk-On';
  return 'Ute in Disguise';
}
