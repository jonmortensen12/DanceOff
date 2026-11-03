# Cosmo Dance-Off — handoff

A dance game for the BYU–Utah game-day party (Saturday 2026-11-07, 10 a.m.
kickoff). The routines are Cosmo the Cougar's dances with the Cougarettes,
three to choose from (`web/songs.json`). The first is the viral 2017 one (BYU
vs Boise State, Ayo & Teo's "Rolex"). It plays on a laptop or a phone. The device's camera watches up to four dancers, and
every two beats each one gets PERFECT / GOOD / OK / MISS for how closely
they matched Cosmo. Idea #12 in Night-Watch's `GAMEDAY.md`. It was planned
for a `cougar-cam` repo but lives here.

Built 2026-11-02 from: "Start the video at 5 seconds in and don't start
comparing dancing until 8 seconds in. Stop the video at 58 seconds. Only
track Cosmo (usually in the middle) and not the backup dancers. It will run
on a phone or laptop for now, so not much compute constraint."

Second round, 2026-11-02, after the first play at home: "1) start the game
with poses ... when everyone puts their arms up - like a ref calling a
touchdown ... shouldn't be too strict. 2) pause/start and end buttons. 3)
grab an image of each player to display next to the results ... we forgot
who was who ... maybe this could help when players are lost from tracking.
4) replay the dancing, as something funny to share ... make the people
dancing big, and Cosmo's reference video small. 5) two more videos the
players should be able to choose from."

## Files

| File | What it is |
|---|---|
| `web/index.html` | The page and all its styling. Title, setup (line up, pick a song), playing, results, the replay viewer. |
| `web/game.js` | Camera, pose model, who is who (position + clothes colour), photos, sampling, grading as the song plays, pause/end, drawing, results. |
| `web/score.js` | All the scoring. Pure, no DOM; `dancecheck` runs it in Node. |
| `web/gesture.js` | The touchdown start. Pure, no DOM. |
| `web/replay.js` | Records the replay video (canvas + song audio into a MediaRecorder). |
| `web/songs.json` | The songs: title, clip, poster, reference, tempo, first beat, when scoring starts, where the clip was cut from. |
| `web/ref/SONG.json` | Cosmo's pose for every frame of a clip (30 fps, 13 points). Made by `tools/reference.mjs SONG`. |
| `web/media/SONG.mp4`, `SONG.jpg` | The clips, already cut (H.264, plays everywhere), and the setup screen's thumbnails. |
| `web/models/pose_{lite,full}.task` | MediaPipe pose models. Lite on phones, full elsewhere (`?model=` overrides). |
| `web/lib/mediapipe/` | `@mediapipe/tasks-vision` 1.2.0, stored here so the game needs no CDN. |
| `tools/reference.mjs` (+ `extract.html`, `serve.mjs`) | The reference pass. See below. |
| `tools/beats.py` | Measures a clip's tempo and first beat, for `songs.json`. |
| `tools/testcam.py` → `tools/testcam-cosmo.webm` | The clip cropped to follow Cosmo, like a webcam watching one dancer. Used by `dancecheck`. |
| `dancecheck.mjs` | The check. |
| `wrangler.jsonc` | Cloudflare: serves `web/` as plain files. No Worker code. |

## The songs and their timelines

