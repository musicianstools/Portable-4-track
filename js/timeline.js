'use strict';
/* ===== Timeline canvas: ruler, loop, markers, 4 lanes of clips, playhead; touch + mouse editing ===== */

class Timeline {
  constructor(canvas, app) {
    this.cv = canvas; this.app = app; this.g = canvas.getContext('2d');
    this.rulerH = 28; this.dpr = 1; this.w = 0; this.h = 0;
    this.selected = null; this.drag = null; this.pointers = new Map(); this.dirty = true;
    this._bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }
  get p() { return this.app.project; }
  get pps() { return this.p.view.pxPerSec; }
  get scroll() { return this.p.view.scroll; }
  set scroll(v) { this.p.view.scroll = Math.max(-0.5, v); this.dirty = true; }
  laneH() { return (this.h - this.rulerH) / 4; }
  x2t(x) { return this.scroll + x / this.pps; }
  t2x(t) { return (t - this.scroll) * this.pps; }
  laneAt(y) { return y < this.rulerH ? -1 : clamp(Math.floor((y - this.rulerH) / this.laneH()), 0, 3); }

  resize() {
    const r = this.cv.parentElement.getBoundingClientRect();
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.w = Math.max(10, r.width); this.h = Math.max(10, r.height);
    this.cv.width = Math.round(this.w * this.dpr); this.cv.height = Math.round(this.h * this.dpr);
    this.cv.style.width = this.w + 'px'; this.cv.style.height = this.h + 'px';
    this.dirty = true;
    this.app.onLayout && this.app.onLayout(this.laneH(), this.rulerH);
  }
  zoom(f, anchorX = this.w / 2) {
    const t = this.x2t(anchorX);
    this.p.view.pxPerSec = clamp(this.pps * f, 4, 1200);
    this.scroll = t - anchorX / this.pps;
    this.app.saveView();
  }
  ensureVisible(t, paging = true) {
    const x = this.t2x(t);
    if (x < 0 || x > this.w - 30) this.scroll = paging ? t - this.w * 0.1 / this.pps : t - this.w / 2 / this.pps;
  }

  /* ---------- hit testing ---------- */
  clipAt(x, y) {
    const lane = this.laneAt(y); if (lane < 0) return null;
    const t = this.x2t(x);
    const cands = this.p.clips.filter(c => c.track === lane && t >= c.start && t <= c.end).sort((a, b) => b.z - a.z);
    if (cands.length) return cands[0];
    // generous edge grabbing for the selected clip
    const s = this.selected && findClip(this.p, this.selected);
    if (s && s.track === lane) { const tol = 16 / this.pps; if (Math.abs(t - s.start) < tol || Math.abs(t - s.end) < tol) return s; }
    return null;
  }

