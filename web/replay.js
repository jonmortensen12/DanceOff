// The replay: a video of the dancers, made while they dance. The camera
// fills the frame (mirrored, as they saw themselves), Cosmo's clip is a
// small picture in the corner, name tags and PERFECT/GOOD pop-ups ride
// along, the song is the soundtrack, and it ends on a results card.
//
// How: everything is drawn into a canvas ~30 times a second; the canvas's
// stream plus the song's audio (routed through Web Audio so it can be both
// heard and recorded) go into a MediaRecorder. Nothing leaves the device.

export function supported() {
  return typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream && !!pickType();
}

function pickType() {
  if (typeof MediaRecorder === 'undefined') return null;
  // mp4 first: it plays and shares everywhere (Safari records it natively)
  const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus', 'video/webm'];
  return types.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch (e) { return false; } }) || null;
}

// Route the song through Web Audio once, from inside a tap (browsers only
// start audio from one). After this the song plays through the
// AudioContext as before, and `stream` carries the same sound.
let audio = null;
export function unlockAudio(song) {
  if (audio) { audio.ctx.resume().catch(() => {}); return audio; }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaElementSource(song);
    const dest = ctx.createMediaStreamDestination();
    src.connect(ctx.destination); src.connect(dest);
    ctx.resume().catch(() => {});
    audio = { ctx, stream: dest.stream };
  } catch (e) { console.warn('no audio routing, the replay will be silent', e); audio = { ctx: { resume: async () => {} }, stream: null }; }
  return audio;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

export class Recorder {
  // cam, song: the <video> elements. drawTags(ctx, X, Y, scale): draws the
  // name tags and pop-ups, given functions from camera coords to canvas.
  constructor({ cam, song, songTitle, drawTags }) {
    this.cam = cam; this.song = song; this.songTitle = songTitle; this.drawTags = drawTags;
    const vw = cam.videoWidth || 1280, vh = cam.videoHeight || 720;
    const k = 1280 / Math.max(vw, vh);
    this.W = Math.round(vw * k / 2) * 2; this.H = Math.round(vh * k / 2) * 2;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.W; this.canvas.height = this.H;
    this.ctx = this.canvas.getContext('2d');
    this.type = pickType();
    this.chunks = [];
    this.last = 0;
    this.chips = [];
  }

  start() {
    const stream = this.canvas.captureStream(30);
    if (audio && audio.stream) audio.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    this.rec = new MediaRecorder(stream, { mimeType: this.type, videoBitsPerSecond: 5_000_000 });
    this.rec.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.draw(true);
    this.rec.start(1000);
  }
  pause() { if (this.rec && this.rec.state === 'recording') this.rec.pause(); }
  resume() { if (this.rec && this.rec.state === 'paused') this.rec.resume(); }

  // chips: [{name, color, pct, photo(Image)}] for the score strip
  setChips(chips) { this.chips = chips; }

