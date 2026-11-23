'use strict';
/* ===== Built-in sounds: drum kit, metronome clicks, reverb impulses.
 * All functions take any BaseAudioContext so realtime playback and offline export are identical. */

const Synth = (() => {
  const noiseCache = new WeakMap();
  function noise(ctx) {
    let b = noiseCache.get(ctx);
    if (!b) {
      const rnd = mulberry32(1234);
      b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;
      noiseCache.set(ctx, b);
    }
    return b;
  }
  function env(ctx, g, when, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
  }
  function noiseHit(ctx, dest, when, vel, type, freq, q, decay, attack = 0.001, offset = 0) {
    const s = ctx.createBufferSource(); s.buffer = noise(ctx);
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); env(ctx, g, when, vel, attack, decay);
    s.connect(f).connect(g).connect(dest);
    s.start(when, offset % 0.9, attack + decay + 0.02);
    return s;
  }
  function toneHit(ctx, dest, when, vel, wave, f0, f1, sweep, decay) {
    const o = ctx.createOscillator(); o.type = wave;
    o.frequency.setValueAtTime(f0, when);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, when + sweep);
    const g = ctx.createGain(); env(ctx, g, when, vel, 0.002, decay);
    o.connect(g).connect(dest); o.start(when); o.stop(when + decay + 0.05);
    return o;
  }
  /** returns array of source nodes (so the caller can cancel them) */
  function drum(ctx, dest, inst, when, vel = 1) {
    switch (inst) {
      case 'K': return [toneHit(ctx, dest, when, 1.0 * vel, 'sine', 150, 42, 0.11, 0.42), noiseHit(ctx, dest, when, 0.25 * vel, 'lowpass', 3000, 0.7, 0.012)];
      case 'S': return [toneHit(ctx, dest, when, 0.45 * vel, 'triangle', 210, 160, 0.05, 0.11), noiseHit(ctx, dest, when, 0.55 * vel, 'highpass', 1200, 0.8, 0.19, 0.001, 0.11)];
      case 'R': return [toneHit(ctx, dest, when, 0.35 * vel, 'square', 820, 780, 0.01, 0.035), noiseHit(ctx, dest, when, 0.25 * vel, 'bandpass', 2500, 3, 0.03, 0.001, 0.3)];
      case 'H': return [noiseHit(ctx, dest, when, 0.28 * vel, 'highpass', 7500, 0.9, 0.045, 0.001, 0.45)];
      case 'O': return [noiseHit(ctx, dest, when, 0.24 * vel, 'highpass', 7000, 0.9, 0.28, 0.001, 0.6)];
      case 'C': return [noiseHit(ctx, dest, when, 0.18 * vel, 'bandpass', 6000, 1.4, 0.07, 0.012, 0.75)]; // shaker
      default: return [];
    }
  }
  function click(ctx, dest, when, accent, sound, vol) {
    const v = vol * (accent ? 1 : 0.6);
    if (sound === 'beep') return [toneHit(ctx, dest, when, v * 0.5, 'sine', accent ? 1600 : 1000, accent ? 1600 : 1000, 0.01, 0.07)];
    if (sound === 'tick') return [noiseHit(ctx, dest, when, v * 0.9, 'highpass', accent ? 2500 : 4000, 0.7, 0.02)];
    return [toneHit(ctx, dest, when, v * 0.7, 'sine', accent ? 2200 : 1550, accent ? 1900 : 1300, 0.02, 0.035), noiseHit(ctx, dest, when, v * 0.3, 'bandpass', accent ? 3000 : 2200, 4, 0.02)];
  }

  /* ---- patterns: 4/4 grids. sub = steps per beat (4 straight, 3 triplet/shuffle) ---- */
  const PATTERNS = {
    rock: { name: 'Straight rock', sub: 4, K: 'x.......x.x.....', S: '....x.......x...', H: 'x.x.x.x.x.x.x.x.' },
    pop: { name: 'Basic pop', sub: 4, K: 'x.....x.x.......', S: '....x.......x...', H: 'x.x.x.x.x.x.x.x.', O: '..............x.' },
    ballad: { name: 'Slow ballad', sub: 4, K: 'x.......x.....x.', R: '....x.......x...', H: 'x...x...x...x...' },
    shuffle: { name: 'Shuffle', sub: 3, K: 'x.....x.....', S: '...x.....x..', H: 'x.xx.xx.xx.x' },
    blues: { name: 'Blues (12/8 feel)', sub: 3, K: 'x.....x..x..', S: '...x.....x..', H: 'xxxxxxxxxxxx' },
    eighths: { name: 'Straight eighths', sub: 4, K: 'x.x.....x.x.....', S: '....x.......x...', H: 'x.x.x.x.x.x.x.x.' },
    four: { name: 'Four-on-the-floor', sub: 4, K: 'x...x...x...x...', S: '....x.......x...', H: '..x...x...x...x.', O: '' },
    acoustic: { name: 'Acoustic groove', sub: 4, K: 'x.......x.x.....', R: '....x.......x...', C: 'xxxxxxxxxxxxxxxx' },
  };
  const INSTS = ['K', 'S', 'R', 'H', 'O', 'C'];
  /** Hits in one bar: [{pos (beats from bar start), inst, vel}] — adapts the 4/4 template to other meters. */
  function barHits(patKey, num, den) {
    const pat = PATTERNS[patKey] || PATTERNS.rock, hits = [];
    const compound = den === 8 && num % 3 === 0 && num >= 6;
    if (compound) {
      // beat = eighth note; groups of three. Kick on group 1 (& 3), snare/rim on group 2 (& 4).
      const groups = num / 3, back = pat.R && !pat.S ? 'R' : 'S';
      for (let e = 0; e < num; e++) {
        const gi = Math.floor(e / 3), first = e % 3 === 0;
        hits.push({ pos: e, inst: pat.C ? 'C' : 'H', vel: first ? 1 : 0.6 });
        if (first && gi % 2 === 0) hits.push({ pos: e, inst: 'K', vel: 1 });
        if (first && gi % 2 === 1) hits.push({ pos: e, inst: back, vel: 1 });
      }
      if (groups === 1) hits.push({ pos: 0, inst: 'K', vel: 1 });
      return hits;
    }
    // simple meter: map each beat to one of the 4 template beats
    const map = num === 3 ? [0, 1, 3] : num === 2 ? [0, 1] : Array.from({ length: num }, (_, i) => i < 4 ? i : 2 + ((i - 4) % 2));
    const sub = pat.sub;
    map.forEach((tb, beat) => {
      for (let s = 0; s < sub; s++) {
        const step = tb * sub + s;
        for (const inst of INSTS) {
          const line = pat[inst]; if (!line || line[step] !== 'x') continue;
          const accent = s === 0 ? 1 : 0.7;
          hits.push({ pos: beat + s / sub, inst, vel: (inst === 'H' || inst === 'C') ? accent : 1 });
        }
      }
    });
    return hits;
  }

  /** Stereo reverb impulse (deterministic). */
  function impulse(ctx, size) {
    const cfg = { room: [0.9, 2.6, 0.004], plate: [1.7, 3.2, 0.0], hall: [2.8, 2.2, 0.015] }[size] || [0.9, 2.6, 0.004];
    const [len, decayPow, pre] = cfg, sr = ctx.sampleRate, n = Math.floor(sr * (len + pre));
    const b = ctx.createBuffer(2, n, sr), rnd = mulberry32(size === 'hall' ? 99 : size === 'plate' ? 77 : 55);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c); let lp = 0;
      const damp = size === 'plate' ? 0.15 : 0.45;
      for (let i = Math.floor(pre * sr); i < n; i++) {
        const t = (i / sr - pre) / len;
        const w = rnd() * 2 - 1; lp = lp + (1 - damp) * (w - lp);
        d[i] = lp * Math.pow(1 - t, decayPow) * 0.5;
      }
    }
    return b;
  }

  return { drum, click, barHits, impulse, PATTERNS };
})();