  _bind() {
    const cv = this.cv;
    cv.addEventListener('pointerdown', e => this._down(e));
    cv.addEventListener('pointermove', e => this._move(e));
    cv.addEventListener('pointerup', e => this._up(e));
    cv.addEventListener('pointercancel', e => this._up(e, true));
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.zoom(Math.exp(-e.deltaY * 0.01), e.offsetX);
      else { this.scroll = this.scroll + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / this.pps; this.app.saveView(); }
    }, { passive: false });
    cv.addEventListener('contextmenu', e => e.preventDefault());
  }
  _pt(e) { const r = this.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  _down(e) {
    this.app.unlockAudio();
    this.cv.setPointerCapture(e.pointerId);
    const pt = this._pt(e);
    this.pointers.set(e.pointerId, pt);
    if (this.pointers.size === 2) { // pinch
      const [a, b] = [...this.pointers.values()];
      if (this.drag && this.drag.committed) this.app.cancelEdit();
      this.drag = { kind: 'pinch', d0: Math.abs(a.x - b.x) || 1, pps0: this.pps, t0: this.x2t((a.x + b.x) / 2), mid: (a.x + b.x) / 2 };
      return;
    }
    const touch = e.pointerType === 'touch', edge = touch ? 18 : 9;
    const d = { x0: pt.x, y0: pt.y, t0: this.x2t(pt.x), moved: false, scroll0: this.scroll, touch, time: performance.now() };
    if (pt.y < this.rulerH) {
      const l = this.p.loop;
      const nearS = Math.abs(this.t2x(l.start) - pt.x) < edge, nearE = Math.abs(this.t2x(l.end) - pt.x) < edge;
      d.kind = nearE ? 'loopEnd' : nearS ? 'loopStart' : 'ruler';
      const mk = this.p.markers.find(m => Math.abs(this.t2x(m.t) - pt.x) < 10 && pt.y < this.rulerH);
      if (mk && d.kind === 'ruler') d.marker = mk;
    } else {
      const c = this.clipAt(pt.x, pt.y);
      if (c) {
        const xs = this.t2x(c.start), xe = this.t2x(c.end);
        const wide = xe - xs > edge * 3;
        d.clip = c.id; d.kind = (wide && pt.x - xs < edge) || (!wide && pt.x < xs + 4) ? 'trimS' : (wide && xe - pt.x < edge) || (!wide && pt.x > xe - 4) ? 'trimE' : 'move';
        d.start0 = c.start; d.end0 = c.end; d.track0 = c.track;
        const wasSel = this.selected === c.id;
        this.select(c.id);
        // on touch, moving an unselected clip needs a press-and-hold; a plain swipe scrolls
        if (touch && !wasSel && d.kind === 'move') d.kind = 'maybeMove';
        if (touch && !wasSel && d.kind.startsWith('trim')) d.kind = 'maybeMove';
        d.lp = setTimeout(() => { if (!d.moved) { d.longPress = true; if (d.kind === 'maybeMove') d.kind = 'move'; this.app.haptic(); this.app.openClipMenu(c.id); } }, 550);
      } else d.kind = 'empty';
    }
    this.drag = d;
  }
  _move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const pt = this._pt(e); this.pointers.set(e.pointerId, pt);
    const d = this.drag; if (!d) return;
    if (d.kind === 'pinch') {
      const [a, b] = [...this.pointers.values()]; if (!b) return;
      const dist = Math.abs(a.x - b.x) || 1;
      this.p.view.pxPerSec = clamp(d.pps0 * dist / d.d0, 4, 1200);
      const mid = (a.x + b.x) / 2; this.scroll = d.t0 - mid / this.pps; return;
    }
    const dx = pt.x - d.x0, dy = pt.y - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < (d.touch ? 8 : 4)) return;
    if (!d.moved) { d.moved = true; clearTimeout(d.lp); }
    const p = this.p, snap = p.view.snap, t = this.x2t(pt.x);
    switch (d.kind) {
      case 'empty': case 'maybeMove':
        this.scroll = d.scroll0 - dx / this.pps; break;
      case 'ruler': {
        if (this.app.engine.state === 'recording') break;
        if (!d.committed) { this.app.beginEdit('Set loop'); d.committed = true; }
        const a = snapTime(p, Math.max(0, d.t0), snap === 'off' ? 'off' : snap), b = snapTime(p, Math.max(0, t), snap === 'off' ? 'off' : snap);
        p.loop.start = Math.min(a, b); p.loop.end = Math.max(a, b);
        if (p.loop.end - p.loop.start >= 0.25) p.loop.on = true;
        this.app.loopChanged(true); break;
      }
      case 'loopStart': case 'loopEnd': {
        if (this.app.engine.state === 'recording') break;
        if (!d.committed) { this.app.beginEdit('Adjust loop'); d.committed = true; }
        const v = snapTime(p, Math.max(0, t), snap);
        if (d.kind === 'loopStart') p.loop.start = Math.min(v, p.loop.end - 0.25); else p.loop.end = Math.max(v, p.loop.start + 0.25);
        p.loop.on = true;
        this.app.loopChanged(true); break;
      }
      case 'move': {
        if (!d.committed) { this.app.beginEdit('Move clip'); d.committed = true; }
        const c = findClip(p, d.clip); if (!c) break;
        let ns = d.start0 + dx / this.pps;
        if (snap !== 'off') ns = snapTime(p, ns, snap);
        ns = Math.max(0, ns);
        const lane = this.laneAt(pt.y); const nt = lane >= 0 && Math.abs(dy) > this.laneH() * 0.5 ? lane : d.track0;
        moveClip(p, c.id, ns, nt);
        this.app.clipsChanged(false); break;
      }
      case 'trimS': case 'trimE': {
        if (!d.committed) { this.app.beginEdit('Trim clip'); d.committed = true; }
        let v = snap !== 'off' ? snapTime(p, t, snap) : t;
        if (d.kind === 'trimS') trimClip(p, d.clip, v, null); else trimClip(p, d.clip, null, v);
        this.app.clipsChanged(false); break;
      }
    }
    this.dirty = true;
  }
  _up(e, cancel) {
    this.pointers.delete(e.pointerId);
    const d = this.drag; if (!d) return;
    if (d.kind === 'pinch') { if (this.pointers.size === 0) { this.drag = null; this.app.saveView(); } return; }
    clearTimeout(d.lp);
    this.drag = null;
    if (cancel) { if (d.committed) this.app.endEdit(); return; }
    if (!d.moved && !d.longPress) {
      if (d.kind === 'empty') { this.select(null); this.app.seek(this.x2t(d.x0)); }
      else if (d.kind === 'ruler' || d.kind === 'loopStart' || d.kind === 'loopEnd') {
        if (d.marker) this.app.openMarker(d.marker.id); else this.app.seek(this.x2t(d.x0));
      }
    }
    if (d.committed) this.app.endEdit();
    if (['empty', 'maybeMove'].includes(d.kind) && d.moved) this.app.saveView();
    this.dirty = true;
  }
  select(id) { if (this.selected !== id) { this.selected = id; this.app.onSelect(id); } this.dirty = true; }

  /* ---------- drawing ---------- */
  draw(pos, rec) {
    const g = this.g, p = this.p, W = this.w, H = this.h, R = this.rulerH, lh = this.laneH();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    // lanes
    for (let i = 0; i < 4; i++) {
      g.fillStyle = i % 2 ? '#191715' : '#1c1a18'; g.fillRect(0, R + i * lh, W, lh);
      if (p.tracks[i].arm) { g.fillStyle = 'rgba(226,70,58,0.06)'; g.fillRect(0, R + i * lh, W, lh); }
    }
    // grid
    const bd = beatDur(p), bar = barDur(p), beatPx = bd * this.pps, barPx = bar * this.pps;
    let barStep = 1; while (barPx * barStep < 46) barStep *= 2;
    const t0 = this.x2t(0), t1 = this.x2t(W);
    g.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace'; g.textBaseline = 'middle';
    g.fillStyle = '#26231f'; g.fillRect(0, 0, W, R);
    for (let b = Math.max(0, Math.floor(t0 / bar)); b * bar <= t1; b++) {
      const x = Math.round(this.t2x(b * bar)) + 0.5;
      if (beatPx > 9) for (let k = 1; k < p.tsNum; k++) { const xb = Math.round(this.t2x(b * bar + k * bd)) + 0.5; g.strokeStyle = 'rgba(236,228,214,0.045)'; g.beginPath(); g.moveTo(xb, R); g.lineTo(xb, H); g.stroke(); }
      if (b % barStep) continue;
      g.strokeStyle = 'rgba(236,228,214,0.11)'; g.beginPath(); g.moveTo(x, R - 8); g.lineTo(x, H); g.stroke();
      g.fillStyle = '#9b9285'; g.fillText(String(b + 1), x + 4, R / 2 + 3);
    }
    // loop region
    const L = p.loop;
    if (L.end > L.start) {
      const xs = this.t2x(L.start), xe = this.t2x(L.end);
      g.fillStyle = L.on ? 'rgba(240,163,58,0.85)' : 'rgba(155,146,133,0.35)';
      g.fillRect(xs, 2, xe - xs, 7);
      if (L.on) { g.fillStyle = 'rgba(240,163,58,0.06)'; g.fillRect(xs, R, xe - xs, H - R); }
      g.fillStyle = L.on ? '#f0a33a' : '#7a7266';
      g.fillRect(xs - 1, 0, 3, R); g.fillRect(xe - 2, 0, 3, R);
    }
    // markers
    for (const m of p.markers) {
      const x = this.t2x(m.t); if (x < -80 || x > W + 4) continue;
      g.fillStyle = '#7f9cc8'; g.beginPath(); g.moveTo(x, R); g.lineTo(x - 5, R - 8); g.lineTo(x + 5, R - 8); g.closePath(); g.fill();
      g.fillStyle = '#c9d6ea'; g.fillText(m.name.slice(0, 14), x + 7, R - 9);
      g.strokeStyle = 'rgba(127,156,200,0.35)'; g.beginPath(); g.moveTo(Math.round(x) + 0.5, R); g.lineTo(Math.round(x) + 0.5, H); g.stroke();
    }
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(0, R - 1, W, 1);
    // clips (z order, so the top clip covers the one beneath — matching what you hear)
    const clips = [...p.clips].sort((a, b) => a.z - b.z);
    for (const c of clips) this._drawClip(c, R + c.track * lh, lh);
    // live recording
    if (rec) this._drawLive(rec, lh, R);
    // playhead
    const px = Math.round(this.t2x(pos)) + 0.5;
    const recording = this.app.engine.state === 'recording';
    g.strokeStyle = recording ? '#ff5a4a' : '#f4e6c8'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke(); g.lineWidth = 1;
    g.fillStyle = recording ? '#ff5a4a' : '#f4e6c8';
    g.beginPath(); g.moveTo(px - 6, 0); g.lineTo(px + 6, 0); g.lineTo(px, 8); g.closePath(); g.fill();
    this.dirty = false;
  }
  _drawClip(c, y, lh) {
    const g = this.g, p = this.p, x0 = this.t2x(c.start), x1 = this.t2x(c.end);
    if (x1 < 0 || x0 > this.w) return;
    const col = p.tracks[c.track].color, sel = this.selected === c.id;
    const top = y + 3, h = lh - 6, w = Math.max(2, x1 - x0);
    g.save();
    g.beginPath(); g.roundRect ? g.roundRect(x0, top, w, h, 5) : g.rect(x0, top, w, h); g.clip();
    g.fillStyle = '#0f0e0d'; g.fillRect(x0, top, w, h);
    g.fillStyle = hexA(col, sel ? 0.28 : 0.17); g.fillRect(x0, top, w, h);
    g.fillStyle = hexA(col, sel ? 0.9 : 0.55); g.fillRect(x0, top, w, 14);
    // waveform of the active take
    const take = activeTake(c), buf = this.app.engine.buffers.get(take.audioId);
    const wy = top + 14 + (h - 14) / 2, amp = (h - 18) / 2;
    if (buf) {
      g.fillStyle = hexA(col, 0.95);
      const sr = buf.sampleRate, data = buf.getChannelData(0), peaks = buf._peaks;
      const xa = Math.max(0, Math.floor(x0)), xb = Math.min(this.w, Math.ceil(x1));
      const spp = sr / this.pps; // samples per pixel
      for (let x = xa; x < xb; x++) {
        const ta = this.x2t(x) - take.srcStart, tb = ta + 1 / this.pps;
        if (tb < 0 || ta > buf.duration) continue;
        let mn = 0, mx = 0;
        if (spp >= PEAK_BLOCK * 2 && peaks) {
          const ia = Math.max(0, Math.floor(ta * sr / PEAK_BLOCK)), ib = Math.min(peaks.length / 2, Math.ceil(tb * sr / PEAK_BLOCK));
          for (let i = ia; i < ib; i++) { if (peaks[2 * i] < mn) mn = peaks[2 * i]; if (peaks[2 * i + 1] > mx) mx = peaks[2 * i + 1]; }
        } else {
          const ia = Math.max(0, Math.floor(ta * sr)), ib = Math.min(data.length, Math.ceil(tb * sr));
          for (let i = ia; i < ib; i++) { const s = data[i]; if (s < mn) mn = s; else if (s > mx) mx = s; }
        }
        const y0 = wy - Math.min(1, mx) * amp, y1 = wy - Math.max(-1, mn) * amp;
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    }
    // label
    g.fillStyle = '#121110'; g.font = '700 10px ui-sans-serif, system-ui, sans-serif'; g.textBaseline = 'middle';
    const label = take.name + (c.takes.length > 1 ? `  ·  ${c.takes.indexOf(take) + 1}/${c.takes.length}` : '') + (take.fav ? '  ★' : '');
    g.fillText(label, Math.max(x0, 0) + 6, top + 7.5);
    g.restore();
    g.strokeStyle = sel ? '#f4e6c8' : hexA(col, 0.7); g.lineWidth = sel ? 2 : 1;
    g.beginPath(); g.roundRect ? g.roundRect(x0 + 0.5, top + 0.5, w - 1, h - 1, 5) : g.rect(x0, top, w, h); g.stroke(); g.lineWidth = 1;
    if (sel) { // trim handles
      g.fillStyle = '#f4e6c8';
      g.fillRect(x0 + 1, top + h / 2 - 12, 4, 24); g.fillRect(x1 - 5, top + h / 2 - 12, 4, 24);
    }
  }
  _drawLive(rec, lh, R) {
    const g = this.g, p = this.p;
    for (const tr of p.tracks.map((t, i) => t.arm ? i : -1).filter(i => i >= 0)) {
      const y = R + tr * lh + 3, h = lh - 6, wy = y + h / 2, amp = h / 2 - 3;
      const xs = this.t2x(Math.max(rec.punch, rec.tl0)), xe = this.t2x(rec.tl0 + rec.peaks.length / 2 * rec.block / rec.sr);
      if (xe <= xs) continue;
      g.fillStyle = 'rgba(226,70,58,0.18)'; g.fillRect(xs, y, xe - xs, h);
      g.strokeStyle = '#e2463a'; g.strokeRect(xs + 0.5, y + 0.5, xe - xs - 1, h - 1);
      g.fillStyle = '#ff6a5a';
      const perPx = rec.sr / rec.block / this.pps;
      for (let x = Math.max(0, Math.floor(xs)); x < Math.min(this.w, xe); x++) {
        const i0 = Math.floor((this.x2t(x) - rec.tl0) * rec.sr / rec.block);
        let mn = 0, mx = 0;
        for (let i = i0; i < i0 + Math.max(1, perPx); i++) { if (i < 0 || i * 2 >= rec.peaks.length) continue; mn = Math.min(mn, rec.peaks[2 * i]); mx = Math.max(mx, rec.peaks[2 * i + 1]); }
        g.fillRect(x, wy - mx * amp, 1, Math.max(1, (mx - mn) * amp));
      }
    }
  }
}
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