  // Called every animation frame; draws at most ~30 times a second.
  draw(force) {
    const now = performance.now();
    if (!force && now - this.last < 30) return;
    this.last = now;
    const { ctx, W, H, cam, song } = this;
    ctx.fillStyle = '#001730'; ctx.fillRect(0, 0, W, H);
    // the dancers, full frame, mirrored
    if (cam.videoWidth) {
      ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1);
      ctx.drawImage(cam, 0, 0, W, H);
      ctx.restore();
    }
    const scale = Math.min(W, H) / 720;
    this.drawTags(ctx, x => (1 - x) * W, y => y * H, scale);
    // Cosmo, small, top right
    if (song.videoWidth) {
      const pw = Math.round((W > H ? 0.27 : 0.4) * W), ph = Math.round(pw * song.videoHeight / song.videoWidth);
      const m = Math.round(16 * scale), x = W - pw - m, y = m;
      ctx.save();
      roundRect(ctx, x, y, pw, ph, 12 * scale); ctx.clip();
      ctx.drawImage(song, x, y, pw, ph);
      ctx.restore();
      ctx.lineWidth = 3 * scale; ctx.strokeStyle = '#ffffff';
      roundRect(ctx, x, y, pw, ph, 12 * scale); ctx.stroke();
    }
    // title, top left
    ctx.font = `900 ${Math.round(22 * scale)}px system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#0009'; ctx.fillText('COSMO DANCE-OFF', 18 * scale, 18 * scale);
    ctx.fillStyle = '#ffffff'; ctx.fillText('COSMO DANCE-OFF', 16 * scale, 16 * scale);
    ctx.font = `700 ${Math.round(15 * scale)}px system-ui, sans-serif`; ctx.fillStyle = '#c8a273';
    ctx.fillText(this.songTitle, 16 * scale, 44 * scale);
    // the score strip along the bottom
    const chips = this.chips;
    if (chips.length) {
      const ch = 54 * scale, cw = Math.min(230 * scale, (W - 32 * scale) / chips.length - 8 * scale);
      chips.forEach((c, i) => {
        const x = 16 * scale + i * (cw + 8 * scale), y = H - ch - 14 * scale;
        ctx.fillStyle = '#001730cc'; roundRect(ctx, x, y, cw, ch, ch / 2); ctx.fill();
        ctx.fillStyle = c.color; roundRect(ctx, x, y, 6 * scale, ch, 3 * scale); ctx.fill();
        const r = ch / 2 - 5 * scale;
        if (c.photo && c.photo.complete) {
          ctx.save(); ctx.beginPath(); ctx.arc(x + ch / 2 + 4 * scale, y + ch / 2, r, 0, Math.PI * 2); ctx.clip();
          ctx.drawImage(c.photo, x + ch / 2 + 4 * scale - r, y + ch / 2 - r * 1.25, r * 2, r * 2.5); ctx.restore();
        }
        ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
        ctx.font = `900 ${Math.round(17 * scale)}px system-ui, sans-serif`; ctx.fillStyle = c.color;
        ctx.fillText(c.name, x + ch + 12 * scale, y + ch / 2, cw - ch - 70 * scale);
        ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.font = `900 ${Math.round(22 * scale)}px system-ui, sans-serif`;
        ctx.fillText(c.pct + '%', x + cw - 14 * scale, y + ch / 2);
      });
    }
  }

  // The results card for `ms`, then stop. rows: [{name, color, pct, title, photo}]
  async finish(rows, headline, ms = 3500) {
    if (!this.rec || this.rec.state === 'inactive') return null;
    this.resume();
    const t0 = performance.now();
    await new Promise(done => {
      const step = () => {
        this.drawCard(rows, headline, (performance.now() - t0) / 400);
        if (performance.now() - t0 < ms) requestAnimationFrame(step); else done();
      };
      step();
      // a hidden tab stops animation frames; keep the card going anyway
      const iv = setInterval(() => { if (performance.now() - t0 >= ms) { clearInterval(iv); done(); } else this.drawCard(rows, headline, 1); }, 100);
    });
    const stopped = new Promise(r => { this.rec.onstop = r; });
    this.rec.stop();
    await stopped;
    const blob = new Blob(this.chunks, { type: this.type.split(';')[0] });
    return { blob, type: blob.type, ext: blob.type.includes('mp4') ? 'mp4' : 'webm' };
  }

  drawCard(rows, headline, k) {
    const { ctx, W, H } = this;
    const scale = Math.min(W, H) / 720;
    ctx.fillStyle = '#001730'; ctx.fillRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W / 2, H * 1.2, 10, W / 2, H * 1.2, H * 1.3);
    g.addColorStop(0, '#0a4d8c'); g.addColorStop(1, '#001730');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#c8a273'; ctx.font = `800 ${Math.round(20 * scale)}px system-ui, sans-serif`;
    ctx.fillText('FINAL WHISTLE · ' + this.songTitle.toUpperCase(), W / 2, H * 0.14);
    ctx.fillStyle = '#fff'; ctx.font = `900 ${Math.round(68 * scale)}px system-ui, sans-serif`;
    ctx.fillText(headline.toUpperCase(), W / 2, H * 0.14 + 76 * scale);
    const rh = Math.min(96 * scale, (H * 0.62) / Math.max(1, rows.length)), rw = Math.min(W * 0.8, 760 * scale);
    rows.forEach((r, i) => {
      const a = Math.max(0, Math.min(1, k - i * 0.6));
      ctx.globalAlpha = a;
      const x = (W - rw) / 2, y = H * 0.32 + i * (rh + 10 * scale) + (1 - a) * 20;
      ctx.fillStyle = '#ffffff1c'; roundRect(ctx, x, y, rw, rh, 16 * scale); ctx.fill();
      ctx.fillStyle = r.color; roundRect(ctx, x, y, 7 * scale, rh, 3 * scale); ctx.fill();
      const ph = rh - 14 * scale;
      if (r.photo && r.photo.complete) {
        ctx.save(); roundRect(ctx, x + 18 * scale, y + 7 * scale, ph * 0.8, ph, 10 * scale); ctx.clip();
        ctx.drawImage(r.photo, x + 18 * scale, y + 7 * scale, ph * 0.8, ph); ctx.restore();
      }
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const tx = x + 30 * scale + ph * 0.8;
      ctx.fillStyle = r.color; ctx.font = `900 ${Math.round(28 * scale)}px system-ui, sans-serif`;
      ctx.fillText(`${i + 1}. ${r.name}`, tx, y + rh * 0.38);
      ctx.fillStyle = '#d6e4f3'; ctx.font = `700 ${Math.round(18 * scale)}px system-ui, sans-serif`;
      ctx.fillText(r.title, tx, y + rh * 0.72);
      ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.font = `900 ${Math.round(40 * scale)}px system-ui, sans-serif`;
      ctx.fillText(r.pct + '%', x + rw - 20 * scale, y + rh / 2);
      ctx.globalAlpha = 1;
    });
  }
}
