'use strict';
/* ===== Tuner (McLeod pitch method), tap tempo, latency calibration ===== */

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/** Returns frequency in Hz or 0. buf: Float32Array time-domain. */
function detectPitch(buf, sr) {
  const n = buf.length;
  let rms = 0; for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.008) return { freq: 0, clarity: 0, rms };
  const maxLag = Math.min(n >> 1, Math.floor(sr / 38));
  const W = Math.min(2048, n - maxLag);
  const nsdf = new Float32Array(maxLag);
  for (let tau = 0; tau < maxLag; tau++) {
    let acf = 0, m = 0;
    for (let i = 0; i < W; i++) { const a = buf[i], b = buf[i + tau]; acf += a * b; m += a * a + b * b; }
    nsdf[tau] = m > 0 ? 2 * acf / m : 0;
  }
  // key maxima: one per positive lobe, ignoring the lobe around lag 0
  const peaks = []; let tau = 1;
  while (tau < maxLag && nsdf[tau] > 0) tau++;          // leave the zero-lag lobe
  let pos = false, curIdx = 0;
  for (; tau < maxLag; tau++) {
    const v = nsdf[tau];
    if (!pos && v > 0) { pos = true; curIdx = tau; }
    else if (pos && v <= 0) { pos = false; peaks.push(curIdx); }
    else if (pos && v > nsdf[curIdx]) curIdx = tau;
  }
  if (pos) peaks.push(curIdx);
  if (!peaks.length) return { freq: 0, clarity: 0, rms };
  const best = Math.max(...peaks.map(i => nsdf[i]));
  const pick = peaks.find(i => nsdf[i] >= 0.9 * best);
  const a = nsdf[pick - 1] || 0, b = nsdf[pick], c = nsdf[pick + 1] || 0;
  const d = (a - 2 * b + c), shift = d ? 0.5 * (a - c) / d : 0;
  return { freq: sr / (pick + shift), clarity: b, rms };
}
function noteFromFreq(f, a4 = 440) {
  const midi = 69 + 12 * Math.log2(f / a4);
  const r = Math.round(midi);
  return { name: NOTE_NAMES[((r % 12) + 12) % 12], octave: Math.floor(r / 12) - 1, cents: (midi - r) * 100, midi: r };
}

class Tuner {
  constructor(engine) { this.engine = engine; this.running = false; this.smooth = null; this.hist = []; }
  async start(onReading) {
    await this.engine.ensureInput();
    const ctx = this.engine.ctx;
    this.an = ctx.createAnalyser(); this.an.fftSize = 4096;
    this.engine.inputSrc.connect(this.an);
    this.buf = new Float32Array(this.an.fftSize);
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.an.getFloatTimeDomainData(this.buf);
      const r = detectPitch(this.buf, ctx.sampleRate);
      if (r.freq && r.clarity > 0.85 && r.freq > 25 && r.freq < 1500) {
        this.hist.push(r.freq); if (this.hist.length > 5) this.hist.shift();
        const sorted = [...this.hist].sort((x, y) => x - y), med = sorted[sorted.length >> 1];
        onReading({ freq: med, ...noteFromFreq(med, this.a4 || 440), level: r.rms });
      } else { if (r.rms < 0.008) this.hist = []; onReading({ freq: 0, level: r.rms }); }
      this.raf = setTimeout(loop, 50);
    };
    loop();
  }
  stop() { this.running = false; clearTimeout(this.raf); if (this.an) { try { this.engine.inputSrc && this.engine.inputSrc.disconnect(this.an); } catch (_) { } this.an = null; } }
}

class TapTempo {
  constructor() { this.taps = []; }
  tap() {
    const now = performance.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(now); if (this.taps.length > 8) this.taps.shift();
    if (this.taps.length < 2) return null;
    const iv = this.taps.slice(1).map((t, i) => t - this.taps[i]);
    const avg = iv.reduce((a, b) => a + b, 0) / iv.length;
    return Math.round(clamp(60000 / avg, 30, 300));
  }
}

/** Round-trip latency calibration: plays 8 clicks, listens for them through the input.
 *  Returns measured latency in ms, or throws with a helpful message. */
async function calibrateLatency(engine) {
  await engine.ensureInput();
  if (engine.state !== 'stopped') await engine.stop();
  const ctx = engine.ctx, sr = ctx.sampleRate;
  const chunks = [];
  const prev = engine.capture.port.onmessage;
  let stoppedRes;
  engine.capture.port.onmessage = e => {
    const m = e.data;
    if (m.type === 'data') chunks.push(m);
    else if (m.type === 'stopped' && stoppedRes) stoppedRes();
    else prev(e);
  };
  const times = [];
  try {
    engine.capture.port.postMessage({ cmd: 'start' });
    const t0 = ctx.currentTime + 0.3;
    for (let i = 0; i < 8; i++) {
      const when = t0 + i * 0.5; times.push(when);
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 1000; o.type = 'square';
      g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(0.8, when + 0.0005); g.gain.exponentialRampToValueAtTime(0.001, when + 0.03);
      o.connect(g).connect(engine.clickBus); o.start(when); o.stop(when + 0.04);
    }
    await new Promise(r => setTimeout(r, (0.3 + 8 * 0.5 + 0.6) * 1000));
    await new Promise(r => { stoppedRes = r; engine.capture.port.postMessage({ cmd: 'stop' }); setTimeout(r, 1000); });
  } finally { engine.capture.port.onmessage = prev; }
  if (!chunks.length) throw new Error('No audio arrived from the input.');
  const base = chunks[0].frame, last = chunks[chunks.length - 1];
  const data = new Float32Array(last.frame + last.l.length - base);
  chunks.forEach(c => data.set(c.l, c.frame - base));
  let peak = 0; for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak < 0.02) throw new Error('The clicks were too quiet to hear. Turn the volume up, use the speaker or wired headphones held to the mic, and try again.');
  const thr = peak * 0.35, delays = [];
  for (const when of times) {
    const i0 = Math.round(when * sr) - base, i1 = Math.min(data.length, i0 + Math.round(0.6 * sr));
    for (let i = Math.max(0, i0); i < i1; i++) if (Math.abs(data[i]) > thr) { delays.push((i - i0) / sr); break; }
  }
  if (delays.length < 5) throw new Error('Only heard ' + delays.length + ' of 8 clicks. Try a quieter room and more volume.');
  delays.sort((a, b) => a - b);
  const med = delays[delays.length >> 1], spread = delays[delays.length - 1] - delays[0];
  if (spread > 0.02) throw new Error('The measurements were inconsistent (' + Math.round(spread * 1000) + ' ms spread). Try again in a quieter room.');
  return Math.round(med * 1000 * 10) / 10;
}