All times in code are **clip time**: 0 is the start of the cut clip.
Until `scoreFrom` the screen counts down ("Get ready", 2, 1, "Dance!").
Scoring starts at the first `gradeBeats` boundary at or after it. The
video's `ended` event shows the results. Tempo and first beat come from
`python3 tools/beats.py web/media/SONG.mp4 --from 2` (spectral-flux
autocorrelation; it reproduces the original's 149.75 exactly).

| id | Title | Cut from | Tempo | Scoring from | Windows |
|---|---|---|---|---|---|
| `rolex` | The Original | 0:05–0:58 of the 2017 Boise State video. Cosmo runs in ~1.5 s. | 149.75 BPM, first beat 0.128 | clip 3.0 (= 0:08); first window 3.33 | 62 × 0.80 s |
| `field` | Cougarettes in White | 0:05–0:51 of `Cosmo2.mp4` (football field, Cougarettes in white, Cosmo in blue). He runs in at ~0:07 and is gone by 0:52. | 95.75 BPM, first beat 0.313 | clip 3.0 (= 0:08) | 1.25 s windows |
| `court` | Center Court | 0:00–0:55 of `Cosmo3.mp4` (basketball court, Cosmo in white between two featured dancers). Ends on his touchdown pose. | 149.75 BPM, first beat 0.0 | clip 2.5 | 0.80 s windows |

**Adding a song:** cut the clip to `web/media/ID.mp4` (30 fps, H.264, under
25 MiB), make a poster `web/media/ID.jpg`, run `tools/beats.py`, add it to
`songs.json`, run `node tools/reference.mjs ID` (~25 min), check the
track by eye (below), then `node dancecheck.mjs`.

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
   else MISS. **The score is points**: 100 / 60 / 25 / 0 a move, added up
   (`points`). That was asked for on 2026-11-03, replacing a percentage, so
   time on the floor counts: someone hidden for half the song earns half.
   The percentage (`percent`) is still computed, for the titles and the
   checks. "Best on this device" is kept per song in points
   (`danceoff.bestpts.SONG`).

### Tuning the timing allowance after a song

The allowance (step 4) defaults to `EARLY` 0.25 s / `LATE` 0.5 s in
`score.js`, and every grading function takes it as a parameter
(`{early, late}`). The game keeps every camera sample of the song
(`p.all`), so the results screen's **Timing** panel can re-grade the
finished song as the Ahead (0–0.8 s) and Behind (0.1–1.5 s) sliders move.
Each score shows "▲ was 37%" against what was played. Per dancer it shows
the median delay of their best fits ("usually 0.73 s behind") and how often
the best fit sat right at the Ahead or Behind limit (`edge` from `fit`). More
than a quarter at a limit suggests widening that side. **Use these from now
on** saves the values in `localStorage` (`danceoff.timing`), and **Back to
defaults** clears them.

Widening is not free: the chance level (step 5) is computed with the same
allowance, and random moves fit a wide allowance better too, so the bar
rises. A dancer 0.8 s late goes from 37% to 74% with Behind at 1.1 s, while
an on-time dancer drops a few points (82% to 78% at 0.5/1.0).
`dancecheck --quick` checks that even the sliders' far ends (0.8 / 1.5 s)
leave made-up moves and standing still scoring low.
Re-grading with the sliders never sets a "best on this device".
8. **Windows where Cosmo himself was not tracked** (under 40% of the frames
   around it) are skipped, not counted against anyone. So are windows whose
   chance level is above 0.88 (`MAX_CHANCE`): Cosmo is crouched or turned
   with a limb or two visible, and moves from anywhere in the routine fit as
   well as the right one. A perfect copy scored only 85% on Center Court
   before this. It skips 4 of the original's windows and 15 of Center
   Court's.

Straight copy and mirror copy both count. Most people facing a screen
copy like a mirror; Just Dance mirrors its dancers for that reason.

Titles: ≥85 Cosmo Certified, ≥70 Cougarette Material, ≥55 Student Section
Legend, ≥40 Tailgate Shuffler, ≥25 Walk-On, below that Ute in Disguise.

## Starting, pausing, ending

- **The touchdown** (`gesture.js`). In the line-up screen, the song
  starts when everyone in view raises both arms and holds them up 0.7 s.
  It is deliberately easy: an arm is up if the wrist **or** the elbow is
  above the shoulder, so bent arms count, and so does a hand the camera
  lost if its elbow is up. Someone who flickers for a frame stays "up"
  for 0.35 s. It only fires after 0.6 s of not everyone up, so the
  celebration at the end of a song does not restart it. A tick appears over
  each person whose arms are up, and the line says "2 of 3 arms up…". The
  Start button (and Enter) still works.
- The first tap ("Let's dance") also unlocks the song's sound, which an
  iPhone otherwise refuses when the song starts without a tap. That is
  why `songs.json` loads with the page and `begin()` plays the song before
  awaiting anything.
- **Pause / End** sit on the song while it plays (space bar and Esc on a
  laptop). Pause stops the song, the grading and the replay recording
  together. End grades what was danced (windows not reached are not
  counted) and goes to the results.

## How many dancers (`game.js`, "Groups")

**Four** (`MAX_DANCERS`; `?dancers=N` to test others).

**Hard-won (2026-11-02 to 11-03):** it was raised to 8 for one day, with
extra "crop looks": a person detector found people the pose model missed,
and each frame one extra pose look went to a crop around one of them. In
the first real-room game after that, a 7-year-old was tracked badly and a
player joined part-way through for a few seconds. Measured afterwards:
the cap of 8 by itself cost nothing, but the crop looks cut looks a second by
30-40% (14.5 to 10.4 with one dancer, 5.0 to 3.0 with six on the test
machine). With only Cosmo in view they also found a second "person" who was
not there. So the cap is back at 4 and crop looks are off (`?crops=1` or
`always` to try them). They did follow more of a six-person group (3
instead of 1), at that cost.

What stays:

- **The head count.** MediaPipe's ObjectDetector (EfficientDet-Lite0,
  `web/models/person.tflite`) counts people in view twice a second
  (`state.inView`; `?count=0` turns it off). The pose model is built for one
  person: on six Cougarettes in a line it found one, while the detector
  found 5-6.
