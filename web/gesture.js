// The touchdown start: everyone in view raises both arms, like a ref
// signalling a touchdown, and the song starts. Pure, no DOM, so dancecheck
// tests it in Node.
//
// Meant to be easy, not strict:
// - an arm counts as up if its wrist OR its elbow is above the shoulder,
//   so bent arms, one hand lower than the other, and kids flapping all count;
// - a person who flickers (the model loses an arm for a frame) stays "up"
//   for a short while (HOLD_UP_MS);
// - the whole room has to be up for only HOLD_MS.
// It only fires after arms have been down (READY_MS of not everyone up),
// so people still celebrating on the results screen do not restart it.

// 13-point layout (score.js POINTS): 0 nose, 1/2 shoulders, 3/4 elbows, 5/6 wrists, 7/8 hips
const VIS = 0.3;

export function armUp(pose, sh, el, wr) {
  const s = pose[sh], e = pose[el], w = pose[wr];
  if (s[2] < VIS) return false;
  const torso = Math.max(0.02, Math.abs(((pose[7][1] + pose[8][1]) / 2) - ((pose[1][1] + pose[2][1]) / 2)));
  const wristUp = w[2] >= VIS && w[1] < s[1] - 0.1 * torso;
  const elbowUp = e[2] >= VIS && e[1] < s[1] - 0.05 * torso;
  return wristUp || elbowUp;
}
export function armsUp(pose) { return armUp(pose, 1, 3, 5) && armUp(pose, 2, 4, 6); }

export const HOLD_MS = 700, HOLD_UP_MS = 350, READY_MS = 600;

// Feed it every detection frame: update(poses, centres, nowMs).
// Returns { up: [bool per pose], progress: 0..1, fired: bool }.
export class Touchdown {
  constructor() { this.reset(); }
  reset() { this.since = null; this.downSince = null; this.ready = false; this.recent = []; }
  update(poses, centres, now) {
    // match each pose to someone recently up nearby, so a one-frame flicker does not count as down
    const recent = this.recent.filter(r => now - r.at < HOLD_UP_MS);
    const up = poses.map((p, i) => {
      if (armsUp(p)) return true;
      const c = centres[i];
      return recent.some(r => Math.hypot(r.c[0] - c[0], r.c[1] - c[1]) < 0.12);
    });
    poses.forEach((p, i) => { if (armsUp(p)) recent.push({ c: centres[i], at: now }); });
    this.recent = recent;
    const all = poses.length > 0 && up.every(Boolean);
    if (!all) {
      this.since = null;
      if (this.downSince == null) this.downSince = now;
      if (now - this.downSince >= READY_MS) this.ready = true;
      return { up, progress: 0, fired: false, ready: this.ready };
    }
    this.downSince = null;
    if (!this.ready) return { up, progress: 0, fired: false, ready: false };
    if (this.since == null) this.since = now;
    const progress = Math.min(1, (now - this.since) / HOLD_MS);
    return { up, progress, fired: progress >= 1, ready: true };
  }
}
