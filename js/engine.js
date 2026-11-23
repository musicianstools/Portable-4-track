'use strict';
/* ===== Audio engine =====
 * One AudioContext. Capture via AudioWorklet (raw float PCM stamped with currentFrame).
 * Playback via AudioBufferSourceNode scheduled on the same clock. See docs/ARCHITECTURE.md. */

const WORKLET_SRC = `
class P4Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = false; this.size = 4096;
    this.l = new Float32Array(this.size); this.r = new Float32Array(this.size);
    this.n = 0; this.frame0 = 0; this.stereo = false;
    this.peak = 0; this.clip = false; this.mc = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.cmd === 'start') { this.flush(); this.cap = true; this.n = 0; this.port.postMessage({ type: 'started', frame: currentFrame }); }
      else if (m.cmd === 'stop') { this.flush(); this.cap = false; this.port.postMessage({ type: 'stopped', frame: currentFrame }); }
    };
  }
  flush() {
    if (!this.n) return;
    const l = this.l.slice(0, this.n), r = this.stereo ? this.r.slice(0, this.n) : null;
    this.port.postMessage({ type: 'data', frame: this.frame0, l, r }, r ? [l.buffer, r.buffer] : [l.buffer]);
    this.n = 0;
  }
  process(inputs) {
    const inp = inputs[0] || [], L = inp[0], R = inp[1];
    const len = L ? L.length : 128;
    if (L) {
      for (let i = 0; i < len; i++) { let a = L[i]; if (a < 0) a = -a; if (a > this.peak) this.peak = a; if (R) { let b = R[i]; if (b < 0) b = -b; if (b > this.peak) this.peak = b; } }
      if (this.peak >= 0.989) this.clip = true;
    }
    if (this.cap) {
      if (this.n === 0) { this.frame0 = currentFrame; this.stereo = !!R; }
      if (!!R !== this.stereo) { this.flush(); this.frame0 = currentFrame; this.stereo = !!R; }
      if (L) { this.l.set(L, this.n); if (R) this.r.set(R, this.n); }
      else { this.l.fill(0, this.n, this.n + len); if (this.stereo) this.r.fill(0, this.n, this.n + len); }
      this.n += len;
      if (this.n + 128 > this.size) this.flush();
    }
    if ((this.mc += len) >= 1024) {
      this.port.postMessage({ type: 'meter', peak: this.peak, clip: this.clip, live: !!L });
      this.mc = 0; this.peak = 0; this.clip = false;
    }
    return true;
  }
}
registerProcessor('p4-capture', P4Capture);
`;

const TICKER_SRC = `let t=null;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data);};`;

/** Build one channel strip: input → lowcut → 3-band EQ → compressor → makeup → fader → pan → out (+ reverb send) */
function buildStrip(ctx, out, reverbIn) {
  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = 0.707;
  const lo = ctx.createBiquadFilter(); lo.type = 'lowshelf'; lo.frequency.value = 200;
  const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.8;
  const hi = ctx.createBiquadFilter(); hi.type = 'highshelf'; hi.frequency.value = 4500;
  const comp = ctx.createDynamicsCompressor(); comp.knee.value = 6; comp.attack.value = 0.006; comp.release.value = 0.16;
  const makeup = ctx.createGain();
  const fader = ctx.createGain();
  const pan = ctx.createStereoPanner();
  const send = ctx.createGain();
  input.connect(hp).connect(lo).connect(mid).connect(hi).connect(comp).connect(makeup).connect(fader).connect(pan).connect(out);
  pan.connect(send).connect(reverbIn);
  function update(t, audible, at = ctx.currentTime, ramp = 0.02) {
    const set = (param, v) => { if (ramp > 0) param.setTargetAtTime(v, at, ramp); else param.setValueAtTime(v, at); };
    set(hp.frequency, t.fx.lowcut ? 90 : 10);
    set(lo.gain, t.fx.low); set(mid.gain, t.fx.mid); set(hi.gain, t.fx.high);
    const a = t.fx.comp; // 0..1
    comp.threshold.setValueAtTime(a > 0 ? -6 - a * 30 : 0, at);
    comp.ratio.setValueAtTime(a > 0 ? 1.5 + a * 6.5 : 1, at);
    set(makeup.gain, a > 0 ? Math.pow(10, (a * 30 * (1 - 1 / (1.5 + a * 6.5)) * 0.45) / 20) : 1);
    set(fader.gain, audible ? t.vol * t.vol * 1.25 : 0); // squared taper
    set(pan.pan, t.pan);
    set(send.gain, t.fx.reverb * 0.9);
  }
  return { input, update, nodes: [input, hp, lo, mid, hi, comp, makeup, fader, pan, send] };
}