- **Advice from it** (`setupAdvice`, `resultsAdvice`):
  - More people in view than 4: "I can see 6 people: 4 dance at a time.
    Take turns!"
  - More in view than followed: "I can see 3 people but can only follow 2.
    Try 2 dancers, more light, or more space between you."
  - Also: tracking slow (under 8 looks a second), dancers in front of each
    other, a portrait phone, dancers lost often.
- **The line-up locks when the dancing starts** (`assign`): after
  `scoreFrom`, an unclaimed detection never becomes a new player. Someone
  joining during the countdown still does. Lost players are still recovered.
- **The podium needs half the song**: a player seen in under half of the
  graded windows is left off.

## Photos and who is who (`game.js` `assign`)

When the song starts, whoever is in view becomes P1..P4, numbered left to
right as the dancers see themselves in the mirrored camera view, and each
gets a head-and-shoulders **photo** (`takePhoto`: from the full camera
frame, mirrored, 160×200 JPEG). The photo appears on their card, on the
podium, and in the replay. Someone who joins mid-song gets one when they
appear.

Each player also has a **clothes signature** (`signature`): the mean colour
of chest, belly and thighs from a 160 px copy of the frame. Chroma counts 4×
brightness, because chroma changes least as people move in the light. It is
learnt slowly (5% per frame) while they are tracked confidently. Matching
cost = distance + 0.5 × clothes difference, so two dancers who pass close
keep their own slots when they dress differently.

After that, each detection goes to the nearest player (nearest pairs first,
within 2.5× that player's torso length). A detection nobody claims goes to
the player who was lost most recently and nearest, in the most similar
clothes (time away counts as distance: 2 s away = half a frame-width; clothes count 1.5×). Only when every player is
accounted for does it become a new player, while there is room.
**Hard-won:** without that rule one dancer split into P1 and P2 whenever
they moved fast, and without the recency rule they swapped with a slot
that had been empty for seconds. The model also sometimes reports one person
twice. Two bodies whose middles are within half a torso are merged
(`detect`). Players keep their spot by staying on it: the
tape X advice in the setup screen. Tap a card to rename a player; names
are remembered on the device. Someone seen in under a quarter of the
graded windows does not appear in the results.

## The replay (`replay.js`)

While the song plays, a canvas is drawn ~30 times a second. The camera fills
it, mirrored. Cosmo's clip is small in the top right (27% of the width,
40% on a portrait camera). Name tags and grade pop-ups (the same
`drawTags` as on screen), the title and song, and a score strip with
photos along the bottom ride on top. Its stream plus the song's audio go
into a MediaRecorder: mp4 where the browser can (Safari), else webm, at
5 Mb/s. The audio is the song routed through Web Audio
(`createMediaElementSource`, connected to both the speakers and the
recording), set up in the first tap. At the end it draws 3.5 s of a results
card with photos, then stops.

The results screen shows "Making your replay…" and then **Watch the
replay**: a player with **Save video** (a download named
`cosmo-danceoff-SONG-DATE-TIME.mp4`) and, where the browser can share
files (phones), **Share**. Nothing leaves the device unless they share
it. `?noreplay=1` turns it off; it is also off where MediaRecorder or
canvas capture is missing. Recording costs some detection speed: about
25% fewer detections a second on the test machine's CPU.

## Cosmo's reference (`tools/reference.mjs SONG`)

