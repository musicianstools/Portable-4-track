'use strict';
/* ===== Pocket Four-Track — application ===== */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const DEFAULT_SETTINGS = { inputDevice: '', outputDevice: '', latencyMode: 'auto', latencyMs: 0, monitor: false, monitorGain: 0.8, wakeLock: true, shareExports: false, a4: 440 };

const App = {
  engine: new Engine(),
  project: null,
  history: new History(),
  settings: { ...DEFAULT_SETTINGS },
  view: 'studio',
  saveState: 'saved',
  wakeLock: null,

  /* ================= startup ================= */
  async start() {
    try { await Store.open(); }
    catch (e) { this.fatal('Local storage is unavailable: ' + e.message + ' Private-browsing modes can block it.'); return; }
    const s = await Store.kvGet('settings').catch(() => null);
    Object.assign(this.settings, s || {});
    Object.assign(this.engine.settings, this.settings);
    this.tl = new Timeline($('#timeline'), this);
    this.tuner = new Tuner(this.engine);
    this.tap = new TapTempo();
    this.bindDeck(); this.bindTransport(); this.bindTabs(); this.bindKeys();
    this.engine.on('state', () => this.onEngineState());
    this.engine.on('error', m => this.toast(m, { err: true, ms: 7000 }));
    this.engine.on('autostop', ({ res, start }) => { this.project.position = Math.max(0, start || 0); this.afterStop(res); });
    this.engine.on('input', () => this.renderSettingsIfOpen());
    document.addEventListener('pointerdown', () => this.unlockAudio(), { capture: true });
    document.addEventListener('keydown', () => this.unlockAudio(), { capture: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && this.engine.isRunning()) this.wake(true); if (document.hidden) this.flushSave(); });
    window.addEventListener('pagehide', () => this.flushSave());
    window.addEventListener('beforeunload', e => { if (this.engine.state === 'recording' || this.saveState === 'saving') { e.preventDefault(); e.returnValue = ''; } });
    $('#fileImport').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) this.importBackup(f); });

    const last = await Store.kvGet('lastProject').catch(() => null);
    let p = last ? await Store.getProject(last).catch(() => null) : null;
    if (!p) { const all = await Store.listProjects(); p = all.sort((a, b) => (b.opened || 0) - (a.opened || 0))[0]; }
    if (p) await this.openProject(p.id); else await this.createProject();
    await this.checkRecovery();
    this.loop();
  },
  fatal(msg) { document.body.innerHTML = `<div style="padding:40px 24px;font:16px/1.5 system-ui;color:#ece4d6;max-width:520px;margin:auto"><h2>Pocket Four-Track can't start</h2><p>${esc(msg)}</p></div>`; },
  async unlockAudio() {
    if (this._unlocking || (this.engine.ctx && this.engine.ctx.state === 'running')) return;
    this._unlocking = true;
    try { await this.engine.init(); } catch (e) { this.toast(e.message, { err: true }); }
    this._unlocking = false;
  },

  /* ================= project lifecycle ================= */
  async createProject(name) {
    if (this.engine.isRunning()) await this.stop();
    const p = newProject(name);
    try { await Store.saveProject(p); } catch (e) { this.toast('Could not create the project: ' + e.message, { err: true }); return; }
    await this.openProject(p.id);
    this.toast('New project — ready to record');
  },
  async openProject(id) {
    if (this.engine.isRunning()) await this.stop();
    await this.flushSave();
    const raw = await Store.getProject(id);
    if (!raw) { this.toast('Project not found.', { err: true }); return; }
    const p = normalizeProject(raw);
    p.opened = Date.now();
    this.project = p;
    this.history.clear();
    this.tl.selected = null; this.onSelect(null);
    this.engine.setProject(p);
    collectGarbage(p).catch(() => { });
    Store.kvSet('lastProject', p.id).catch(() => { });
    Store.saveProject(p).catch(() => { });
    this.renderAll();
    const missing = await this.engine.loadProjectAudio(p).catch(() => []);
    if (missing.length) this.toast(`${missing.length} recording(s) in this project could not be loaded from storage.`, { err: true });
    this.tl.dirty = true;
  },
  renderAll() {
    const p = this.project;
    $('#projName').textContent = p.name;
    document.title = p.name + ' — Pocket Four-Track';
    this.renderHeads(); this.renderDeck(); this.updateUndo();
    if (this.view !== 'studio') this.renderView(this.view);
    this.tl.resize();
  },

  /* ---------- saving ---------- */
  markDirty(content = true) {
    if (content) this.project.modified = Date.now();
    this.setSaveState('saving');
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this.flushSave(), 400);
  },
  saveView() { clearTimeout(this._viewT); this._viewT = setTimeout(() => { if (this.saveState !== 'saving') Store.saveProject(this.project).catch(() => { }); }, 800); },
  async flushSave() {
    clearTimeout(this._saveT);
    if (!this.project || this.saveState !== 'saving') return;
    const p = this.project;
    try {
      await Store.saveProject(JSON.parse(JSON.stringify(p)));
      if (this.project === p) this.setSaveState('saved');
    } catch (e) {
      this.setSaveState('failed');
      this.toast('Save failed: ' + e.message, { err: true, ms: 9000, action: { label: 'Retry', fn: () => { this.setSaveState('saving'); this.flushSave(); } } });
    }
  },
  setSaveState(s) {
    this.saveState = s;
    const el = $('#saveState');
    el.innerHTML = s === 'saved' ? '<i class="led led-green on"></i><span>Saved</span>' : s === 'saving' ? '<i class="led led-amber on blink"></i><span>Saving</span>' : '<i class="led led-red on"></i><span>Save failed</span>';
  },

  /* ---------- editing with undo ---------- */
  edit(label, fn, { reschedule = true, retime = false } = {}) {
    this.history.push(this.project, label);
    const r = fn(this.project);
    this.afterEdit({ reschedule, retime });
    return r;
  },
  beginEdit(label) { this.history.push(this.project, label); },
  endEdit() { this.afterEdit({ reschedule: true, retime: false }); },
  cancelEdit() { this.history.doUndo(this.project); this.history.redo.pop(); this.afterEdit({}); },
  afterEdit({ reschedule = true, retime = false } = {}) {
    if (retime) this.engine.retime(); else if (reschedule) this.engine.refresh();
    this.engine.updateMix();
    this.markDirty(); this.updateUndo(); this.renderDeck(); this.tl.dirty = true;
    if (this.tl.selected && !findClip(this.project, this.tl.selected)) this.tl.select(null); else this.onSelect(this.tl.selected);
  },
  undo() { if (this.engine.state === 'recording') return; const l = this.history.doUndo(this.project); if (l) { this.toast('Undid: ' + l, { ms: 1800 }); this.restoreAfterHistory(); } },
  redo() { if (this.engine.state === 'recording') return; const l = this.history.doRedo(this.project); if (l) { this.toast('Redid: ' + l, { ms: 1800 }); this.restoreAfterHistory(); } },
  async restoreAfterHistory() {
    await this.engine.loadProjectAudio(this.project);
    this.engine.retime(); this.engine.updateMix(0);
    this.markDirty(); this.updateUndo(); this.renderHeads(); this.renderDeck(); $('#projName').textContent = this.project.name;
    if (this.tl.selected && !findClip(this.project, this.tl.selected)) this.tl.select(null); else this.onSelect(this.tl.selected);
    this.tl.dirty = true;
  },
  updateUndo() { $('#btnUndo').disabled = !this.history.canUndo(); $('#btnRedo').disabled = !this.history.canRedo(); },
  clipsChanged() { this.tl.dirty = true; },
  loopChanged(dragging) { this.renderDeck(); this.tl.dirty = true; if (!dragging) this.engine.retime(); else { clearTimeout(this._loopT); this._loopT = setTimeout(() => this.engine.retime(), 120); } },

  /* ================= transport ================= */
  async play() {
    await this.unlockAudio();
    if (this.engine.isRunning()) return;
    try { await this.engine.play(this.project.position); this.wake(true); } catch (e) { this.toast(e.message, { err: true }); }
  },
  async pause() {
    if (!this.engine.isRunning()) return this.play();
    const pos = this.engine.position();
    if (this.engine.state === 'recording') this.setSaveState('saving');
    const res = await this.engine.stop();
    this.project.position = Math.max(0, pos);
    await this.afterStop(res);
  },
  async stop() {
    if (!this.engine.isRunning()) { this.project.position = 0; this.saveView(); this.tl.ensureVisible(0); this.tl.dirty = true; return; }
    const back = this.engine.playStart;
    if (this.engine.state === 'recording') this.setSaveState('saving');
    const res = await this.engine.stop();
    this.project.position = Math.max(0, back || 0);
    this.tl.ensureVisible(this.project.position);
    await this.afterStop(res);
  },
  async afterStop(res) {
    this.wake(false); this.saveView(); this.tl.dirty = true;
    if (res) this.setSaveState('saving');
    if (res) await this.handleRecording(res);
  },
  async record() {
    await this.unlockAudio();
    const e = this.engine;
    if (e.state === 'recording') return this.stop();
    if (!this.project.tracks.some(t => t.arm)) { this.toast('Arm a track first — tap its R button.', { err: true }); this.flashArm(); return; }
    this._persistAsked || (this._persistAsked = true, Store.persist());
    try {
      const est = await Store.estimate();
      if (est && est.quota && est.quota - est.usage < 60 * 1024 * 1024) this.toast('Storage is nearly full — a long take may not fit. Export a backup and free space.', { err: true, ms: 8000 });
      const r = await e.record(this.project.position);
      if (r) this.tl.ensureVisible(r.punch);
      this.wake(true);
    } catch (err) { this.toast(err.message, { err: true, ms: 8000 }); }
  },
  async handleRecording(res) {
    const p = this.project;
    const n = res.tracks.reduce((s, t) => s + t.takes.length, 0);
    if (!n) { this.toast('Recording was too short — nothing kept.'); Store.clearJournal(res.recId).catch(() => { }); this.setSaveState('saved'); return; }
    this.history.push(p, 'Record');
    try {
      const clips = await commitRecording(this.engine, p, res, res.sr);
      this.markDirty(); await this.flushSave();
      if (this.saveState !== 'saved') throw new Error('project could not be saved');
      await Store.clearJournal(res.recId).catch(() => { });
      const c = clips[clips.length - 1], tk = c && activeTake(c);
      const len = tk ? fmtTime(tk.length) : '';
      this.toast(`Take saved — ${p.tracks[c.track].name}${c.takes.length > 1 ? `, ${tk.name} (${c.takes.length} takes)` : ''} · ${len}` + (res.clipped ? ' · input clipped, lower the gain' : ''), { ms: 4000 });
      if (c) this.tl.select(c.id);
      this.updateUndo(); this.tl.dirty = true;
    } catch (err) {
      this.history.doUndo(p); this.history.redo.pop(); this.markDirty(false); this.flushSave();
      this.toast('The take could not be stored (' + err.message + '). It is kept in the safety journal.', {
        err: true, ms: 20000, action: { label: 'Download WAV', fn: () => this.rescueDownload(res) },
      });
    }
  },
  rescueDownload(res) {
    res.tracks.forEach(t => t.takes.forEach((tk, i) => downloadBlob(new Blob([encodeWav([tk.data], res.sr, 24)], { type: 'audio/wav' }), `rescued-track${t.track + 1}-take${i + 1}.wav`)));
  },
  async seek(t) {
    t = Math.max(0, t);
    const e = this.engine;
    if (e.state === 'recording') return;
    if (e.state === 'playing') { await e.stop(); this.project.position = t; await e.play(t); }
    else this.project.position = t;
    this.saveView(); this.tl.dirty = true;
  },
  jump(dir) {
    const p = this.project, pos = this.engine.isRunning() ? this.engine.position() : p.position;
    const bar = barDur(p), grace = this.engine.isRunning() ? 0.4 : 0.02;
    const targets = new Set([0, contentEnd(p), ...p.markers.map(m => m.t)]);
    const b0 = Math.floor(pos / bar);
    for (let b = Math.max(0, b0 - 2); b <= b0 + 2; b++) targets.add(b * bar);
    const list = [...targets].sort((a, b) => a - b);
    const t = dir < 0 ? [...list].reverse().find(x => x < pos - grace) ?? 0 : list.find(x => x > pos + 0.02) ?? pos;
    this.seek(t); this.tl.ensureVisible(t, false);
  },
  onEngineState() {
    const s = this.engine.state;
    $('#kPlay').classList.toggle('lit', s === 'playing' || s === 'recording');
    $('#kRec').classList.toggle('lit', s === 'recording');
    $('#ledRec').classList.toggle('on', s === 'recording');
    $('#ledPlay').classList.toggle('on', s !== 'stopped');
    $('#app').classList.toggle('rolling', s !== 'stopped');
    $('#counter').classList.toggle('rec', s === 'recording');
    $$('.tb.arm').forEach(b => b.classList.toggle('live', s === 'recording'));
    if (s === 'stopped') $('#countin').hidden = true;
  },
  async wake(on) {
    if (!('wakeLock' in navigator) || !this.settings.wakeLock) return;
    try {
      if (on && !this.wakeLock) { this.wakeLock = await navigator.wakeLock.request('screen'); this.wakeLock.addEventListener('release', () => { this.wakeLock = null; }); }
      else if (!on && this.wakeLock) { await this.wakeLock.release(); this.wakeLock = null; }
    } catch (_) { }
  },

  /* ================= render loop ================= */
  loop() {
    const step = () => {
      const e = this.engine, p = this.project, running = e.isRunning();
      const pos = running ? e.position() : p.position;
      // counter
      const ct = fmtTime(Math.max(0, pos));
      if (this._ct !== ct) { $('#counterTime').textContent = ct; this._ct = ct; }
      const bd = beatDur(p), beats = Math.floor(pos / bd + 1e-6);
      const bb = pos < 0 ? '—' : `${Math.floor(beats / p.tsNum) + 1}.${(beats % p.tsNum) + 1}`;
      if (this._bb !== bb) { $('#counterBar').textContent = bb; this._bb = bb; }
      const st = e.state === 'recording' ? (e.rec && pos < e.rec.punch ? 'COUNT' : 'REC') : e.state === 'playing' ? 'PLAY' : 'STOP';
      if (this._st !== st) { $('#counterState').textContent = st; this._st = st; }
      // count-in
      const ci = $('#countin');
      if (e.state === 'recording' && e.rec && pos < e.rec.punch - 0.01) { ci.hidden = false; const n = String(Math.ceil((e.rec.punch - pos) / bd - 1e-6)); if (ci._n !== n) { $('#countinNum').textContent = n; ci._n = n; } }
      else if (!ci.hidden) ci.hidden = true;
      // input meter
      const m = e.meter, live = !!(e.stream || e.testInput);
      const fill = live ? Math.min(100, Math.max(0, (20 * Math.log10(m.peak + 1e-6) + 48) / 48 * 100)) : 0;
      $('#inMeterFill').style.height = fill.toFixed(1) + '%';
      $('#inMeter').classList.toggle('dead', !live);
      $('#ledClip').classList.toggle('on', live && performance.now() < m.clipHold);
      // auto-stop at end of song (not when looping, recording or drumming)
      if (e.state === 'playing' && !p.loop.on && !p.drums.on && contentEnd(p) > 0 && pos > contentEnd(p) + 0.4) this.stop();
      // follow playhead
      if (running && !this.tl.drag) this.tl.ensureVisible(pos);
      const rec = e.state === 'recording' ? e.livePeaks() : null;
      if (running || this.tl.dirty || rec) { if (this.view === 'studio') this.tl.draw(pos, rec); }
      const hint = $('#emptyHint'); const showHint = p.clips.length === 0 && e.state !== 'recording';
      if (hint.hidden === showHint) hint.hidden = !showHint;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  },

  /* ================= deck ================= */
  bindDeck() {
    $('#btnProject').onclick = () => this.projectMenu();
    $('#btnUndo').onclick = () => this.undo();
    $('#btnRedo').onclick = () => this.redo();
    $('#btnNotes').onclick = () => this.notesSheet();
    $('#btnExport').onclick = () => this.exportSheet();
    $('#btnTempo').onclick = () => this.tempoSheet();
    $('#btnClick').onclick = () => { this.edit(this.project.click.on ? 'Click off' : 'Click on', p => { p.click.on = !p.click.on; }, { reschedule: false }); };
    $('#btnDrums').onclick = () => this.drumsSheet();
    $('#btnLoop').onclick = () => this.toggleLoop();
    $('#btnSnap').onclick = () => { const v = this.project.view; v.snap = { beat: 'bar', bar: 'off', off: 'beat' }[v.snap]; this.renderDeck(); this.saveView(); };
    $('#btnMarker').onclick = () => this.addMarker();
    $('#btnZoomIn').onclick = () => this.tl.zoom(1.5, this.tl.t2x(this.engine.isRunning() ? this.engine.position() : this.project.position));
    $('#btnZoomOut').onclick = () => this.tl.zoom(1 / 1.5, this.tl.t2x(this.engine.isRunning() ? this.engine.position() : this.project.position));
    $('#clipBar').addEventListener('click', e => { const b = e.target.closest('button'); if (b) this.clipAction(b.dataset.act); });
  },
  renderDeck() {
    const p = this.project;
    $('#bpmVal').textContent = Math.round(p.bpm * 10) / 10;
    $('#tsVal').textContent = p.tsNum + '/' + p.tsDen;
    $('#btnClick').classList.toggle('on', p.click.on);
    $('#btnDrums').classList.toggle('on', p.drums.on);
    $('#btnLoop').classList.toggle('on', p.loop.on);
    $('#snapVal').textContent = p.view.snap.toUpperCase();
  },
  toggleLoop() {
    const p = this.project;
    this.edit(p.loop.on ? 'Loop off' : 'Loop on', p => {
      if (!p.loop.on && p.loop.end - p.loop.start < 0.25) {
        const bar = barDur(p), s = Math.floor(p.position / bar) * bar; p.loop.start = s; p.loop.end = s + bar * 2;
      }
      p.loop.on = !p.loop.on;
    }, { retime: true });
    if (p.loop.on) this.toast(`Loop ${fmtTime(p.loop.start)} – ${fmtTime(p.loop.end)} · drag on the ruler to change`, { ms: 2500 });
  },
  addMarker() {
    const p = this.project, t = this.engine.isRunning() ? this.engine.position() : p.position;
    this.edit('Add marker', p => { p.markers.push({ id: uid('m_'), t: Math.max(0, t), name: ['Intro', 'Verse', 'Chorus', 'Bridge', 'Outro'][p.markers.length] || 'Marker ' + (p.markers.length + 1) }); p.markers.sort((a, b) => a.t - b.t); }, { reschedule: false });
  },
  flashArm() { $$('.tb.arm').forEach(b => { b.animate([{ boxShadow: '0 0 0 2px #ff5a48' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 700, iterations: 2 }); }); },

  /* ================= track heads ================= */
  renderHeads() {
    const host = $('#trackHeads'), p = this.project;
    host.innerHTML = '';
    host.append(h('div', { class: 'th-ruler' }, 'BAR'));
    p.tracks.forEach((t, i) => {
      const volIn = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: t.vol, 'aria-label': `Track ${i + 1} volume`, style: `--v:${t.vol * 100}%` });
      volIn.addEventListener('pointerdown', () => this.beginEdit('Volume'));
      volIn.addEventListener('input', () => { t.vol = +volIn.value; volIn.style.setProperty('--v', t.vol * 100 + '%'); this.engine.updateMix(); });
      volIn.addEventListener('change', () => { this.markDirty(); this.updateUndo(); });
      const panIn = h('input', { type: 'range', min: -1, max: 1, step: 0.02, value: t.pan, 'aria-label': `Track ${i + 1} pan`, style: `--v:${(t.pan + 1) * 50}%` });
      panIn.addEventListener('pointerdown', () => this.beginEdit('Pan'));
      panIn.addEventListener('input', () => { t.pan = +panIn.value; panIn.style.setProperty('--v', (t.pan + 1) * 50 + '%'); this.engine.updateMix(); });
      panIn.addEventListener('change', () => { this.markDirty(); this.updateUndo(); });
      panIn.addEventListener('dblclick', () => { t.pan = 0; panIn.value = 0; panIn.style.setProperty('--v', '50%'); this.engine.updateMix(); this.markDirty(); });
      const el = h('div', { class: 'th', style: `--c:${t.color}` },
        h('div', { class: 'th-top' },
          h('span', { class: 'tnum' }, String(i + 1)),
          h('button', { class: 'tname', onclick: () => this.trackSheet(i), title: 'Track settings' }, t.name),
          h('button', { class: 'tset', 'aria-label': `Track ${i + 1} settings & effects`, onclick: () => this.trackSheet(i) }, '⋯')),
        h('div', { class: 'th-btns' },
          h('button', { class: 'tb arm' + (t.arm ? ' on' : '') + (this.engine.state === 'recording' && t.arm ? ' live' : ''), 'aria-pressed': t.arm, title: `Arm track ${i + 1} for recording (${i + 1})`, onclick: () => this.toggleArm(i) }, 'R'),
          h('button', { class: 'tb mute' + (t.mute ? ' on' : ''), 'aria-pressed': t.mute, title: 'Mute', onclick: () => this.edit(t.mute ? 'Unmute' : 'Mute', () => { t.mute = !t.mute; }, { reschedule: false }) || this.renderHeads() }, 'M'),
          h('button', { class: 'tb solo' + (t.solo ? ' on' : ''), 'aria-pressed': t.solo, title: 'Solo', onclick: () => this.edit(t.solo ? 'Unsolo' : 'Solo', () => { t.solo = !t.solo; }, { reschedule: false }) || this.renderHeads() }, 'S')),
        h('div', { class: 'th-fader' }, h('label', {}, 'VOL'), volIn),
        h('div', { class: 'th-fader th-pan' }, h('label', {}, 'PAN'), panIn));
      host.append(el);
    });
    this.onLayout(this.tl.laneH(), this.tl.rulerH);
  },
  onLayout(lh, rh) {
    const host = $('#trackHeads'); if (!host || !host.children.length) return;
    host.style.gridTemplateRows = `${rh}px repeat(4, ${lh}px)`;
    $$('.th', host).forEach(el => { el.classList.toggle('short', lh < 104); el.classList.toggle('tiny', lh < 66); });
  },
  toggleArm(i) {
    if (this.engine.state === 'recording') { this.toast('Stop recording before changing armed tracks.'); return; }
    const p = this.project, t = p.tracks[i];
    const others = p.tracks.filter((x, j) => j !== i && x.arm);
    this.edit(t.arm ? 'Disarm' : 'Arm', () => {
      t.arm = !t.arm;
      // a single mono input can only feed one track; allow several only when tracks use different input channels
      if (t.arm) p.tracks.forEach((x, j) => { if (j !== i && x.arm && (x.input === t.input || x.input === 'mix' || t.input === 'mix')) x.arm = false; });
    }, { reschedule: false });
    this.renderHeads();
    if (t.arm && others.length && !p.tracks.some((x, j) => j !== i && x.arm)) this.toast(`Armed ${t.name}. To record two tracks at once, set their inputs to Left and Right in track settings.`, { ms: 4000 });
  },

  /* ================= clips ================= */
  onSelect(id) {
    const bar = $('#clipBar'), c = id && findClip(this.project, id);
    bar.hidden = !c;
    if (c) $('#takeCount').textContent = c.takes.length;
  },
  clipAction(act) {
    const p = this.project, id = this.tl.selected, c = id && findClip(p, id);
    if (act === 'close') { this.tl.select(null); return; }
    if (!c) return;
    const pos = this.engine.isRunning() ? this.engine.position() : p.position;
    if (act === 'split') {
      if (pos <= c.start + 0.01 || pos >= c.end - 0.01) { this.toast('Move the playhead inside the clip to split it there.'); return; }
      this.edit('Split clip', () => splitClip(p, id, pos));
    } else if (act === 'repeat') {
      const b = this.edit('Repeat clip', () => duplicateClipAfter(p, id)); if (b) this.tl.select(b.id);
    } else if (act === 'delete') {
      this.edit('Delete clip', () => deleteClip(p, id)); this.tl.select(null);
      this.toast('Clip deleted', { action: { label: 'Undo', fn: () => this.undo() } });
    } else if (act === 'takes') this.takesSheet(id);
  },
  openClipMenu(id) { this.takesSheet(id); },

  /* ================= sheets ================= */
  openSheet(title, body, onClose) {
    const host = $('#sheetHost');
    if (this._sheetClose) { const f = this._sheetClose; this._sheetClose = null; f(); }
    $('#sheetTitle').textContent = title;
    const b = $('#sheetBody'); b.innerHTML = ''; b.append(body);
    host.hidden = false; document.body.classList.add('sheet-open');
    this._sheetClose = onClose || null;
    host.onclick = e => { if (e.target.closest('[data-close]')) this.closeSheet(); };
    return b;
  },
  closeSheet() {
    $('#sheetHost').hidden = true; document.body.classList.remove('sheet-open');
    const f = this._sheetClose; this._sheetClose = null; if (f) f();
  },
  confirm(msg, ok = 'OK', danger = false) {
    return new Promise(res => {
      let done = false; const fin = v => { if (done) return; done = true; res(v); };
      const body = h('div', {}, h('p', { style: 'margin:4px 2px 0;line-height:1.5;color:var(--ink2)' }, msg),
        h('div', { class: 'sheet-actions' },
          h('button', { class: 'btn', onclick: () => { fin(false); this.closeSheet(); } }, 'Cancel'),
          h('button', { class: 'btn ' + (danger ? 'danger-fill' : 'primary'), onclick: () => { fin(true); this.closeSheet(); } }, ok)));
      this.openSheet(danger ? 'Are you sure?' : 'Confirm', body, () => fin(false));
    });
  },
  prompt(title, value, ok = 'Save') {
    return new Promise(res => {
      let done = false; const fin = v => { if (done) return; done = true; res(v); };
      const inp = h('input', { type: 'text', value: value || '', style: 'width:100%', maxlength: 80 });
      const go = () => { const v = inp.value.trim(); fin(v || null); this.closeSheet(); };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); e.stopPropagation(); });
      const body = h('div', {}, inp, h('div', { class: 'sheet-actions' }, h('button', { class: 'btn', onclick: () => { fin(null); this.closeSheet(); } }, 'Cancel'), h('button', { class: 'btn primary', onclick: go }, ok)));
      this.openSheet(title, body, () => fin(null));
      setTimeout(() => { inp.focus(); inp.select(); }, 60);
    });
  },
  toast(msg, { err = false, ms = 3200, action } = {}) {
    const el = h('div', { class: 'toast' + (err ? ' err' : ''), role: err ? 'alert' : 'status' }, h('span', {}, msg));
    if (action) el.append(h('button', { onclick: () => { action.fn(); el.remove(); } }, action.label));
    const host = $('#toasts'); host.append(el);
    while (host.children.length > 3) host.firstChild.remove();
    setTimeout(() => el.remove(), ms);
  },
  haptic() { try { navigator.vibrate && navigator.vibrate(12); } catch (_) { } },

  rangeRow(label, min, max, step, value, fmt, onInput, onCommit) {
    const out = h('output', {}, fmt(value));
    const r = h('input', { type: 'range', min, max, step, value, style: `--v:${(value - min) / (max - min) * 100}%` });
    r.addEventListener('pointerdown', () => onCommit && onCommit('start'));
    r.addEventListener('input', () => { const v = +r.value; out.textContent = fmt(v); r.style.setProperty('--v', (v - min) / (max - min) * 100 + '%'); onInput(v); });
    r.addEventListener('change', () => onCommit && onCommit('end'));
    return [h('span', {}, label), r, out];
  },
  switchEl(checked, onChange) {
    const i = h('input', { type: 'checkbox' }); i.checked = !!checked;
    i.addEventListener('change', () => onChange(i.checked));
    return h('label', { class: 'switch' }, i, h('span'));
  },
  seg(options, value, onPick) {
    const el = h('div', { class: 'seg' });
    options.forEach(([v, label]) => { const b = h('button', { class: v === value ? 'on' : '' }, label); b.onclick = () => { $$('button', el).forEach(x => x.classList.remove('on')); b.classList.add('on'); onPick(v); }; el.append(b); });
    return el;
  },

  /* ---------- track settings & effects ---------- */
  trackSheet(i) {
    const p = this.project, t = p.tracks[i];
    let editing = false;
    const commit = (ph, label) => { if (ph === 'start' && !editing) { this.beginEdit(label); editing = true; } if (ph === 'end') { editing = false; this.markDirty(); this.updateUndo(); } };
    const nameIn = h('input', { type: 'text', value: t.name, maxlength: 24, style: 'flex:1' });
    nameIn.addEventListener('change', () => this.edit('Rename track', () => { t.name = nameIn.value.trim() || `Track ${i + 1}`; }, { reschedule: false }) || this.renderHeads());
    nameIn.addEventListener('keydown', e => e.stopPropagation());
    const sw = h('div', { class: 'btns' }, ...TRACK_COLORS.map(c => h('button', { 'aria-label': 'Colour ' + c, style: `width:30px;height:30px;border-radius:50%;background:${c};box-shadow:${c === t.color ? '0 0 0 3px var(--panel2),0 0 0 5px ' + c : 'none'}`, onclick: () => { this.edit('Track colour', () => { t.color = c; }, { reschedule: false }); this.renderHeads(); this.trackSheet(i); } })));
    const fx = t.fx, upd = () => this.engine.updateMix();
    const db = v => (v > 0 ? '+' : '') + v.toFixed(0) + ' dB', pct = v => Math.round(v * 100) + '%';
    const grid = h('div', { class: 'fxgrid' },
      ...this.rangeRow('Volume', 0, 1, 0.01, t.vol, pct, v => { t.vol = v; upd(); }, ph => commit(ph, 'Volume')),
      ...this.rangeRow('Pan', -1, 1, 0.02, t.pan, v => Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100), v => { t.pan = v; upd(); }, ph => commit(ph, 'Pan')),
    );
    const eq = h('div', { class: 'fxgrid' },
      ...this.rangeRow('Low', -12, 12, 0.5, fx.low, db, v => { fx.low = v; upd(); }, ph => commit(ph, 'EQ')),
      ...this.rangeRow('Mid', -12, 12, 0.5, fx.mid, db, v => { fx.mid = v; upd(); }, ph => commit(ph, 'EQ')),
      ...this.rangeRow('High', -12, 12, 0.5, fx.high, db, v => { fx.high = v; upd(); }, ph => commit(ph, 'EQ')),
      ...this.rangeRow('Comp', 0, 1, 0.01, fx.comp, v => v === 0 ? 'Off' : pct(v), v => { fx.comp = v; upd(); }, ph => commit(ph, 'Compression')),
      ...this.rangeRow('Reverb', 0, 1, 0.01, fx.reverb, v => v === 0 ? 'Off' : pct(v), v => { fx.reverb = v; upd(); }, ph => commit(ph, 'Reverb')),
    );
    const body = h('div', {},
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('span', { class: 'lbl', style: 'flex:none;width:60px' }, 'Name'), nameIn),
        h('div', { class: 'row' }, h('span', { class: 'lbl', style: 'flex:none;width:60px' }, 'Colour'), sw),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Input channel', h('br'), h('small', {}, 'Use Left/Right to record two tracks at once from a stereo interface')),
          this.seg([['mix', 'Mix'], ['L', 'Left'], ['R', 'Right']], t.input, v => this.edit('Input channel', () => { t.input = v; }, { reschedule: false })))),
      h('h3', {}, 'Mix'), h('div', { class: 'card' }, grid),
      h('h3', {}, 'Effects'),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Low cut ', h('small', {}, '(removes rumble below 90 Hz)')), this.switchEl(fx.lowcut, v => this.edit('Low cut', () => { fx.lowcut = v; }, { reschedule: false }))),
        eq,
        h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { class: 'lbl' }, 'Reverb space ', h('small', {}, '(shared by all tracks)')),
          this.seg([['room', 'Room'], ['plate', 'Plate'], ['hall', 'Hall']], p.master.reverbSize, v => this.edit('Reverb space', () => { p.master.reverbSize = v; }, { reschedule: false })))),
      h('p', { class: 'muted', style: 'margin:4px 4px 0' }, 'Recordings are always stored dry. Effects are applied on playback and in exports, and are heard while recording only if input monitoring is on (Settings).'),
      h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn', onclick: () => { this.closeSheet(); this.exportStem(i); } }, 'Export track WAV'),
        h('button', { class: 'btn', onclick: () => { this.edit('Reset effects', () => { t.fx = { lowcut: false, low: 0, mid: 0, high: 0, comp: 0, reverb: 0 }; }, { reschedule: false }); this.trackSheet(i); } }, 'Reset effects')));
    this.openSheet(`Track ${i + 1} · ${t.name}`, body, () => this.renderHeads());
  },

  /* ---------- takes ---------- */
  takesSheet(clipId) {
    const p = this.project, c = findClip(p, clipId); if (!c) return;
    const list = h('div', { class: 'card' });
    const render = () => {
      const c2 = findClip(p, clipId); if (!c2) { this.closeSheet(); return; }
      list.innerHTML = '';
      c2.takes.forEach((t, idx) => {
        const row = h('div', { class: 'take' + (t.id === c2.active ? ' active' : '') },
          h('span', { class: 'radio' }),
          h('button', { class: 'tmain', onclick: () => { if (t.id !== c2.active) { this.edit('Select take', () => { c2.active = t.id; }); render(); } } },
            h('div', { class: 'tname2' }, t.name), h('div', { class: 'tmeta' }, `${fmtTime(t.length)} · ${new Date(t.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${t.complete === false ? ' · partial pass' : ''}`)),
          h('button', { class: 'icon-btn', 'aria-label': 'Listen', title: 'Listen from the start of this clip', onclick: async () => { if (t.id !== c2.active) { this.edit('Select take', () => { c2.active = t.id; }); render(); } if (this.engine.isRunning()) await this.engine.stop(); this.project.position = c2.start; this.play(); } }, h('span', { html: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M7 5v14l12-7z" fill="currentColor"/></svg>' })),
          h('button', { class: 'star' + (t.fav ? ' on' : ''), 'aria-label': 'Favourite', onclick: () => { this.edit('Favourite take', () => { t.fav = !t.fav; }, { reschedule: false }); render(); } }, t.fav ? '★' : '☆'),
          h('button', { class: 'icon-btn', 'aria-label': 'Take options', onclick: () => takeMenu(t) }, '⋯'));
        list.append(row);
      });
      $('#takeCount').textContent = c2.takes.length;
    };
    const takeMenu = t => {
      const menu = h('div', { class: 'card' },
        h('div', { class: 'btns', style: 'flex-direction:column;align-items:stretch' },
          h('button', { class: 'btn', onclick: async () => { const n = await this.prompt('Rename take', t.name); if (n) this.edit('Rename take', () => { t.name = n; }, { reschedule: false }); this.takesSheet(clipId); } }, 'Rename'),
          c.takes.length > 1 ? h('button', { class: 'btn', onclick: () => { const n = this.edit('Take to new clip', () => takeToNewClip(p, clipId, t.id)); this.closeSheet(); if (n) { this.tl.select(n.id); this.toast('Moved to its own clip — it sits on top where it overlaps.'); } } }, 'Move to its own clip') : null,
          h('button', { class: 'btn', onclick: () => { this.downloadTake(t); } }, 'Download original WAV'),
          h('button', { class: 'btn danger', onclick: async () => { if (await this.confirm(`Delete "${t.name}"? ${c.takes.length === 1 ? 'This is the only take, so the clip will be removed.' : 'Other takes are kept.'} You can undo this.`, 'Delete take', true)) { this.edit('Delete take', () => deleteTake(p, clipId, t.id)); if (findClip(p, clipId)) this.takesSheet(clipId); else this.tl.select(null); } } }, 'Delete take')),
        h('div', { class: 'sheet-actions' }, h('button', { class: 'btn', onclick: () => this.takesSheet(clipId) }, 'Back')));
      this.openSheet(t.name, menu);
    };
    const body = h('div', {},
      h('p', { class: 'muted', style: 'margin:0 4px 10px' }, 'Tap a take to make it the one that plays. Record over the same section again (or loop-record) to add more takes — nothing is ever overwritten.'),
      list,
      h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn', onclick: () => { this.closeSheet(); this.clipAction('split'); } }, 'Split at playhead'),
        h('button', { class: 'btn', onclick: () => { this.closeSheet(); this.clipAction('repeat'); } }, 'Repeat'),
        h('button', { class: 'btn danger', onclick: () => { this.closeSheet(); this.clipAction('delete'); } }, 'Delete clip')));
    render();
    this.openSheet(`Takes · ${p.tracks[c.track].name} · ${fmtTime(c.start)}`, body);
  },
  async downloadTake(t) {
    const rec = await Store.getAudio(t.audioId);
    if (!rec) { this.toast('That recording is missing from storage.', { err: true }); return; }
    const blob = new Blob([encodeWav([new Float32Array(rec.data)], rec.sr, 24)], { type: 'audio/wav' });
    saveOrShare(blob, safeFileName(`${this.project.name} - ${t.name}`) + '.wav', this.settings.shareExports);
  },

  /* ---------- tempo / metronome ---------- */
  tempoSheet() {
    const p = this.project;
    let editing = false;
    const commit = (ph, l) => { if (ph === 'start' && !editing) { this.beginEdit(l); editing = true; } if (ph === 'end') { editing = false; this.markDirty(); this.updateUndo(); this.engine.retime(); } };
    const bpmIn = h('input', { type: 'number', min: 30, max: 300, step: 1, value: Math.round(p.bpm) });
    const setBpm = v => { v = clamp(Math.round(v * 10) / 10, 30, 300); this.edit('Tempo', () => { p.bpm = v; }, { retime: true }); bpmIn.value = Math.round(v); tapOut.textContent = '— tap —'; };
    bpmIn.addEventListener('change', () => setBpm(+bpmIn.value || p.bpm));
    bpmIn.addEventListener('keydown', e => e.stopPropagation());
    const tapOut = h('b', {}, '—');
    const tapPad = h('button', { class: 'tap-pad', onpointerdown: e => { e.preventDefault(); const v = this.tap.tap(); if (v) { tapOut.textContent = v; tapPad._v = v; } } }, tapOut, 'TAP');
    const body = h('div', {},
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Tempo (BPM)'),
          h('div', { class: 'bignum' }, h('button', { class: 'btn small', onclick: () => setBpm(p.bpm - 1) }, '−'), bpmIn, h('button', { class: 'btn small', onclick: () => setBpm(p.bpm + 1) }, '＋'))),
        h('div', { style: 'margin:10px 0 4px' }, tapPad),
        h('div', { class: 'btns', style: 'justify-content:flex-end' }, h('button', { class: 'btn primary small', onclick: () => { if (tapPad._v) setBpm(tapPad._v); else this.toast('Tap the pad in time first.'); } }, 'Use tapped tempo')),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Time signature'),
          this.seg([['2/4', '2/4'], ['3/4', '3/4'], ['4/4', '4/4'], ['5/4', '5/4'], ['6/8', '6/8'], ['7/8', '7/8'], ['12/8', '12/8']], `${p.tsNum}/${p.tsDen}`, v => { const [n, d] = v.split('/').map(Number); this.edit('Time signature', () => { p.tsNum = n; p.tsDen = d; }, { retime: true }); }))),
      h('p', { class: 'muted', style: 'margin:0 4px 6px' }, 'Changing tempo moves the grid, click and drums. Recorded audio keeps its original timing.'),
      h('h3', {}, 'Metronome'),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Click on'), this.switchEl(p.click.on, v => this.edit('Click', () => { p.click.on = v; }, { reschedule: false }))),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Click during playback', h('br'), h('small', {}, 'Off = click only while recording')), this.switchEl(p.click.duringPlay, v => this.edit('Click during playback', () => { p.click.duringPlay = v; }, { reschedule: false }))),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Sound'), this.seg([['wood', 'Wood'], ['beep', 'Beep'], ['tick', 'Tick']], p.click.sound, v => { this.edit('Click sound', () => { p.click.sound = v; }, { reschedule: false }); this.previewClick(); })),
        h('div', { class: 'fxgrid', style: 'margin-top:6px' }, ...this.rangeRow('Volume', 0, 1, 0.01, p.click.vol, v => Math.round(v * 100) + '%', v => { p.click.vol = v; }, ph => { commit(ph, 'Click volume'); if (ph === 'end') this.previewClick(); })),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Count-in before recording'), this.seg([[0, 'Off'], [1, '1 bar'], [2, '2 bars']], p.click.countIn, v => this.edit('Count-in', () => { p.click.countIn = v; }, { reschedule: false })))));
    this.openSheet('Tempo & metronome', body, () => this.renderDeck());
  },
  async previewClick() {
    await this.unlockAudio(); const e = this.engine, c = e.ctx, p = this.project;
    for (let i = 0; i < p.tsNum; i++) Synth.click(c, e.clickBus, c.currentTime + 0.05 + i * beatDur(p), i === 0, p.click.sound, p.click.vol);
  },

  /* ---------- drums ---------- */
  drumsSheet() { this.openSheet('Drum machine', this.drumsCard(true), () => this.renderDeck()); },
  drumsCard(inSheet) {
    const p = this.project;
    const grid = h('div', { class: 'pat-grid' });
    Object.entries(Synth.PATTERNS).forEach(([k, v]) => { const b = h('button', { class: p.drums.pattern === k ? 'on' : '' }, v.name); b.onclick = () => { this.edit('Drum pattern', () => { p.drums.pattern = k; if (!p.drums.on) p.drums.on = true; }, { reschedule: false }); this.engine.retime(); $$('button', grid).forEach(x => x.classList.remove('on')); b.classList.add('on'); onSw.checked = true; this.renderDeck(); }; grid.append(b); });
    const sw = this.switchEl(p.drums.on, v => { this.edit('Drums', () => { p.drums.on = v; }, { reschedule: false }); this.engine.retime(); this.renderDeck(); });
    const onSw = $('input', sw);
    let editing = false;
    return h('div', {},
      h('div', { class: inSheet ? '' : 'card' },
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Drums on', h('br'), h('small', {}, `Follows the project tempo (${Math.round(p.bpm)} BPM, ${p.tsNum}/${p.tsDen}) and plays with the transport`)), sw),
        h('div', { style: 'margin:8px 0' }, grid),
        h('div', { class: 'fxgrid' }, ...this.rangeRow('Volume', 0, 1, 0.01, p.drums.vol, v => Math.round(v * 100) + '%', v => { p.drums.vol = v; this.engine.updateMix(); }, ph => { if (ph === 'start' && !editing) { this.beginEdit('Drum volume'); editing = true; } if (ph === 'end') { editing = false; this.markDirty(); this.updateUndo(); } })),
        h('div', { class: 'btns', style: 'margin-top:10px' },
          h('button', { class: 'btn', onclick: () => this.engine.isRunning() ? this.pause() : this.play() }, 'Play / pause'),
          h('span', { class: 'muted', style: 'align-self:center' }, 'Drums don\'t use one of your four tracks, and can be included in exports.'))));
  },

  /* ---------- markers ---------- */
  async openMarker(id) {
    const p = this.project, m = p.markers.find(x => x.id === id); if (!m) return;
    const body = h('div', {},
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'lbl' }, `At ${fmtTime(m.t)}`))),
      h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn danger', onclick: () => { this.edit('Delete marker', () => { p.markers = p.markers.filter(x => x.id !== id); }, { reschedule: false }); this.closeSheet(); } }, 'Delete'),
        h('button', { class: 'btn', onclick: async () => { const n = await this.prompt('Rename marker', m.name); if (n) this.edit('Rename marker', () => { m.name = n; }, { reschedule: false }); } }, 'Rename'),
        h('button', { class: 'btn', onclick: () => { this.edit('Move marker', () => { m.t = this.project.position; p.markers.sort((a, b) => a.t - b.t); }, { reschedule: false }); this.closeSheet(); } }, 'Move to playhead'),
        h('button', { class: 'btn primary', onclick: () => { this.closeSheet(); this.seek(m.t); } }, 'Go to')));
    this.openSheet('Marker · ' + m.name, body);
  },

  /* ---------- notes ---------- */
  notesSheet() {
    const p = this.project;
    const ta = h('textarea', { rows: 14, placeholder: 'Lyrics, chords, arrangement ideas, overdub reminders…' });
    ta.value = p.notes || '';
    ta.addEventListener('keydown', e => e.stopPropagation());
    ta.addEventListener('input', () => { p.notes = ta.value; this.markDirty(); });
    this.openSheet('Song notes', h('div', {}, ta, h('p', { class: 'muted' }, 'Saved automatically with the project and included in backups.')));
  },

  /* ---------- project menu ---------- */
  projectMenu() {
    const p = this.project;
    const b = (label, fn, cls = 'btn') => h('button', { class: cls, style: 'justify-content:flex-start', onclick: () => { this.closeSheet(); fn(); } }, label);
    const body = h('div', {},
      h('div', { class: 'card' }, h('div', { class: 'muted' }, `Created ${fmtDate(p.created)} · ${p.clips.length} clip${p.clips.length === 1 ? '' : 's'} · ${fmtTime(contentEnd(p), false)} long`)),
      h('div', { class: 'btns', style: 'flex-direction:column;align-items:stretch' },
        b('Rename project', () => this.renameProject(p.id)),
        b('New project', () => this.createProject()),
        b('All projects…', () => this.showView('projects')),
        b('Song notes', () => this.notesSheet()),
        b('Export audio & backup…', () => this.exportSheet()),
        b('Duplicate project', () => this.duplicate(p.id))));
    this.openSheet(p.name, body);
  },
  async renameProject(id) {
    const cur = id === this.project.id ? this.project : await Store.getProject(id);
    const n = await this.prompt('Rename project', cur.name); if (!n) return;
    if (id === this.project.id) { this.edit('Rename project', () => { this.project.name = n; }, { reschedule: false }); $('#projName').textContent = n; document.title = n + ' — Pocket Four-Track'; await this.flushSave(); }
    else { cur.name = n; cur.modified = Date.now(); await Store.saveProject(cur); }
    if (this.view === 'projects') this.renderView('projects');
  },
  async duplicate(id) {
    await this.flushSave();
    try { const src = await Store.getProject(id); const d = await duplicateProject(normalizeProject(src)); this.toast(`Duplicated as "${d.name}"`, { action: { label: 'Open', fn: () => this.openProject(d.id) } }); if (this.view === 'projects') this.renderView('projects'); }
    catch (e) { this.toast('Could not duplicate: ' + e.message, { err: true }); }
  },
  async deleteProject(id) {
    const p = await Store.getProject(id); if (!p) return;
    if (!(await this.confirm(`Delete "${p.name}" and all of its recordings from this device? This cannot be undone. Export a backup first if you might want it later.`, 'Delete project', true))) return;
    try {
      if (this.project && this.project.id === id) { if (this.engine.isRunning()) await this.stop(); }
      await Store.deleteProject(id);
      this.toast(`Deleted "${p.name}"`);
      if (this.project.id === id) { const rest = (await Store.listProjects()).sort((a, b) => (b.opened || 0) - (a.opened || 0)); if (rest[0]) await this.openProject(rest[0].id); else await this.createProject(); }
      this.renderView('projects');
    } catch (e) { this.toast('Delete failed: ' + e.message, { err: true }); }
  },

  /* ---------- export ---------- */
  exportSheet() {
    const p = this.project;
    const st = { fmt: 'wav24', drums: p.drums.on };
    const body = h('div', {},
      h('h3', { style: 'margin-top:4px' }, 'Full mix'),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Format'), this.seg([['wav16', 'WAV 16'], ['wav24', 'WAV 24'], ['wav32', 'WAV 32f'], ['mp3', 'MP3']], st.fmt, v => st.fmt = v)),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Include drum machine'), this.switchEl(st.drums, v => st.drums = v)),
        h('div', { class: 'btns', style: 'margin-top:8px' }, h('button', { class: 'btn primary', onclick: e => this.exportMix(st, e.currentTarget) }, 'Export mix'))),
      h('h3', {}, 'Stems'),
      h('div', { class: 'card' },
        h('p', { class: 'muted', style: 'margin:0 0 8px' }, 'Each track rendered from 0:00 to the same end point, with its volume, pan and effects — drop them into any DAW and they line up.'),
        h('div', { class: 'btns' },
          h('button', { class: 'btn primary', onclick: e => this.exportStems(st, e.currentTarget) }, 'All stems (.zip)'),
          ...p.tracks.map((t, i) => h('button', { class: 'btn small', onclick: () => this.exportStem(i) }, `${i + 1} · ${t.name}`)))),
      h('h3', {}, 'Project backup'),
      h('div', { class: 'card' },
        h('p', { class: 'muted', style: 'margin:0 0 8px' }, 'One .zip with every original recording and take (as WAV), the arrangement, settings and notes. Keep it somewhere safe — it\'s how you move projects between devices or recover them if browser storage is cleared.'),
        h('div', { class: 'btns' }, h('button', { class: 'btn primary', onclick: e => this.exportBackup(p.id, e.currentTarget) }, 'Export backup'))),
      'canShare' in navigator ? h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Use the share sheet instead of downloading', h('br'), h('small', {}, 'Handy on iPhone/iPad to save into Files')), this.switchEl(this.settings.shareExports, v => { this.settings.shareExports = v; this.saveSettings(); }))) : null);
    this.openSheet('Export', body);
  },
  async busy(btn, label, fn) {
    const old = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = label; }
    try { return await fn(); }
    catch (e) { this.toast(e.message, { err: true, ms: 8000 }); }
    finally { if (btn) { btn.disabled = false; btn.textContent = old; } }
  },
  async exportMix(st, btn) {
    const p = this.project;
    if (!contentEnd(p)) { this.toast('Nothing recorded yet.'); return; }
    await this.busy(btn, 'Rendering…', async () => {
      await this.engine.init();
      const buf = await renderMix(this.engine, p, st.drums);
      let peak = 0; for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > peak) peak = v; } }
      let blob, ext;
      if (st.fmt === 'mp3') { btn && (btn.textContent = 'Encoding MP3…'); blob = await bufferToMp3(buf, 192); ext = 'mp3'; }
      else { blob = new Blob([bufferToWav(buf, { wav16: 16, wav24: 24, wav32: 32 }[st.fmt])], { type: 'audio/wav' }); ext = 'wav'; }
      await saveOrShare(blob, `${safeFileName(p.name)} - mix.${ext}`, this.settings.shareExports);
      this.toast(`Mix exported · ${fmtTime(buf.duration)} · ${fmtBytes(blob.size)}`);
      if (peak > 1) this.toast(`The mix peaks ${(20 * Math.log10(peak)).toFixed(1)} dB over full scale, so loud moments are clipped. Lower track volumes and export again.`, { err: true, ms: 9000 });
    });
  },
  async exportStem(i) {
    const p = this.project;
    if (!p.clips.some(c => c.track === i)) { this.toast('That track is empty.'); return; }
    await this.busy(null, '', async () => {
      await this.engine.init();
      const buf = await renderStem(this.engine, p, i, exportEnd(p));
      await saveOrShare(new Blob([bufferToWav(buf, 24)], { type: 'audio/wav' }), `${safeFileName(p.name)} - ${i + 1} ${safeFileName(p.tracks[i].name)}.wav`, this.settings.shareExports);
      this.toast(`Track ${i + 1} exported`);
    });
  },
  async exportStems(st, btn) {
    const p = this.project;
    if (!contentEnd(p)) { this.toast('Nothing recorded yet.'); return; }
    await this.busy(btn, 'Rendering…', async () => {
      await this.engine.init();
      const end = exportEnd(p), files = [], clippedStems = new Set();
      for (let i = 0; i < 4; i++) {
        if (!p.clips.some(c => c.track === i)) continue;
        const buf = await renderStem(this.engine, p, i, end);
        for (let c = 0; c < buf.numberOfChannels; c++) if (buf.getChannelData(c).some(v => v > 1 || v < -1)) { clippedStems.add(p.tracks[i].name); break; }
        files.push({ name: `${i + 1} ${safeFileName(p.tracks[i].name)}.wav`, data: new Uint8Array(bufferToWav(buf, 24)) });
      }
      if (st.drums && p.drums.on) { const d = await renderDrumStem(this.engine, p, end); files.push({ name: '5 Drums.wav', data: new Uint8Array(bufferToWav(d, 24)) }); }
      files.push({ name: 'README.txt', data: `Stems from "${p.name}" — Pocket Four-Track\nAll files start at 0:00 and are ${fmtTime(end)} long (${Math.ceil(end * this.engine.sampleRate)} samples @ ${this.engine.sampleRate} Hz).\nTempo ${p.bpm} BPM, ${p.tsNum}/${p.tsDen}. Import them at the start of a session and they line up.\n` });
      const zip = zipStore(files);
      await saveOrShare(zip, `${safeFileName(p.name)} - stems.zip`, this.settings.shareExports);
      this.toast(`${files.length - 1} stems exported · ${fmtBytes(zip.size)}`);
      if (clippedStems.size) this.toast(`${[...clippedStems].join(', ')} peak${clippedStems.size > 1 ? '' : 's'} over full scale and will clip. Lower the volume, EQ boost or compression on ${clippedStems.size > 1 ? 'those tracks' : 'that track'}.`, { err: true, ms: 9000 });
    });
  },
  async exportBackup(id, btn) {
    await this.flushSave();
    await this.busy(btn, 'Packing…', async () => {
      const p = id === this.project.id ? this.project : normalizeProject(await Store.getProject(id));
      const zip = await exportProjectPackage(p);
      await saveOrShare(zip, `${safeFileName(p.name)}.4track.zip`, this.settings.shareExports);
      p.lastBackup = Date.now();
      if (id === this.project.id) { this.markDirty(false); await this.flushSave(); } else await Store.saveProject(p);
      this.toast(`Backup exported · ${fmtBytes(zip.size)}`);
      if (this.view === 'projects') this.renderView('projects');
    });
  },
  async importBackup(file) {
    let pkg;
    try { pkg = await readProjectPackage(await file.arrayBuffer()); }
    catch (e) { this.toast(e.message, { err: true, ms: 9000 }); return; }
    const existing = await Store.getProject(pkg.project.id);
    const doImport = async (mode, name) => {
      try {
        const p = await importProjectPackage(pkg, mode, name);
        this.toast(`Imported "${p.name}"` + (pkg.problems.length ? ` — ${pkg.problems.length} recording(s) were missing or damaged and were skipped` : ''), { err: pkg.problems.length > 0, ms: 6000 });
        await this.openProject(p.id); this.showView('studio');
      } catch (e) { this.toast('Import failed: ' + e.message, { err: true, ms: 9000 }); }
    };
    const nameIn = h('input', { type: 'text', value: existing ? pkg.project.name + ' (imported)' : pkg.project.name, style: 'width:100%' });
    nameIn.addEventListener('keydown', e => e.stopPropagation());
    const nTakes = pkg.project.clips.reduce((s, c) => s + c.takes.length, 0);
    const body = h('div', {},
      h('div', { class: 'card' },
        h('div', { style: 'font-weight:650' }, pkg.project.name),
        h('div', { class: 'muted' }, `${pkg.project.clips.length} clips · ${nTakes} takes · ${pkg.audio.size} recordings · exported ${pkg.manifest.exported ? fmtDate(pkg.manifest.exported) : '?'}`),
        pkg.problems.length ? h('div', { class: 'note-box' }, `${pkg.problems.length} recording(s) in this backup are missing or damaged and will be skipped.`) : null),
      existing ? h('div', { class: 'note-box' }, `You already have this project ("${existing.name}", modified ${fmtDate(existing.modified)}). Import it as a separate copy, or replace the one on this device.`) : null,
      h('div', { class: 'row' }, h('span', { class: 'lbl', style: 'flex:none' }, 'Name'), nameIn),
      h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn', onclick: () => this.closeSheet() }, 'Cancel'),
        existing ? h('button', { class: 'btn danger', onclick: async () => { if (await this.confirm(`Replace "${existing.name}" on this device with the backup? The current version and its recordings will be deleted.`, 'Replace', true)) doImport('replace', nameIn.value.trim()); } }, 'Replace existing') : null,
        h('button', { class: 'btn primary', onclick: () => { this.closeSheet(); doImport(existing ? 'copy' : 'replace', nameIn.value.trim()); } }, existing ? 'Import as copy' : 'Import')));
    this.openSheet('Import backup', body);
  },

  /* ---------- recovery ---------- */
  async checkRecovery() {
    let metas = [];
    try { metas = await Store.listJournals(); } catch (_) { return; }
    for (const meta of metas) {
      const proj = await Store.getProject(meta.projectId);
      const rows = await Store.readJournal(meta.recId);
      const frames = rows.reduce((s, r) => s + r.l.byteLength / 4, 0);
      if (!proj || frames < meta.sr * 0.2) { await Store.clearJournal(meta.recId); continue; }
      const ok = await this.confirm(`An unfinished recording was found: ${fmtTime(frames / meta.sr)} on ${meta.tracks.map(t => proj.tracks[t.track].name).join(' + ')} in "${proj.name}" (${fmtDate(meta.startedAt)}). The app may have closed while recording. Recover it as a new take?`, 'Recover take');
      if (ok) {
        try {
          if (this.project.id !== proj.id) await this.openProject(proj.id);
          const res = await recoverJournal(meta);
          res.recId = meta.recId; res.sr = meta.sr;
          await this.handleRecording(res);
        } catch (e) { this.toast('Recovery failed: ' + e.message, { err: true }); }
      } else if (await this.confirm('Discard the unfinished recording permanently?', 'Discard', true)) await Store.clearJournal(meta.recId);
    }
  },

  /* ================= views ================= */
  bindTabs() { $$('#tabs button').forEach(b => b.onclick = () => this.showView(b.dataset.view)); },
  showView(v) {
    if (this.view === 'tools' && v !== 'tools') this.tuner.stop();
    this.view = v;
    $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    $$('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
    if (v === 'studio') { this.tl.resize(); this.tl.dirty = true; } else this.renderView(v);
  },
  renderView(v) { if (v === 'projects') this.renderProjects(); else if (v === 'tools') this.renderTools(); else if (v === 'settings') this.renderSettings(); },
  renderSettingsIfOpen() { if (this.view === 'settings') this.renderSettings(); },

  async renderProjects() {
    const host = $('#view-projects');
    const q = this._pq || '', sort = this._psort || 'recent';
    await this.flushSave();
    let all = await Store.listProjects();
    const search = h('input', { type: 'search', placeholder: 'Search projects', value: q });
    search.addEventListener('input', () => { this._pq = search.value; draw(); });
    search.addEventListener('keydown', e => e.stopPropagation());
    const sortSel = h('select', {}, ...[['recent', 'Recently opened'], ['modified', 'Last modified'], ['name', 'Name']].map(([v, l]) => { const o = h('option', { value: v }, l); if (v === sort) o.selected = true; return o; }));
    sortSel.addEventListener('change', () => { this._psort = sortSel.value; draw(); });
    const list = h('div');
    const draw = () => {
      const qq = (this._pq || '').toLowerCase(), s = this._psort || 'recent';
      const items = all.filter(p => !qq || p.name.toLowerCase().includes(qq) || (p.notes || '').toLowerCase().includes(qq))
        .sort((a, b) => s === 'name' ? a.name.localeCompare(b.name) : s === 'modified' ? b.modified - a.modified : (b.opened || 0) - (a.opened || 0));
      list.innerHTML = '';
      if (!items.length) list.append(h('p', { class: 'muted', style: 'text-align:center;padding:30px' }, qq ? 'No projects match.' : 'No projects yet.'));
      for (const p of items) {
        const takes = (p.clips || []).reduce((n, c) => n + c.takes.length, 0), len = (p.clips || []).reduce((m, c) => Math.max(m, c.end), 0);
        const needsBackup = takes > 0 && (!p.lastBackup || p.modified > p.lastBackup + 1000);
        list.append(h('div', { class: 'pitem' + (p.id === this.project.id ? ' current' : '') },
          h('div', { class: 'cassette' }),
          h('button', { class: 'pmain', onclick: async () => { await this.openProject(p.id); this.showView('studio'); } },
            h('div', { class: 'pname' }, p.name),
            h('div', { class: 'pmeta' }, `${fmtTime(len, false)} · ${takes} take${takes === 1 ? '' : 's'} · ${fmtDate(p.modified)}`, needsBackup ? h('span', { style: 'color:#d9a050' }, ' · not backed up') : null)),
          h('button', { class: 'icon-btn', 'aria-label': 'Project actions', onclick: () => this.projectActions(p) }, '⋯')));
      }
    };
    const est = await Store.estimate(), persisted = await Store.persisted();
    host.innerHTML = '';
    host.append(h('div', { class: 'page' },
      h('h1', {}, 'Projects'),
      h('div', { class: 'btns', style: 'margin-bottom:12px' },
        h('button', { class: 'btn primary', onclick: async () => { await this.createProject(); this.showView('studio'); } }, '＋ New project'),
        h('button', { class: 'btn', onclick: () => $('#fileImport').click() }, 'Import backup…')),
      h('div', { class: 'plist-tools' }, search, sortSel),
      list,
      h('h3', {}, 'Storage on this device'),
      h('div', { class: 'card' },
        est ? [h('div', { class: 'muted' }, `${fmtBytes(est.usage)} used of ${fmtBytes(est.quota)} available to this app`), h('div', { class: 'storage-bar' }, h('i', { style: `width:${Math.min(100, est.usage / est.quota * 100).toFixed(1)}%` }))] : h('div', { class: 'muted' }, 'This browser does not report storage usage.'),
        h('p', { class: 'muted', style: 'margin:6px 0 0' }, persisted ? 'Storage is marked persistent — the browser will not clear it automatically.' : 'Browsers can clear website storage when space runs low. Export backups of projects you care about.'),
        persisted === false ? h('div', { class: 'btns', style: 'margin-top:8px' }, h('button', { class: 'btn small', onclick: async () => { const r = await Store.persist(); this.toast(r ? 'Storage is now persistent.' : 'The browser declined. Installing the app to your home screen or bookmarking it can help.'); this.renderProjects(); } }, 'Ask to keep storage')) : null)));
    draw();
  },
  projectActions(p) {
    const b = (label, fn, cls = 'btn') => h('button', { class: cls, style: 'justify-content:flex-start', onclick: () => { this.closeSheet(); fn(); } }, label);
    this.openSheet(p.name, h('div', { class: 'btns', style: 'flex-direction:column;align-items:stretch' },
      b('Open', async () => { await this.openProject(p.id); this.showView('studio'); }),
      b('Rename', () => this.renameProject(p.id)),
      b('Duplicate', () => this.duplicate(p.id)),
      b('Export backup', () => this.exportBackup(p.id)),
      b('Delete', () => this.deleteProject(p.id), 'btn danger')));
  },

  renderTools() {
    const host = $('#view-tools'), p = this.project;
    const note = h('div', { class: 'tuner-note' }, '–'), freq = h('div', { class: 'tuner-freq' }, 'Tap Start and play a single note');
    const needle = h('div', { class: 'tuner-needle' }), state = h('div', { class: 'tuner-state' });
    const startBtn = h('button', { class: 'btn primary' }, 'Start tuner');
    let on = false;
    startBtn.onclick = async () => {
      if (on) { this.tuner.stop(); on = false; startBtn.textContent = 'Start tuner'; freq.textContent = 'Stopped'; return; }
      await this.unlockAudio();
      try {
        this.tuner.a4 = this.settings.a4;
        await this.tuner.start(r => {
          if (!r.freq) { state.textContent = r.level > 0.008 ? '…' : ''; needle.style.opacity = .25; return; }
          needle.style.opacity = 1;
          const c = clamp(r.cents, -50, 50);
          note.innerHTML = `${r.name}<sup>${r.octave}</sup>`;
          note.classList.toggle('in', Math.abs(r.cents) < 5);
          freq.textContent = `${r.freq.toFixed(1)} Hz · ${r.cents >= 0 ? '+' : ''}${r.cents.toFixed(0)} cents`;
          needle.style.left = `calc(${50 + c}% - 2px)`;
          state.textContent = Math.abs(r.cents) < 5 ? 'IN TUNE' : r.cents < 0 ? '♭ FLAT — tune up' : '♯ SHARP — tune down';
          state.style.color = Math.abs(r.cents) < 5 ? 'var(--green)' : 'var(--amber)';
        });
        on = true; startBtn.textContent = 'Stop tuner';
      } catch (e) { this.toast(e.message, { err: true }); }
    };
    const a4 = h('input', { type: 'number', min: 415, max: 466, step: 1, value: this.settings.a4, style: 'width:80px' });
    a4.addEventListener('change', () => { this.settings.a4 = clamp(+a4.value || 440, 415, 466); this.tuner.a4 = this.settings.a4; this.saveSettings(); });
    a4.addEventListener('keydown', e => e.stopPropagation());
    const tapOut = h('b', {}, '—'); let tapped = null;
    const tap = h('button', { class: 'tap-pad', onpointerdown: e => { e.preventDefault(); const v = this.tap.tap(); if (v) { tapped = v; tapOut.textContent = v; } } }, tapOut, 'TAP TEMPO');
    host.innerHTML = '';
    host.append(h('div', { class: 'page' },
      h('h1', {}, 'Tools'),
      h('h3', {}, 'Tuner'),
      h('div', { class: 'card' },
        h('div', { class: 'tuner' }, note, freq,
          h('div', { class: 'tuner-meter' }, h('div', { class: 'tuner-scale' }), h('div', { class: 'tuner-center' }), needle, h('div', { class: 'tuner-labels' }, h('span', {}, '−50'), h('span', {}, '0'), h('span', {}, '+50'))),
          state),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Reference A4 (Hz)'), a4, startBtn)),
      h('h3', {}, 'Tap tempo'),
      h('div', { class: 'card' }, tap,
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, `Project tempo: ${Math.round(p.bpm)} BPM`),
          h('button', { class: 'btn primary small', onclick: () => { if (!tapped) { this.toast('Tap the pad in time first.'); return; } this.edit('Tempo', () => { p.bpm = tapped; }, { retime: true }); this.renderDeck(); this.renderTools(); this.toast(`Tempo set to ${tapped} BPM`); } }, 'Set project tempo'))),
      h('h3', {}, 'Metronome'),
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'lbl' }, `${p.click.on ? 'On' : 'Off'} · ${Math.round(p.bpm)} BPM · ${p.tsNum}/${p.tsDen} · count-in ${p.click.countIn ? p.click.countIn + ' bar' + (p.click.countIn > 1 ? 's' : '') : 'off'}`), h('button', { class: 'btn small', onclick: () => this.tempoSheet() }, 'Metronome settings'))),
      h('h3', {}, 'Drum machine'),
      this.drumsCard(false)));
  },

  async renderSettings() {
    const host = $('#view-settings'), s = this.settings, e = this.engine;
    let dev = { inputs: [], outputs: [] };
    try { dev = await e.listDevices(); } catch (_) { }
    const hasLabels = dev.inputs.some(d => d.label);
    const inSel = h('select', { style: 'max-width:60%' }, h('option', { value: '' }, 'Default input'), ...dev.inputs.filter(d => d.deviceId && d.deviceId !== 'default').map((d, i) => { const o = h('option', { value: d.deviceId }, d.label || `Input ${i + 1}`); if (d.deviceId === s.inputDevice) o.selected = true; return o; }));
    inSel.onchange = async () => { s.inputDevice = inSel.value; e.settings.inputDevice = s.inputDevice; this.saveSettings(); try { await e.reopenInput(); this.toast('Input: ' + (inSel.selectedOptions[0].textContent)); } catch (er) { this.toast(er.message, { err: true }); } };
    const outSel = h('select', { style: 'max-width:60%' }, h('option', { value: '' }, 'Default output'), ...dev.outputs.filter(d => d.deviceId && d.deviceId !== 'default').map((d, i) => { const o = h('option', { value: d.deviceId }, d.label || `Output ${i + 1}`); if (d.deviceId === s.outputDevice) o.selected = true; return o; }));
    outSel.onchange = async () => { s.outputDevice = outSel.value; this.saveSettings(); try { await e.init(); await e.setOutputDevice(s.outputDevice); } catch (er) { this.toast('Could not switch output: ' + er.message, { err: true }); } };
    const latOut = h('b', {}, '—');
    const showLat = () => { latOut.textContent = e.ctx ? Math.round(e.inputLatency() * 1000) + ' ms' : '—'; };
    const manIn = h('input', { type: 'number', min: 0, max: 1000, step: 1, value: s.latencyMs, style: 'width:90px' });
    manIn.addEventListener('keydown', ev => ev.stopPropagation());
    manIn.onchange = () => { s.latencyMs = clamp(+manIn.value || 0, 0, 1000); s.latencyMode = 'manual'; Object.assign(e.settings, s); this.saveSettings(); showLat(); this.renderSettings(); };
    const calBtn = h('button', { class: 'btn primary small' }, 'Calibrate');
    calBtn.onclick = () => this.busy(calBtn, 'Listening…', async () => {
      await this.unlockAudio();
      const ms = await calibrateLatency(e);
      s.latencyMs = ms; s.latencyMode = 'manual'; Object.assign(e.settings, s); this.saveSettings();
      this.toast(`Measured round-trip latency: ${ms} ms. Overdubs will be shifted by this amount.`, { ms: 6000 });
      this.renderSettings();
    });
    const monGain = h('div', { class: 'fxgrid' }, ...this.rangeRow('Level', 0, 1, 0.01, s.monitorGain, v => Math.round(v * 100) + '%', v => { s.monitorGain = v; e.settings.monitorGain = v; e.setMonitor(s.monitor); }, ph => ph === 'end' && this.saveSettings()));
    const est = await Store.estimate();
    host.innerHTML = '';
    host.append(h('div', { class: 'page' },
      h('h1', {}, 'Settings'),
      h('h3', {}, 'Audio input'),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Status'), h('span', { class: 'muted' }, e.stream ? '● ' + (e.stream.getAudioTracks()[0]?.label || 'Microphone open') : 'Not open yet'),
          e.stream ? null : h('button', { class: 'btn small', onclick: async () => { await this.unlockAudio(); try { await e.ensureInput(); this.renderSettings(); } catch (er) { this.toast(er.message, { err: true, ms: 8000 }); } } }, 'Allow microphone')),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Input device'), inSel),
        !hasLabels ? h('p', { class: 'muted', style: 'margin:4px 0' }, 'Device names appear after you allow microphone access.') : null,
        h('p', { class: 'muted', style: 'margin:6px 0 2px' }, 'Recording is raw and uncompressed: echo cancellation, noise suppression and auto-gain are switched off so your instrument sounds natural. Set the level on your interface or move the mic so the IN meter peaks in the yellow, never red.')),
      h('h3', {}, 'Audio output'),
      h('div', { class: 'card' },
        e.canSelectOutput() ? h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Output device'), outSel) : h('p', { class: 'muted', style: 'margin:0' }, 'This browser plays through the system output. Change it in your device\'s sound settings.'),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Sample rate'), h('span', { class: 'muted' }, e.ctx ? e.ctx.sampleRate + ' Hz' : 'set by your device'))),
      h('h3', {}, 'Monitoring'),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Hear input through the app', h('br'), h('small', {}, 'Through the armed track\'s effects')), this.switchEl(s.monitor, v => { s.monitor = v; e.setMonitor(v); this.saveSettings(); if (v) this.toast('Use headphones — monitoring through speakers causes feedback.', { err: true, ms: 6000 }); })),
        monGain,
        h('p', { class: 'muted', style: 'margin:6px 0 0' }, 'Browser monitoring adds a small delay. If your interface has direct (zero-latency) monitoring, use that and leave this off.')),
      h('h3', {}, 'Overdub timing (latency)'),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Compensation in use'), latOut),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Mode'), this.seg([['auto', 'Automatic'], ['manual', 'Measured / manual']], s.latencyMode, v => { s.latencyMode = v; Object.assign(e.settings, s); this.saveSettings(); showLat(); })),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Manual value (ms)'), manIn),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Measure it', h('br'), h('small', {}, 'Unplug headphones, turn the volume up, hold the phone/mic near the speaker. Eight clicks play and are timed.')), calBtn),
        h('p', { class: 'muted', style: 'margin:6px 0 0' }, 'If overdubs sound late, calibrate or raise the value; if early, lower it. Bluetooth headphones add a lot of delay — wired headphones are best for overdubbing.')),
      h('h3', {}, 'Device'),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Keep screen awake while playing/recording', h('br'), h('small', {}, 'wakeLock' in navigator ? 'Supported here' : 'Not supported by this browser')), this.switchEl(s.wakeLock, v => { s.wakeLock = v; this.saveSettings(); })),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Storage used'), h('span', { class: 'muted' }, est ? `${fmtBytes(est.usage)} of ${fmtBytes(est.quota)}` : 'unknown'))),
      h('h3', {}, 'Keyboard shortcuts'),
      h('div', { class: 'card' }, h('div', { class: 'shortcuts' },
        ...[['Space', 'Play / pause'], ['R', 'Record / stop recording'], ['S', 'Stop (return to start point)'], ['Enter / Home', 'Return to zero'], ['← →', 'Previous / next bar or marker'], ['1 – 4', 'Arm track'], ['L', 'Loop on/off'], ['M', 'Metronome on/off'], ['D', 'Drum machine'], ['K', 'Add marker'], ['B', 'Split selected clip at playhead'], ['Delete', 'Delete selected clip'], ['Ctrl/⌘ Z', 'Undo'], ['Ctrl/⌘ Shift Z', 'Redo'], ['+ / −', 'Zoom'], ['N', 'Song notes'], ['E', 'Export']].flatMap(([k, d]) => [h('span', { class: 'kbd' }, k), h('span', {}, d)]))),
      h('h3', {}, 'About'),
      h('div', { class: 'card' }, h('p', { class: 'muted', style: 'margin:0' }, `Pocket Four-Track ${APP_VERSION} · project format v${FORMAT_VERSION}. Everything stays on this device — no account, no cloud. Recordings are stored as 32-bit float audio in your browser's storage.`))));
    showLat();
  },
  saveSettings() { Store.kvSet('settings', { ...this.settings }).catch(() => { }); Object.assign(this.engine.settings, this.settings); },

  /* ================= transport + keys ================= */
  bindTransport() {
    const press = (id, fn) => { const el = $(id); el.addEventListener('click', () => { this.haptic(); fn(); }); };
    press('#kPlay', () => this.engine.isRunning() ? null : this.play());
    press('#kPause', () => this.pause());
    press('#kStop', () => this.stop());
    press('#kRec', () => this.record());
    press('#kRtz', () => { this.seek(0); this.tl.ensureVisible(0, false); });
    press('#kRew', () => this.jump(-1));
    press('#kFf', () => this.jump(1));
  },
  bindKeys() {
    document.addEventListener('keydown', e => {
      if (e.target.matches('input[type=text],input[type=search],input[type=number],textarea,select')) return;
      if (!$('#sheetHost').hidden && e.key === 'Escape') { this.closeSheet(); return; }
      const mod = e.ctrlKey || e.metaKey, k = e.key;
      if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); this.redo(); return; }
      if (mod || e.altKey) return;
      const map = {
        ' ': () => this.engine.isRunning() ? this.pause() : this.play(),
        r: () => this.record(), s: () => this.stop(), p: () => this.pause(),
        Enter: () => this.seek(0), Home: () => this.seek(0),
        ArrowLeft: () => this.jump(-1), ArrowRight: () => this.jump(1),
        l: () => this.toggleLoop(), m: () => $('#btnClick').click(), d: () => this.drumsSheet(), k: () => this.addMarker(),
        b: () => this.clipAction('split'), Delete: () => this.clipAction('delete'), Backspace: () => this.clipAction('delete'),
        '+': () => $('#btnZoomIn').click(), '=': () => $('#btnZoomIn').click(), '-': () => $('#btnZoomOut').click(),
        n: () => this.notesSheet(), e: () => this.exportSheet(), t: () => this.tempoSheet(),
        1: () => this.toggleArm(0), 2: () => this.toggleArm(1), 3: () => this.toggleArm(2), 4: () => this.toggleArm(3),
      };
      const f = map[k] || map[k.toLowerCase && k.toLowerCase()];
      if (f && $('#sheetHost').hidden) { e.preventDefault(); f(); }
    });
  },
};

window.P4 = App;
window.addEventListener('DOMContentLoaded', () => App.start());
