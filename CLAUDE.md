# Cosmo Dance-Off

## Git workflow

Solo project, no collaborators — work directly on `main`. Commit and push
straight to `main`, no feature branches or PRs needed. Cloudflare Workers
deploys from `main` on every push, so anything on another branch is not
live, and a change has to work before it is committed.

## Start here

Read `HANDOFF.md` before making any non-trivial change — how the scoring
works, how Cosmo's reference pose was made, and the tuning numbers.

## The game lives in `web/`

`web/` is the only directory Cloudflare uploads. The tools, the checks and
the notes beside it stay in the repo and off the internet. Run the checks
from the repo root. Cloudflare refuses any single file over 25 MiB.

## Before shipping

```
node dancecheck.mjs --quick   # the scoring (every song) and the touchdown start, seconds
node dancecheck.mjs           # also the real page in Chromium with a video as the camera (~6 min)
node tools/reference.mjs SONG # re-make web/ref/SONG.json after changing that clip (slow: ~25 min)
node tools/reference.mjs SONG --pick   # re-pick Cosmo from the cached detections (seconds)
python3 tools/beats.py web/media/SONG.mp4 --from 2   # tempo and first beat for songs.json
```

Songs are listed in `web/songs.json`; HANDOFF.md says how to add one.

`web/score.js` decides every grade and draws nothing. Change a threshold
there and `dancecheck --quick` says whether copying Cosmo still scores high
and standing still still scores low.