MediaPipe's person detector is weak at crowds. On the whole stadium shot
it finds 0–3 of the ~20 people per frame and often misses the mascot. So
there are two passes, both with the **heavy** model (30 MB, offline only;
put `pose_heavy.task` in `tools/cache/`, otherwise it falls back to full;
each song's frames and detections are cached in `tools/cache/SONG/`):

1. **Whole frame**, up to 10 people each. For every person: how tan their
   shins, thighs, knees, ankles and forearms are, and (from the frames
   afterwards, `arms.json`) how tan their **upper arms** are near the elbow.
   Blonde hair is why the head is never sampled.
2. **Pick by tracks.** Everyone is linked across frames into short tracks
   (nearest within ~half a torso, no sudden growth, gaps up to 6 frames, and
   colours staying alike, so his track cannot continue as the Cougarette
   beside him). Each whole track is judged by its median colours. Cosmo's
   have tan legs **and** tan upper arms (both ≥ 0.2; his measure 0.24–0.99).
   The Cougarettes wear navy or white. In Center Court a dancer in khaki
   trousers is tan below the waist (arms ≤ 0.16), and another has bare arms
   but dark trousers (legs ≤ 0.10).
   **Hard-won:** following him frame by frame with legs-only colour put
   most of Center Court on the khaki dancer, and one frame where a stranger's
   arm read tan was enough to switch to them for good.
3. **Crops.** A square around where Cosmo is (interpolated across frames
   pass 1 lost him), each run on its own. He fills the crop, so he is found
   far more often and with sharper points. A crop result is used where pass
   1 has nothing (and then only with tan fur on a *seen* arm, or tan right in
   the middle of the crop), or to sharpen him where pass 1 has him. It is
   never used to swap him for someone beside him.
4. **Clean.** Frames whose middle is far from his path over the surrounding
   half second (the median of ±15 frames) are dropped. Gaps up to 8 frames
   are filled and the track is lightly smoothed (5-frame weighted average).

Results: the original 1355/1592 frames (85%), Cougarettes in White 1228/1380
(89%), Center Court 1560/1651 (94%). Everything is cached in
`tools/cache/SONG/` (not committed). `--pick` re-runs steps 2 and 4 in
seconds, `--pick --recrop` redoes the crops round a changed pick (~10 min),
and `--pick --first` stops after pass 1, for `tools/sheet.py SONG --first`.

**To check a new reference by eye:** `python3 tools/sheet.py SONG` draws the
track over 28 frames to `tools/cache/SONG/sheet.jpg`. The red skeleton must be
on Cosmo in every tile marked "ok". All three were checked that way. One
known slip: about 0.2 s at 11.3 s of the original is on the Cougarette next
to him, too short to matter in a 0.8 s window.

## URL options

`?song=ID`, `?model=lite|full`, `?cpu=1` (no GPU), `?dancers=N`, `?crops=1|always`, `?count=0`,
`?testcam=URL` (a video file as the camera, kept in step with the song),
`?testcamAt=SEC` (where it sits during setup), `?testcamLag=SEC` (keep it
that far behind the song: a slow copier), `?end=SEC` (stop early), `?noreplay=1`,
`?debug=1` (model and ms per detection in the camera corner; always shown
during setup).

## Checks

`node dancecheck.mjs --quick`: score.js against simulated dancers built
from Cosmo's own track, for every song; and the touchdown start against
made-up poses (straight arms, bent arms, a lost hand, one arm, only one of
two people, still celebrating, a flickering detection).

`node dancecheck.mjs`: also the real page in headless Chromium (CPU model,
first 20 s; `--verbose` prints every window's fit per dancer). The cameras
are Cosmo cropped (should score high; `tools/testcam.py` greys out
everything but a box round him, because Cougarettes in the shot are not
what a living room looks like), the same
flipped (a mirror copy), a frozen frame (should score low), and the whole
stadium shot (just must not break). Then Chromium's fake camera device
covers the real getUserMedia path. The Cosmo run is started by the
touchdown: the pretend camera shows him arms-down, the song must wait, then
it jumps to clip 4.1 s, where his arms are up, and the song must start
without a tap. That run and a "controls" run also record a replay and play
it back. The controls run pauses at 5 s (the song and the grading must
stand still), resumes, and ends at 9 s (results for what was danced).
Every podium line must have a photo. The other songs get short smoke runs.
A "late" run keeps the Cosmo camera 0.8 s behind the song. It must score
low at the default allowance, higher once the Timing panel widens Behind,
and lower again when it is narrowed, and the saved values must stick. A
"group" setup run (`tools/testcam-group.webm`: six Cougarettes from the start
of Cougarettes in White, enlarged to living-room size) must count at least 4
in view, follow more with crops than without (they still work when asked
for), and as shipped say how many it sees and to take turns. Every run checks
that nobody joined after the dancing started.
Screenshots: `tools/cache/playing.png`, `results.png`, `replay-cosmo.png`,
`replay-cosmo-end.png`.
Typical results: Cosmo camera 75–82%, mirrored 80–84%, frozen frame ~7%;
late dancer 37% → 74%; group followed 1 → 3 of 6 in view.
Simulated, per song (original / white / court): copy 98/100/99%, late copy
through shaky tracking 92/88/91%, standing still 2/0/0%, made-up moves
12/6/7%, wrong part of the song 6/5/4%.

## Not built / ideas

- The Portal TV and Fire Stick are untested. A Fire Stick has no camera.
- A "ghost Cosmo" stick figure over the camera view; a slower practice mode.
- Posting scores to a party-wide scoreboard (party-hub in GAMEDAY.md).
- Phone as a remote to start or restart from the couch.
- An "action shot" per player (their best PERFECT moment) next to the photo.
- Uploading replays somewhere shared (they stay on the device today).
- Tuning against real people. The thresholds are set from simulated noise and
  from the pose model watching Cosmo; real dancers in a living room may need
  OK/GOOD lowered a little. Change `GRADES` in `score.js` and re-run the check.