class Engine {
  constructor() {
    this.ctx = null; this.project = null;
    this.buffers = new Map();          // audioId → AudioBuffer
    this.state = 'stopped';            // stopped | playing | recording
    this.passes = []; this.live = [];  // scheduled nodes {src, g, end}
    this.listeners = {};
    this.stream = null; this.inputSrc = null; this.capture = null; this.testInput = null;
    this.rec = null;
    this.settings = { inputDevice: '', outputDevice: '', latencyMode: 'auto', latencyMs: 0, monitor: false, monitorGain: 0.8 };
    this.meter = { peak: 0, clip: false, clipHold: 0, live: false };
  }
  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  emit(ev, ...a) { (this.listeners[ev] || []).forEach(f => { try { f(...a); } catch (e) { console.error(e); } }); }

  /* ---------- setup ---------- */
  async init() {
    if (this.ctx) { if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch (_) { } } return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('This browser does not support the Web Audio API.');
    this.ctx = new AC({ latencyHint: 'interactive' });
    if (!this.ctx.audioWorklet) throw new Error('This browser lacks AudioWorklet, which is required for reliable recording. Please update your browser.');
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const c = this.ctx;
    this.master = c.createGain(); this.mixBus = c.createGain();
    this.analyser = c.createAnalyser(); this.analyser.fftSize = 1024;
    this.reverbIn = c.createGain(); this.convolver = c.createConvolver(); this.reverbSize = null;
    this.reverbIn.connect(this.convolver).connect(this.mixBus);
    this.mixBus.connect(this.master).connect(this.analyser).connect(c.destination);
    this.drumBus = c.createGain(); this.drumBus.connect(this.mixBus);
    this.clickBus = c.createGain(); this.clickBus.connect(c.destination);
    this.strips = [0, 1, 2, 3].map(() => buildStrip(c, this.mixBus, this.reverbIn));
    this.monitorGain = c.createGain(); this.monitorGain.gain.value = 0;
    this.sink = c.createGain(); this.sink.gain.value = 0; this.sink.connect(c.destination);
    this.capture = new AudioWorkletNode(c, 'p4-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCountMode: 'max', channelCount: 2, channelInterpretation: 'speakers' });
    this.capture.connect(this.sink);
    this.capture.port.onmessage = e => this._onCapture(e.data);
    this.ticker = new Worker(URL.createObjectURL(new Blob([TICKER_SRC], { type: 'application/javascript' })));
    this.ticker.onmessage = () => this._tick();
    c.onstatechange = () => {
      this.emit('ctxstate', c.state);
      if (c.state !== 'running' && this.state === 'recording') {
        this.emit('error', 'Audio was interrupted (another app or a call took over). Your recording up to this point has been kept.');
        this.autoStop();
      }
    };
    this.procDelay = await measureStripDelay(c.sampleRate);
    if (this.project) this.updateMix(0);
    if (this.settings.outputDevice) this.setOutputDevice(this.settings.outputDevice).catch(() => { });
    if (c.state !== 'running') { try { await c.resume(); } catch (_) { } }
  }
  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

  setProject(p) { this.project = p; if (this.ctx) this.updateMix(0); }

  async loadBuffer(audioId) {
    if (this.buffers.has(audioId)) return this.buffers.get(audioId);
    const rec = await Store.getAudio(audioId);
    if (!rec) return null;
    const data = new Float32Array(rec.data);
    const b = new AudioBuffer({ length: Math.max(1, data.length), sampleRate: rec.sr, numberOfChannels: 1 });
    b.copyToChannel(data, 0);
    b._peaks = rec.peaks ? new Float32Array(rec.peaks) : computePeaks(data, PEAK_BLOCK);
    this.buffers.set(audioId, b);
    return b;
  }
  async loadProjectAudio(p) {
    const missing = [];
    for (const id of referencedAudio(p)) { if (!(await this.loadBuffer(id))) missing.push(id); }
    return missing;
  }
  /** register freshly recorded/imported mono audio (already stored) */
  addBuffer(audioId, data, sr, peaks) {
    const b = new AudioBuffer({ length: Math.max(1, data.length), sampleRate: sr, numberOfChannels: 1 });
    b.copyToChannel(data, 0); b._peaks = peaks || computePeaks(data, PEAK_BLOCK);
    this.buffers.set(audioId, b); return b;
  }

  /* ---------- input ---------- */
  inputLatency() {
    if (this.testInput) return 0;
    if (this.settings.latencyMode === 'manual') return this.settings.latencyMs / 1000;
    const c = this.ctx; let l = (c.baseLatency || 0) + (c.outputLatency || 0);
    const tr = this.stream && this.stream.getAudioTracks()[0];
    const s = tr && tr.getSettings ? tr.getSettings() : {};
    if (typeof s.latency === 'number') l += s.latency;
    return l;
  }
  async ensureInput() {
    await this.init();
    if (this.testInput) return;
    if (this.stream && this.stream.getAudioTracks().some(t => t.readyState === 'live')) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(window.isSecureContext ? 'This browser cannot access a microphone.' : 'Microphone access needs a secure page. Open the app over https:// or from localhost.');
    }
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } };
    if (this.settings.inputDevice) audio.deviceId = { exact: this.settings.inputDevice };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
    catch (e) {
      if (e.name === 'OverconstrainedError' && this.settings.inputDevice) { delete audio.deviceId; stream = await navigator.mediaDevices.getUserMedia({ audio }); this.emit('error', 'The selected input is unavailable; using the default microphone.'); }
      else if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw new Error('Microphone permission was denied. Allow microphone access for this site in your browser settings, then try again.');
      else if (e.name === 'NotFoundError') throw new Error('No microphone or audio input was found. Connect one and try again.');
      else throw new Error('Could not open the audio input: ' + (e.message || e.name));
    }
    this._attachStream(stream);
  }
  _attachStream(stream) {
    if (this.inputSrc) { try { this.inputSrc.disconnect(); } catch (_) { } }
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = stream;
    this.inputSrc = this.ctx.createMediaStreamSource(stream);
    this.inputSrc.connect(this.capture);
    this.inputSrc.connect(this.monitorGain);
    stream.getAudioTracks().forEach(t => t.addEventListener('ended', () => {
      if (this.stream !== stream) return;
      this.stream = null;
      if (this.state === 'recording') { this.emit('error', 'The audio input was disconnected. Recording stopped — everything captured so far has been kept.'); this.autoStop(); }
      else this.emit('error', 'The audio input was disconnected.');
      this.emit('input', null);
    }));
    this._routeMonitor();
    this.emit('input', stream.getAudioTracks()[0]?.label || 'Input');
  }
  async reopenInput() { if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; } await this.ensureInput(); }
  closeInput() { if (this.stream) this.stream.getTracks().forEach(t => t.stop()); this.stream = null; if (this.inputSrc) try { this.inputSrc.disconnect(); } catch (_) { } this.inputSrc = null; this.emit('input', null); }
  /** test hook: route an internal node into the recorder (zero latency loopback) */
  setTestInput(node) { this.testInput = node; node.connect(this.capture); }
  _routeMonitor() {
    if (!this.ctx) return;
    try { this.monitorGain.disconnect(); } catch (_) { }
    const p = this.project; if (!p) return;
    const armed = p.tracks.findIndex(t => t.arm);
    if (armed >= 0) this.monitorGain.connect(this.strips[armed].input);
    this.monitorGain.gain.setTargetAtTime(this.settings.monitor ? this.settings.monitorGain : 0, this.ctx.currentTime, 0.02);
  }
  async listDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return { inputs: [], outputs: [] };
    const d = await navigator.mediaDevices.enumerateDevices();
    return { inputs: d.filter(x => x.kind === 'audioinput'), outputs: d.filter(x => x.kind === 'audiooutput') };
  }
  canSelectOutput() { return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype; }
  async setOutputDevice(id) { this.settings.outputDevice = id; if (this.ctx && this.ctx.setSinkId) await this.ctx.setSinkId(id || ''); }

  _onCapture(m) {
    if (m.type === 'meter') {
      this.meter.peak = m.peak; this.meter.live = m.live;
      if (m.clip) this.meter.clipHold = performance.now() + 1500;
      this.meter.clip = performance.now() < this.meter.clipHold;
      if (m.clip && this.rec) this.rec.clipped = true;
      return;
    }
    const r = this.rec;
    if (m.type === 'data' && r) { r.chunks.push({ frame: m.frame, l: m.l, r: m.r }); r.capturedFrames += m.l.length; r.liveDirty = true; }
    else if (m.type === 'stopped' && r && r.onStopped) r.onStopped(m.frame);
  }

  /* ---------- mix ---------- */
  updateMix(ramp = 0.02) {
    if (!this.ctx || !this.project) return;
    const p = this.project, anySolo = p.tracks.some(t => t.solo), at = this.ctx.currentTime;
    p.tracks.forEach((t, i) => this.strips[i].update(t, !t.mute && (!anySolo || t.solo), at, ramp));
    this.master.gain.setTargetAtTime(p.master.vol, at, 0.02);
    this.drumBus.gain.setTargetAtTime(p.drums.vol, at, 0.02);
    if (this.reverbSize !== p.master.reverbSize) { this.convolver.buffer = Synth.impulse(this.ctx, p.master.reverbSize); this.reverbSize = p.master.reverbSize; }
    this._routeMonitor();
  }
  setMonitor(on) { this.settings.monitor = on; this._routeMonitor(); }

  /* ---------- transport ---------- */
  isRunning() { return this.state !== 'stopped'; }
  /** timeline position (seconds) right now */
  position() {
    if (this.state === 'stopped' || !this.passes.length) return this.project ? this.project.position : 0;
    const t = this.ctx.currentTime;
    let ps = this.passes[0];
    for (const p of this.passes) { if (p.ctxStart <= t) ps = p; else break; }
    return ps.tlStart + (t - ps.ctxStart);
  }
  _loopActive() { const l = this.project.loop; return l.on && l.end - l.start >= 0.25; }

  async play(from) {
    await this.init();
    if (this.state !== 'stopped') return;
    const p = this.project;
    const missing = await this.loadProjectAudio(p);
    if (missing.length) this.emit('error', `${missing.length} recording(s) could not be loaded from storage.`);
    let pos = from != null ? from : p.position;
    if (this._loopActive() && (pos < p.loop.start || pos >= p.loop.end)) pos = p.loop.start;
    this.playStart = pos;
    this._startTransport(pos, { countInEnd: -Infinity });
    this.state = 'playing'; this.emit('state', this.state);
  }

  _startTransport(tlStart, opts) {
    const c = this.ctx, startAt = c.currentTime + 0.08;
    this.countInEnd = opts.countInEnd;
    this.passes = [];
    this._addPass(startAt, tlStart);
    this.gridUntil = startAt;
    this.ticker.postMessage(25);
    this._tick();
  }
  _addPass(ctxStart, tlStart) {
    const loop = this._loopActive() ? this.project.loop : null;
    const tlEnd = loop && tlStart < loop.end ? loop.end : Infinity;
    const pass = { ctxStart, tlStart, tlEnd, ctxEnd: ctxStart + (tlEnd - tlStart) };
    this.passes.push(pass);
    this._schedulePass(pass, ctxStart);
    if (this.rec) this.rec.passesDirty = true;
    return pass;
  }
  _tick() {
    if (this.state === 'stopped' || !this.passes.length) return;
    const now = this.ctx.currentTime;
    // extend loop passes ahead of time
    let last = this.passes[this.passes.length - 1];
    let guard = 0;
    while (isFinite(last.ctxEnd) && last.ctxEnd < now + 1.5 && guard++ < 64) {
      if (!this._loopActive()) break;
      last = this._addPass(last.ctxEnd, this.project.loop.start);
    }
    // metronome + drums
    const until = now + 0.18;
    if (until > this.gridUntil) { this._scheduleGrid(this.gridUntil, until); this.gridUntil = until; }
    // prune finished nodes
    if (this.live.length > 64) this.live = this.live.filter(n => n.end > now - 0.5);
    // trim passes list when not recording (recording needs them all)
    if (!this.rec && this.passes.length > 4) this.passes = this.passes.filter(pp => pp.ctxEnd > now - 1 || pp === last);
  }

  _schedulePass(pass, fromCtx) {
    const p = this.project, c = this.ctx;
    const D = this.procDelay || 0;
    pass = { ...pass, ctxStart: pass.ctxStart - D, ctxEnd: pass.ctxEnd - D };
    for (let tr = 0; tr < 4; tr++) {
      for (const seg of trackSegments(p, tr)) {
        const take = activeTake(seg.clip), buf = this.buffers.get(take.audioId);
        if (!buf) continue;
        this._scheduleSegment(c, this.strips[tr].input, buf, take.srcStart, seg.from, seg.to, pass, fromCtx, this.live);
      }
    }
  }
  /** Schedule audio [from,to) of a take within a pass, with ~4 ms crossfade ramps straddling each boundary. */
  _scheduleSegment(c, dest, buf, srcStart, from, to, pass, fromCtx, live) {
    const aEnd = srcStart + buf.duration;
    let a = Math.max(from, srcStart, pass.tlStart), b = Math.min(to, aEnd, pass.tlEnd);
    if (b - a < 0.002) return;
    const f = Math.min(0.004, (b - a) / 4);
    // play slightly beyond each boundary (if audio exists) so adjacent segments crossfade instead of dipping
    const ps = Math.max(a - f, srcStart), pe = Math.min(b + f, aEnd);
    const toCtx = t => pass.ctxStart + (t - pass.tlStart);
    let when = toCtx(ps), off = ps - srcStart, dur = pe - ps;
    if (when + dur <= fromCtx) return;
    if (when < fromCtx) { const d = fromCtx - when; when += d; off += d; dur -= d; }
    const src = c.createBufferSource(); src.buffer = buf;
    const g = c.createGain();
    const inA = toCtx(a), outB = toCtx(b);
    g.gain.setValueAtTime(0, when);
    if (inA + f > when) g.gain.linearRampToValueAtTime(1, Math.max(when + 0.001, inA + f)); else g.gain.setValueAtTime(1, when);
    if (outB - f > when) g.gain.setValueAtTime(1, outB - f);
    g.gain.linearRampToValueAtTime(0, Math.max(when + 0.002, toCtx(pe)));
    src.connect(g).connect(dest);
    src.start(when, off, dur);
    live.push({ src, g, end: when + dur });
  }

  _scheduleGrid(ca, cb, ctxOverride) {
    const p = this.project, c = ctxOverride || this.ctx;
    const wantClick = p.click.on && (this.state === 'recording' || p.click.duringPlay);
    const wantDrums = p.drums.on;
    const ciEnd = this.countInEnd;
    if (!wantClick && !wantDrums && !(ciEnd > -Infinity)) return;
    for (const pass of this.passes) {
      const a = Math.max(ca, pass.ctxStart), b = Math.min(cb, pass.ctxEnd);
      if (b <= a) continue;
      const tlA = pass.tlStart + (a - pass.ctxStart), tlB = pass.tlStart + (b - pass.ctxStart);
      for (const ev of gridEvents(p, tlA, tlB, wantClick, wantDrums, ciEnd)) {
        const when = pass.ctxStart + (ev.t - pass.tlStart);
        const nodes = ev.click
          ? Synth.click(c, this.clickBus, when, ev.accent, p.click.sound, p.click.vol)
          : Synth.drum(c, this.drumBus, ev.inst, when, ev.vel);
        nodes.forEach(n => this.live.push({ src: n, g: null, end: when + 0.5 }));
        if (ev.click && ev.t < ciEnd) this.emit('countin', { when, beatsLeft: Math.round((ciEnd - ev.t) / beatDur(p)) });
      }
    }
  }

  _silenceLive(at) {
    for (const n of this.live) {
      try {
        if (n.g) { n.g.gain.cancelScheduledValues(at); n.g.gain.setTargetAtTime(0, at, 0.0015); n.src.stop(at + 0.012); }
        else n.src.stop(at);
      } catch (_) { }
    }
    this.live = [];
  }
  /** Clip edits during playback: re-schedule from "now" (keeps the timeline mapping). */
  refresh() {
    if (this.state === 'stopped') return;
    const at = this.ctx.currentTime + 0.03;
    const old = this.live; this.live = [];
    for (const n of old) {
      if (!n.g) { this.live.push(n); continue; } // keep metronome/drum hits
      try { n.g.gain.cancelScheduledValues(at); n.g.gain.setTargetAtTime(0, at, 0.0015); n.src.stop(at + 0.012); } catch (_) { }
    }
    for (const pass of this.passes) if (pass.ctxEnd > at) this._schedulePass(pass, at);
  }
  /** Loop / tempo change during playback: start a fresh pass from the current position. */
  retime() {
    if (this.state === 'stopped') return;
    const at = this.ctx.currentTime + 0.04;
    let pos = this.position() + 0.04;
    const loop = this._loopActive() ? this.project.loop : null;
    if (loop && (pos >= loop.end || pos < loop.start) && this.state !== 'recording') pos = loop.start;
    this._silenceLive(at);
    const lastIdx = this.passes.length - 1;
    if (lastIdx >= 0) { const lp = this.passes[lastIdx]; if (lp.ctxStart <= at) { lp.tlEnd = lp.tlStart + (at - lp.ctxStart); lp.ctxEnd = at; } }
    this.passes = this.passes.filter(pp => pp.ctxStart < at);
    if (this.rec) this.rec.passes = this.passes;
    this._addPass(at, pos);
    this.gridUntil = at;
  }

  /** Stop initiated by the engine itself (device lost, interruption): the app receives the take via 'autostop'. */
  async autoStop() {
    if (this.state === 'stopped') return;
    const pos = this.position(), start = this.playStart;
    const res = await this.stop();
    this.emit('autostop', { res, pos, start });
  }
  async stop() {
    if (this.state === 'stopped') return null;
    const now = this.ctx.currentTime;
    const pos = this.position();
    this.ticker.postMessage(0);
    let result = null;
    if (this.state === 'recording') result = await this._finishRecording(now);
    this._silenceLive(this.ctx.currentTime);
    this.passes = [];
    this.state = 'stopped';
    this.lastStopPos = pos;
    this.emit('state', this.state);
    return result;
  }

  /* ---------- recording ---------- */
  async record(from) {
    const p = this.project;
    const armed = p.tracks.map((t, i) => t.arm ? i : -1).filter(i => i >= 0);
    if (!armed.length) throw new Error('Arm a track first (tap R on a track).');
    await this.ensureInput();
    if (this.state === 'recording') return null;
    if (this.state === 'playing') return this._punchIn(armed);
    const missing = await this.loadProjectAudio(p);
    if (missing.length) this.emit('error', `${missing.length} recording(s) could not be loaded from storage.`);
    let punch = from != null ? from : p.position;
    if (this._loopActive() && (punch < p.loop.start || punch >= p.loop.end)) punch = p.loop.start;
    const ci = Math.max(0, p.click.countIn | 0) * barDur(p);
    const recId = uid('r_');
    this.rec = {
      recId, projectId: p.id, tracks: armed.map(i => ({ track: i, input: p.tracks[i].input })), punch,
      lat: this.inputLatency(), sr: this.ctx.sampleRate, chunks: [], seq: 0, journaled: 0, capturedFrames: 0,
      loop: this._loopActive() ? { start: p.loop.start, end: p.loop.end } : null, startedAt: Date.now(), clipped: false,
    };
    this.capture.port.postMessage({ cmd: 'start' });
    this.playStart = punch;
    this.state = 'recording';
    this._startTransport(punch - ci, { countInEnd: ci > 0 ? punch : -Infinity });
    this.rec.passes = this.passes; // shared reference; passes are appended as loops proceed
    this.rec.journalTimer = setInterval(() => this._journalFlush().catch(e => this.emit('error', 'Could not write the recording safety journal: ' + e.message)), 1500);
    this.emit('state', this.state);
    return { punch, countIn: ci };
  }
  /** Punch in while already playing: no count-in, recording starts at the current position. */
  _punchIn(armed) {
    const p = this.project, punch = this.position() + 0.05;
    this.rec = {
      recId: uid('r_'), projectId: p.id, tracks: armed.map(i => ({ track: i, input: p.tracks[i].input })), punch,
      lat: this.inputLatency(), sr: this.ctx.sampleRate, chunks: [], seq: 0, journaled: 0, capturedFrames: 0,
      loop: this._loopActive() ? { start: p.loop.start, end: p.loop.end } : null, startedAt: Date.now(), clipped: false,
    };
    this.capture.port.postMessage({ cmd: 'start' });
    this.rec.passes = this.passes;
    this.countInEnd = -Infinity;
    this.state = 'recording';
    this.rec.journalTimer = setInterval(() => this._journalFlush().catch(e => this.emit('error', 'Could not write the recording safety journal: ' + e.message)), 1500);
    this.emit('state', this.state);
    return { punch, countIn: 0 };
  }
  recordingDuration() {
    if (!this.rec) return 0;
    return Math.max(0, this.position() - this.rec.punch);
  }
  _journalMeta() {
    const r = this.rec;
    return { recId: r.recId, projectId: r.projectId, tracks: r.tracks, punch: r.punch, lat: r.lat, sr: r.sr, loop: r.loop, startedAt: r.startedAt, passes: r.passes.map(p => ({ ...p, tlEnd: isFinite(p.tlEnd) ? p.tlEnd : null, ctxEnd: isFinite(p.ctxEnd) ? p.ctxEnd : null })) };
  }
  async _journalFlush() {
    const r = this.rec; if (!r) return;
    const fresh = r.chunks.slice(r.journaled);
    r.journaled = r.chunks.length;
    const recs = fresh.map(c => ({ recId: r.recId, seq: r.seq++, frame: c.frame, l: c.l.buffer.slice(0), r: c.r ? c.r.buffer.slice(0) : null }));
    await Store.putJournal(this._journalMeta(), recs);
  }
  async _finishRecording(stopCtx) {
    const r = this.rec;
    clearInterval(r.journalTimer);
    // ask the worklet to flush, and wait for the last chunk
    await new Promise(res => { r.onStopped = res; this.capture.port.postMessage({ cmd: 'stop' }); setTimeout(res, 1500); });
    // drop loop passes scheduled ahead but never reached, then close the last pass at the stop time
    // (+latency, so the tail of the performance that was still "in flight" is kept)
    const endT = stopCtx + r.lat;
    r.passes = r.passes.filter(pp => pp.ctxStart < endT);
    const lp = r.passes[r.passes.length - 1];
    if (lp && (!isFinite(lp.ctxEnd) || lp.ctxEnd > endT)) { lp.tlEnd = lp.tlStart + (endT - lp.ctxStart); lp.ctxEnd = endT; lp.closed = true; }
    this.rec = null;
    let result;
    try { await this._journalFlushFinal(r); } catch (e) { /* journal is best-effort; we still hold the audio in memory */ }
    result = assembleRecording(r.chunks.map(c => ({ frame: c.frame, l: c.l, r: c.r })), r);
    this.lastGaps = result.frameGaps; result.recId = r.recId; result.clipped = r.clipped; result.loop = r.loop; result.sr = r.sr;
    return result;
  }
  async _journalFlushFinal(r) {
    const fresh = r.chunks.slice(r.journaled);
    const recs = fresh.map(c => ({ recId: r.recId, seq: r.seq++, frame: c.frame, l: c.l.buffer.slice(0), r: c.r ? c.r.buffer.slice(0) : null }));
    const meta = { recId: r.recId, projectId: r.projectId, tracks: r.tracks, punch: r.punch, lat: r.lat, sr: r.sr, loop: r.loop, startedAt: r.startedAt, passes: r.passes.map(p => ({ ...p, tlEnd: isFinite(p.tlEnd) ? p.tlEnd : null, ctxEnd: isFinite(p.ctxEnd) ? p.ctxEnd : null })) };
    await Store.putJournal(meta, recs);
  }

  /* ---------- live waveform for the take being recorded ---------- */
  livePeaks() {
    const r = this.rec; if (!r || !r.chunks.length) return null;
    if (!r.live) r.live = { peaks: [], done: 0, acc: [0, 0], cnt: 0, frame0: r.chunks[0].frame };
    const L = r.live;
    for (; L.done < r.chunks.length; L.done++) {
      const d = r.chunks[L.done].l;
      for (let i = 0; i < d.length; i++) { const s = d[i]; if (s < L.acc[0]) L.acc[0] = s; if (s > L.acc[1]) L.acc[1] = s; if (++L.cnt === PEAK_BLOCK) { L.peaks.push(L.acc[0], L.acc[1]); L.acc = [0, 0]; L.cnt = 0; } }
    }
    // map: frame0 → timeline (first pass)
    const t0 = L.frame0 / r.sr - r.lat;
    let pass = r.passes[0]; for (const ps of r.passes) if (ps.ctxStart <= t0) pass = ps;
    const tl0 = pass.tlStart + (t0 - pass.ctxStart);
    return { tl0, peaks: L.peaks, block: PEAK_BLOCK, sr: r.sr, punch: r.punch };
  }

  /* ---------- offline render (export) ---------- */
  /** opts: {tracks:[i..], drums:bool, stem:bool (ignore mute/solo), end:sec, sampleRate} → AudioBuffer (stereo) */
  async render(opts) {
    const p = this.project;
    await this.loadProjectAudio(p);
    const sr = opts.sampleRate || (this.ctx ? this.ctx.sampleRate : 48000);
    const len = Math.max(1, Math.ceil(opts.end * sr));
    const c = new OfflineAudioContext({ numberOfChannels: 2, length: len, sampleRate: sr });
    const master = c.createGain(); master.gain.value = p.master.vol; master.connect(c.destination);
    const revIn = c.createGain(), conv = c.createConvolver(); conv.buffer = Synth.impulse(c, p.master.reverbSize);
    revIn.connect(conv).connect(master);
    const anySolo = p.tracks.some(t => t.solo);
    const D = this.procDelay != null ? this.procDelay : await measureStripDelay(sr);
    const pass = { ctxStart: -D, tlStart: 0, tlEnd: opts.end, ctxEnd: opts.end - D };
    const sink = [];
    for (const tr of opts.tracks) {
      const t = p.tracks[tr];
      const audible = opts.stem ? true : (!t.mute && (!anySolo || t.solo));
      if (!audible) continue;
      const strip = buildStrip(c, master, revIn); strip.update(t, true, 0, 0);
      for (const seg of trackSegments(p, tr)) {
        const take = activeTake(seg.clip), buf = this.buffers.get(take.audioId);
        if (buf) this._scheduleSegment(c, strip.input, buf, take.srcStart, seg.from, seg.to, pass, 0, sink);
      }
    }
    if (opts.drums && p.drums.on) {
      const bus = c.createGain(); bus.gain.value = p.drums.vol; bus.connect(master);
      for (const ev of gridEvents(p, 0, opts.end, false, true, -Infinity)) Synth.drum(c, bus, ev.inst, ev.t, ev.vel);
    }
    return c.startRendering();
  }
}

