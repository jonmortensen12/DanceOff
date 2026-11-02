# Cosmo Dance-Off — handoff

A dance game for the BYU–Utah game-day party (Saturday 2026-11-07, 10 a.m.
kickoff). The routine is Cosmo the Cougar's viral 2017 halftime dance with
the Cougarettes (BYU vs Boise State, Ayo & Teo's "Rolex"). It plays on a
laptop or a phone. The device's camera watches up to four dancers, and
every two beats each one gets PERFECT / GOOD / OK / MISS for how closely
they matched Cosmo. Idea #12 in Night-Watch's `GAMEDAY.md`. It was planned
for a `cougar-cam` repo but lives here.

Built 2026-11-02 from: "Start the video at 5 seconds in and don't start
comparing dancing until 8 seconds in. Stop the video at 58 seconds. Only
track Cosmo (usually in the middle) and not the backup dancers. It will run
on a phone or laptop for now, so not much compute constraint."

## Files

| File | What it is |
|---|---|
| `web/index.html` | The page and all its styling. Title, setup (line up), playing, results. |
| `web/game.js` | Camera, pose model, who is who, sampling, grading as the song plays, drawing, results. |
| `web/score.js` | All the scoring. Pure, no DOM; `dancecheck` runs it in Node. |
| `web/ref.json` | Cosmo's pose for every frame of the clip (30 fps, 13 points). Made by `tools/reference.mjs`. |
| `web/media/rolex.mp4`, `.webm` | The clip: 0:05 to 0:58 of the source video, already cut. The webm is the fallback for a browser without H.264. |
| `web/models/pose_{lite,full}.task` | MediaPipe pose models. Lite on phones, full elsewhere (`?model=` overrides). |
| `web/lib/mediapipe/` | `@mediapipe/tasks-vision` 1.2.0, stored here so the game needs no CDN. |
| `tools/reference.mjs` (+ `extract.html`, `serve.mjs`) | The reference pass. See below. |
| `tools/testcam.py` → `tools/testcam-cosmo.webm` | The clip cropped to follow Cosmo, like a webcam watching one dancer. Used by `dancecheck`. |
| `dancecheck.mjs` | The check. |
| `wrangler.jsonc` | Cloudflare: serves `web/` as plain files. No Worker code. |

## The timeline

All times in code are **clip time**: 0 is 0:05 of the original video.

- The clip starts with the Cougarettes alone, and Cosmo runs in around 1.5 s.
  For the first 3 s the screen counts down: "Get ready", then 2, 1, "Dance!".
- Scoring starts at the first two-beat boundary at or after clip 3.0 s
  (= 0:08). With the beat grid that is clip 3.33 s.
- The clip ends at clip 53 s (= 0:58). The video's `ended` event shows the results.
- The song is ~149.75 BPM, with the first beat at clip 0.128 s, measured from the
  audio by spectral-flux autocorrelation. One grade every 2 beats (0.80 s) is
  62 windows.

## How a dancer is scored (`web/score.js`)

1. **Only limb directions.** Each pose becomes 9 angles: both upper arms,
   forearms, thighs and shins, plus torso lean. Positions and lengths are
   ignored, so a kid at the back and an adult at the front score the same
   for the same move, whatever the camera's shape.
2. **Weights follow what moves in this routine.** Measured over Cosmo's
   track, upper arms swing ~44°, forearms ~80°, thighs ~21°, shins ~15° and
   the torso ~27°. Weights: upper arm 1.0, forearm 0.8, thigh 0.35, shin
   0.2, torso 0.3. Legs barely change, so weighting them equally gave half
   the points for standing there.
3. **Per limb:** 1 within 15°, falling to 0 at 60°.
4. **One delay per window.** The window's camera samples are compared with
   Cosmo at a single delay (from 0.25 s early to 0.5 s late) and in a single
   direction (straight or mirror image), whichever fits best. The worst
   quarter of samples are dropped. **Hard-won:** letting each sample pick
   its own best moment of Cosmo within the delay range made up moves score
   95%.
5. **Above chance.** Each window has a chance level: how well Cosmo's own
   moves from 4–12 s elsewhere in the routine fit it (the median of 8
   offsets). Score = (fit − chance) / (1 − chance). Easy moments (arms down,
   standing tall) pay nothing for just being there.
6. **No standing still.** If Cosmo is moving (> 1 rad/s) and the dancer moves
   less than half as much, the score is cut, to zero at 15%. Tracking jitter
   alone gives a still dancer ~20% of the dance's movement, which is why the
   cut reaches zero above 0.
7. **Grades on that 0..1 scale:** PERFECT ≥ 0.70, GOOD ≥ 0.45, OK ≥ 0.25,
   else MISS. Points 3/2/1/0, and the final % is points over the maximum.
8. **Windows where Cosmo himself was not tracked** (under 40% of the frames
   around it) are skipped, not counted against anyone.

Straight copy and mirror copy both count. Most people facing a screen
copy like a mirror; Just Dance mirrors its dancers for that reason.

Titles: ≥85 Cosmo Certified, ≥70 Cougarette Material, ≥55 Student Section
Legend, ≥40 Tailgate Shuffler, ≥25 Walk-On, below that Ute in Disguise.

## Who is who (`game.js` `assign`)

When START is pressed, whoever is in view becomes P1..P4, numbered left to
right as the dancers see themselves in the mirrored camera view. After
that, each detection goes to the nearest player (nearest pairs first, within
2.5× that player's torso length). A detection nobody claims goes to the
player who was lost most recently and nearest (time away counts as
distance: 2 s away = half a frame-width). Only when every player is
accounted for does it become a new player, while there is room.
**Hard-won:** without that rule one dancer split into P1 and P2 whenever
they moved fast, and without the recency rule they swapped with a slot
that had been empty for seconds. The model also sometimes reports one person
twice. Two bodies whose middles are within half a torso are merged
(`detect`). Players keep their spot by staying on it: the
tape X advice in the setup screen. Tap a card to rename a player; names
are remembered on the device. Someone seen in under a quarter of the
graded windows does not appear in the results.

## Cosmo's reference (`tools/reference.mjs`)

MediaPipe's person detector is weak at crowds. On the whole stadium shot
it finds 0–3 of the ~20 people per frame and often misses the mascot. So
there are two passes, both with the **heavy** model (30 MB, offline only;
put `pose_heavy.task` in `tools/cache/`, otherwise it falls back to full):

1. **Whole frame**, up to 10 people each. For every person: how tan their
   shins, thighs, knees, ankles and forearms are. Cosmo is tan fur; the
   Cougarettes wear navy. Blonde hair is why the head is never sampled.
   Cosmo is then followed through the clip: tan, big, starts near the middle,
   does not teleport.
2. **Crops.** A square around where Cosmo is (interpolated across frames
   pass 1 lost him), each run on its own. He fills the crop, so he is found
   far more often and with sharper points.

Result: Cosmo in 1455 of 1592 frames (91%). Whole-frame alone found 902.
The thinnest stretch is clip 31–37 s, where he is among the dancers and turned.
Windows there with under 40% coverage are not graded. Then short gaps (≤ 8 frames) are filled and the track is lightly smoothed
(5-frame weighted average). Results are cached in `tools/cache/` (not committed), so
`--pick` re-runs the picking in seconds.

**To check a new reference by eye**, draw the track over frames. That is
how the picks were verified: the red skeleton was on Cosmo in every sampled
frame, and the gaps were frames where pass 1 found only Cougarettes.

## URL options

`?model=lite|full`, `?cpu=1` (no GPU), `?testcam=URL` (a video file as the
camera, kept in step with the song), `?end=SEC` (stop early),
`?debug=1` (model and ms per detection in the camera corner; always shown
during setup).

## Checks

`node dancecheck.mjs --quick`: score.js against simulated dancers built
from Cosmo's own track.

`node dancecheck.mjs`: also the real page in headless Chromium (CPU model,
first 20 s; `--verbose` prints every window's fit per dancer). The cameras
are Cosmo cropped (should score high; `tools/testcam.py` greys out
everything but a box round him, because Cougarettes in the shot are not
what a living room looks like), the same
flipped (a mirror copy), a frozen frame (should score low), and the whole
stadium shot (just must not break). Then Chromium's fake camera device
covers the real getUserMedia path. Screenshots: `tools/cache/playing.png`,
`tools/cache/results.png`.
Typical results: Cosmo camera 77%, mirrored 80%, frozen frame ~10%.
Simulated: copy 96%, late copy through shaky tracking 91%, standing
still 0%, made-up moves ~10%, wrong part of the song ~11%.

## Not built / ideas

- The Portal TV and Fire Stick are untested. A Fire Stick has no camera.
- A "ghost Cosmo" stick figure over the camera view; a slower practice mode.
- Posting scores to a party-wide scoreboard (party-hub in GAMEDAY.md).
- Phone as a remote to start or restart from the couch.
- Tuning against real people. The thresholds are set from simulated noise and
  from the pose model watching Cosmo; real dancers in a living room may need
  OK/GOOD lowered a little. Change `GRADES` in `score.js` and re-run the check.
