'use strict';
/* ===== Project model: 4 tracks → clips → takes. Pure functions; no audio here. ===== */

const TRACK_COLORS = ['#e8a33d', '#d9654b', '#7fa88b', '#7f9cc8', '#c58ad0', '#d6c36a'];

function newProject(name) {
  const now = Date.now();
  return {
    id: uid('p_'), name: name || defaultProjectName(), created: now, modified: now, opened: now,
    formatVersion: FORMAT_VERSION,
    bpm: 100, tsNum: 4, tsDen: 4,
    tracks: [0, 1, 2, 3].map(i => ({
      name: ['Track 1', 'Track 2', 'Track 3', 'Track 4'][i], color: TRACK_COLORS[i],
      vol: 0.8, pan: 0, mute: false, solo: false, arm: i === 0, input: 'mix',
      fx: { lowcut: false, low: 0, mid: 0, high: 0, comp: 0, reverb: 0 },
    })),
    clips: [], nextZ: 1,
    loop: { on: false, start: 0, end: 4 * 60 / 100 * 2 },
    markers: [], notes: '',
    click: { on: false, vol: 0.7, sound: 'wood', countIn: 1, duringPlay: true },
    drums: { on: false, pattern: 'rock', vol: 0.6 },
    master: { vol: 0.9, reverbSize: 'room' },
    view: { pxPerSec: 40, scroll: 0, snap: 'beat' },
    position: 0,
  };
}
function defaultProjectName() {
  const d = new Date();
  return 'Idea ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
/** Fill in any missing fields (older/newer project files). */
function normalizeProject(p) {
  const d = newProject(p.name);
  const out = Object.assign(d, p);
  out.tracks = d.tracks.map((t, i) => Object.assign({}, t, (p.tracks || [])[i] || {}, { fx: Object.assign({}, t.fx, ((p.tracks || [])[i] || {}).fx || {}) }));
  ['loop', 'click', 'drums', 'master', 'view'].forEach(k => out[k] = Object.assign({}, d[k], p[k] || {}));
  out.clips = (p.clips || []).filter(c => c.takes && c.takes.length);
  out.clips.forEach(c => { if (!c.takes.some(t => t.id === c.active)) c.active = c.takes[c.takes.length - 1].id; });
  out.nextZ = Math.max(out.nextZ || 1, ...out.clips.map(c => (c.z || 0) + 1));
  out.markers = p.markers || [];
  return out;
}

const beatDur = p => 60 / p.bpm;
const barDur = p => beatDur(p) * p.tsNum;
const activeTake = c => c.takes.find(t => t.id === c.active) || c.takes[c.takes.length - 1];
const contentEnd = p => p.clips.reduce((m, c) => Math.max(m, c.end), 0);
function referencedAudio(p) { const s = new Set(); p.clips.forEach(c => c.takes.forEach(t => s.add(t.audioId))); return s; }

/** Visible segments for one track: newest (highest z) clip wins where clips overlap. */
function trackSegments(p, track) {
  let segs = [];
  const clips = p.clips.filter(c => c.track === track && c.end > c.start).sort((a, b) => a.z - b.z);
  for (const c of clips) {
    const next = [];
    for (const s of segs) {
      if (s.to <= c.start || s.from >= c.end) { next.push(s); continue; }
      if (s.from < c.start) next.push({ clip: s.clip, from: s.from, to: c.start });
      if (s.to > c.end) next.push({ clip: s.clip, from: c.end, to: s.to });
    }
    next.push({ clip: c, from: c.start, to: c.end });
    segs = next;
  }
  return segs.sort((a, b) => a.from - b.from);
}

function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

/**
 * Insert newly recorded takes on a track.
 * takes: [{audioId, srcStart, length(sec), complete?}] — one per loop pass (or one).
 * Returns the clip that received them.
 */
function addRecordedTakes(p, track, takes, opts = {}) {
  if (!takes.length) return null;
  const now = Date.now();
  let from = Math.min(...takes.map(t => t.srcStart)), to = Math.max(...takes.map(t => t.srcStart + t.length));
  if (opts.loop) { from = Math.max(from, opts.loop.start); to = Math.min(to, opts.loop.end); if (to - from < 0.05) { from = opts.loop.start; to = opts.loop.end; } }
  // find the existing clip with the most overlap
  let best = null, bestOv = 0;
  for (const c of p.clips) {
    if (c.track !== track) continue;
    const ov = overlap(c.start, c.end, from, to);
    if (ov > bestOv) { bestOv = ov; best = c; }
  }
  let clip;
  // same section (≥60% of the longer of the two) → new take; otherwise a new clip on top (punch-in)
  if (best && bestOv >= 0.6 * Math.max(best.end - best.start, to - from)) {
    clip = best;
    clip.start = Math.max(0, Math.min(clip.start, from)); clip.end = Math.max(clip.end, to);
    clip.z = p.nextZ++;
  } else {
    clip = { id: uid('c_'), track, start: Math.max(0, from), end: to, z: p.nextZ++, takes: [], active: null };
    p.clips.push(clip);
  }
  let n = clip.takes.length;
  const newOnes = takes.map(t => ({ id: uid('t_'), audioId: t.audioId, srcStart: t.srcStart, length: t.length, name: 'Take ' + (++n), fav: false, created: now, complete: t.complete !== false }));
  clip.takes.push(...newOnes);
  // active = newest complete take (loop recording may end in a partial pass)
  const pick = [...newOnes].reverse().find(t => t.complete) || newOnes[newOnes.length - 1];
  clip.active = pick.id;
  return clip;
}

function findClip(p, id) { return p.clips.find(c => c.id === id); }

function splitClip(p, clipId, t) {
  const c = findClip(p, clipId);
  if (!c || t <= c.start + 0.01 || t >= c.end - 0.01) return null;
  const b = deepClone(c);
  b.id = uid('c_'); b.start = t; b.z = p.nextZ++;
  // takes keep their audio ids & positions: both halves reference the same audio (non-destructive)
  b.takes.forEach(tk => { tk.id = uid('t_'); });
  b.active = b.takes[c.takes.findIndex(tk => tk.id === c.active)].id;
  c.end = t;
  p.clips.push(b);
  return b;
}
function moveClip(p, clipId, newStart, newTrack) {
  const c = findClip(p, clipId); if (!c) return;
  const d = newStart - c.start;
  c.start += d; c.end += d; c.takes.forEach(t => t.srcStart += d);
  if (newTrack != null) c.track = newTrack;
  c.z = p.nextZ++;
}
/** Trim window; can extend back out to the full recorded audio of the active take (and no further than any take's audio). */
function trimClip(p, clipId, newStart, newEnd) {
  const c = findClip(p, clipId); if (!c) return;
  const lo = Math.min(...c.takes.map(t => t.srcStart)), hi = Math.max(...c.takes.map(t => t.srcStart + (t.length || 0)));
  if (newStart != null) c.start = clamp(newStart, lo, c.end - 0.02);
  if (newEnd != null) c.end = clamp(newEnd, c.start + 0.02, hi);
}
function duplicateClipAfter(p, clipId) {
  const c = findClip(p, clipId); if (!c) return null;
  const b = deepClone(c); const len = c.end - c.start;
  b.id = uid('c_'); b.takes.forEach(t => { t.id = uid('t_'); t.srcStart += len; });
  b.active = b.takes[c.takes.findIndex(t => t.id === c.active)].id;
  b.start += len; b.end += len; b.z = p.nextZ++;
  p.clips.push(b); return b;
}
function deleteClip(p, clipId) { p.clips = p.clips.filter(c => c.id !== clipId); }
function deleteTake(p, clipId, takeId) {
  const c = findClip(p, clipId); if (!c) return;
  const idx = c.takes.findIndex(t => t.id === takeId); if (idx < 0) return;
  const wasActive = c.active === takeId;
  c.takes.splice(idx, 1);
  if (!c.takes.length) { deleteClip(p, clipId); return; }
  if (wasActive) c.active = c.takes[Math.min(idx, c.takes.length - 1)].id;
}
/** Move a take out into its own new clip on the same track (keeps audio). */
function takeToNewClip(p, clipId, takeId) {
  const c = findClip(p, clipId); if (!c || c.takes.length < 2) return null;
  const t = c.takes.find(x => x.id === takeId); if (!t) return null;
  deleteTake(p, clipId, takeId);
  const n = { id: uid('c_'), track: c.track, start: t.srcStart, end: t.srcStart + t.length, z: p.nextZ++, takes: [t], active: t.id };
  p.clips.push(n); return n;
}
function snapTime(p, t, mode) {
  if (mode === 'off') return t;
  const g = mode === 'bar' ? barDur(p) : beatDur(p);
  return Math.round(t / g) * g;
}

/* ---------- Undo / redo (snapshots; audio is immutable so snapshots are small) ---------- */
class History {
  constructor(limit = 80) { this.undo = []; this.redo = []; this.limit = limit; }
  static snap(p) { const { view, position, opened, ...rest } = p; return JSON.stringify(rest); }
  push(p, label) { this.undo.push({ s: History.snap(p), label }); if (this.undo.length > this.limit) this.undo.shift(); this.redo = []; }
  canUndo() { return this.undo.length > 0; }
  canRedo() { return this.redo.length > 0; }
  _apply(p, s) { const o = JSON.parse(s); Object.keys(o).forEach(k => p[k] = o[k]); }
  doUndo(p) { const e = this.undo.pop(); if (!e) return null; this.redo.push({ s: History.snap(p), label: e.label }); this._apply(p, e.s); return e.label; }
  doRedo(p) { const e = this.redo.pop(); if (!e) return null; this.undo.push({ s: History.snap(p), label: e.label }); this._apply(p, e.s); return e.label; }
  clear() { this.undo = []; this.redo = []; }
}