/** Channel strips contain a DynamicsCompressor, which has a fixed look-ahead delay (≈6 ms in Chromium/WebKit).
 *  We measure it once and schedule track audio that much earlier, so what you hear (and export) sits exactly on the timeline. */
async function measureStripDelay(sr) {
  try {
    const n = 4096, c = new OfflineAudioContext({ numberOfChannels: 1, length: n, sampleRate: sr });
    const b = c.createBuffer(1, 64, sr); b.getChannelData(0)[0] = 1;
    const s = c.createBufferSource(); s.buffer = b;
    const rev = c.createGain();
    const strip = buildStrip(c, c.destination, rev);
    strip.update({ vol: 1, pan: 0, fx: { lowcut: false, low: 0, mid: 0, high: 0, comp: 0, reverb: 0 } }, true, 0, 0);
    s.connect(strip.input); s.start(0);
    const out = (await c.startRendering()).getChannelData(0);
    let mi = 0; for (let i = 1; i < n; i++) if (Math.abs(out[i]) > Math.abs(out[mi])) mi = i;
    return mi / sr;
  } catch (_) { return 0; }
}

/** Musical grid events in [tlA, tlB). Clicks during count-in always sound. Drums don't play during count-in. */
function gridEvents(p, tlA, tlB, wantClick, wantDrums, countInEnd) {
  const out = [], bd = beatDur(p), bar = barDur(p);
  for (let k = Math.ceil(tlA / bd - 1e-9); k * bd < tlB - 1e-9; k++) {
    const t = k * bd;
    const inCount = t < countInEnd - 1e-6;
    if (wantClick || inCount) {
      const ib = ((k % p.tsNum) + p.tsNum) % p.tsNum;
      out.push({ t, click: true, accent: ib === 0 });
    }
  }
  if (wantDrums) {
    const hits = Synth.barHits(p.drums.pattern, p.tsNum, p.tsDen);
    for (let b = Math.floor(tlA / bar) - 1; b * bar < tlB; b++) {
      for (const h of hits) {
        const t = b * bar + h.pos * bd;
        if (t >= tlA - 1e-9 && t < tlB - 1e-9 && t >= 0 && !(t < countInEnd - 1e-6)) out.push({ t, inst: h.inst, vel: h.vel });
      }
    }
  }
  return out;
}

/**
 * Turn raw captured chunks into takes.
 * meta: {tracks:[{track,input}], punch, lat, sr, passes:[{ctxStart, tlStart, tlEnd, ctxEnd}], loop}
 * returns {tracks: [{track, takes:[{srcStart, data:Float32Array, complete}]}]}
 */
function assembleRecording(chunks, meta) {
  const out = { tracks: meta.tracks.map(t => ({ track: t.track, takes: [] })) };
  if (!chunks.length) return out;
  chunks.sort((a, b) => a.frame - b.frame);
  let gaps = 0; for (let i = 1; i < chunks.length; i++) if (chunks[i].frame !== chunks[i - 1].frame + chunks[i - 1].l.length) gaps++;
  out.frameGaps = gaps;
  const base = chunks[0].frame, lastC = chunks[chunks.length - 1];
  const total = lastC.frame + lastC.l.length - base;
  const L = new Float32Array(total); let R = null;
  for (const c of chunks) {
    const o = c.frame - base; if (o < 0 || o >= total) continue;
    L.set(c.l.subarray(0, Math.min(c.l.length, total - o)), o);
    if (c.r) { if (!R) R = new Float32Array(total); R.set(c.r.subarray(0, Math.min(c.r.length, total - o)), o); }
  }
  const { sr, lat, punch } = meta;
  const minLen = Math.round(0.15 * sr);
  const passes = meta.passes.map(p => ({ ...p, tlEnd: p.tlEnd == null ? Infinity : p.tlEnd, ctxEnd: p.ctxEnd == null ? Infinity : p.ctxEnd }));
  meta.tracks.forEach((tdef, ti) => {
    let mono;
    if (!R || tdef.input === 'L') mono = L;
    else if (tdef.input === 'R') mono = R;
    else { mono = new Float32Array(total); for (let i = 0; i < total; i++) mono[i] = (L[i] + R[i]) * 0.5; }
    passes.forEach((ps, k) => {
      // sample index i ↔ context time (base+i)/sr; performer-time = that − lat
      const idx = ctxT => Math.ceil((ctxT + lat) * sr - base - 1e-6);
      let i0 = idx(ps.ctxStart);
      if (punch > ps.tlStart) i0 = Math.max(i0, idx(ps.ctxStart + (punch - ps.tlStart)));
      let i1 = isFinite(ps.ctxEnd) ? idx(ps.ctxEnd) : total;
      const complete = i0 >= 0 && i1 <= total && !ps.closed;
      i0 = Math.max(0, i0); i1 = Math.min(total, i1);
      if (i1 - i0 < minLen) return;
      const srcStart = ps.tlStart + ((base + i0) / sr - lat - ps.ctxStart);
      out.tracks[ti].takes.push({ srcStart, data: mono.slice(i0, i1), complete: meta.loop ? complete : true });
    });
  });
  return out;
}
