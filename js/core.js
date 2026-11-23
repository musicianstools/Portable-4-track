'use strict';
/* ===== Core operations shared by the app and the test harness ===== */

/** Persist the audio of a finished recording, then insert takes into the project.
 *  Audio is written (transaction complete) BEFORE the project references it. */
async function commitRecording(engine, p, result, sr) {
  const clips = [];
  for (const tr of result.tracks) {
    if (!tr.takes.length) continue;
    const stored = [];
    for (const tk of tr.takes) {
      const audioId = uid('a_');
      const peaks = computePeaks(tk.data, PEAK_BLOCK);
      await Store.putAudio({ id: audioId, projectId: p.id, sr, length: tk.data.length, data: tk.data.buffer.slice(tk.data.byteOffset, tk.data.byteOffset + tk.data.byteLength), peaks: peaks.buffer, created: Date.now() });
      engine.addBuffer(audioId, tk.data, sr, peaks);
      stored.push({ audioId, srcStart: tk.srcStart, length: tk.data.length / sr, complete: tk.complete });
    }
    const clip = addRecordedTakes(p, tr.track, stored, { loop: result.loop });
    if (clip) clips.push(clip);
  }
  return clips;
}

/** Rebuild takes from an interrupted recording's journal. */
async function recoverJournal(meta) {
  const rows = await Store.readJournal(meta.recId);
  const chunks = rows.map(r => ({ frame: r.frame, l: new Float32Array(r.l), r: r.r ? new Float32Array(r.r) : null }));
  const res = assembleRecording(chunks, meta);
  res.loop = meta.loop;
  return res;
}

/** Remove audio records that the project no longer references (call only when no undo history exists). */
async function collectGarbage(p) {
  const keep = referencedAudio(p);
  const keys = await Store.audioKeysFor(p.id);
  const dead = keys.filter(k => !keep.has(k));
  if (dead.length) await Store.deleteAudio(dead);
  return dead.length;
}

/* ---------- backup package (.4track.zip) ---------- */
async function exportProjectPackage(p) {
  const entries = [];
  const audioIds = [...referencedAudio(p)];
  const manifest = { format: 'pocket-four-track', formatVersion: FORMAT_VERSION, appVersion: APP_VERSION, exported: new Date().toISOString(), projectId: p.id, name: p.name, audio: [] };
  for (const id of audioIds) {
    const rec = await Store.getAudio(id);
    if (!rec) throw new Error('A recording is missing from storage; the backup would be incomplete. (' + id + ')');
    const wav = encodeWav([new Float32Array(rec.data)], rec.sr, 32);
    entries.push({ name: `audio/${id}.wav`, data: new Uint8Array(wav) });
    manifest.audio.push({ id, file: `audio/${id}.wav`, sampleRate: rec.sr, frames: rec.length, crc32: crc32(new Uint8Array(rec.data)) });
  }
  const proj = deepClone(p);
  entries.unshift({ name: 'project.json', data: JSON.stringify(proj, null, 2) });
  entries.unshift({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });
  entries.push({ name: 'README.txt', data: `Pocket Four-Track project backup\n\nProject: ${p.name}\nExported: ${manifest.exported}\nFormat version: ${FORMAT_VERSION}\n\nproject.json holds the arrangement (tracks, clips, takes, settings).\naudio/*.wav are the original recordings (32-bit float, mono). Every take's\nposition on the song timeline is takes[].srcStart (seconds) in project.json.\nImport this whole .zip in Pocket Four-Track > Projects > Import backup.\n` });
  return zipStore(entries);
}

/** Parse + validate a backup. Returns {manifest, project, audio: Map(id → {sr, data})} or throws a clear error. */
async function readProjectPackage(arrayBuffer) {
  let files;
  try { files = await unzip(arrayBuffer); } catch (e) { throw new Error('This file is not a readable project backup. ' + e.message); }
  const dec = new TextDecoder();
  if (!files.has('manifest.json') || !files.has('project.json')) throw new Error('This zip is not a Pocket Four-Track backup (manifest.json/project.json missing).');
  let manifest, project;
  try { manifest = JSON.parse(dec.decode(files.get('manifest.json'))); project = JSON.parse(dec.decode(files.get('project.json'))); }
  catch (_) { throw new Error('The backup\'s project data is damaged and cannot be read.'); }
  if (manifest.format !== 'pocket-four-track') throw new Error('Unknown backup format.');
  if (manifest.formatVersion > FORMAT_VERSION) throw new Error(`This backup was made by a newer version (format ${manifest.formatVersion}). Please update the app.`);
  if (!project.id || !Array.isArray(project.clips)) throw new Error('The backup\'s project data is incomplete.');
  const audio = new Map(), problems = [];
  for (const id of referencedAudio(project)) {
    const f = files.get(`audio/${id}.wav`);
    if (!f) { problems.push(id); continue; }
    try {
      const w = decodeWav(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength));
      audio.set(id, { sr: w.sampleRate, data: w.channels[0] });
    } catch (e) { problems.push(id); }
  }
  return { manifest, project, audio, problems };
}

/** Store an imported package as a project. mode: 'copy' (new ids) | 'replace' */
async function importProjectPackage(pkg, mode, newName) {
  const p = normalizeProject(deepClone(pkg.project));
  const idMap = new Map();
  if (mode === 'copy') {
    p.id = uid('p_');
    for (const id of pkg.audio.keys()) idMap.set(id, uid('a_'));
  } else {
    await Store.deleteProject(p.id);
  }
  // drop takes whose audio is missing (reported to the user)
  p.clips.forEach(c => { c.takes = c.takes.filter(t => pkg.audio.has(t.audioId)); });
  p.clips = p.clips.filter(c => c.takes.length);
  p.clips.forEach(c => { if (!c.takes.some(t => t.id === c.active)) c.active = c.takes[c.takes.length - 1].id; c.takes.forEach(t => { if (idMap.has(t.audioId)) t.audioId = idMap.get(t.audioId); }); });
  if (newName) p.name = newName;
  p.modified = Date.now(); p.opened = Date.now();
  for (const [id, a] of pkg.audio) {
    const nid = idMap.get(id) || id;
    await Store.putAudio({ id: nid, projectId: p.id, sr: a.sr, length: a.data.length, data: a.data.buffer.slice(a.data.byteOffset, a.data.byteOffset + a.data.byteLength), peaks: computePeaks(a.data, PEAK_BLOCK).buffer, created: Date.now() });
  }
  await Store.saveProject(p);
  return p;
}

/** Duplicate a project including copies of all its audio. */
async function duplicateProject(src) {
  const p = deepClone(src);
  p.id = uid('p_'); p.name = src.name + ' (copy)'; p.created = p.modified = p.opened = Date.now();
  const idMap = new Map();
  for (const id of referencedAudio(src)) {
    const rec = await Store.getAudio(id); if (!rec) continue;
    const nid = uid('a_'); idMap.set(id, nid);
    await Store.putAudio({ ...rec, id: nid, projectId: p.id });
  }
  p.clips.forEach(c => c.takes.forEach(t => { t.audioId = idMap.get(t.audioId) || t.audioId; }));
  await Store.saveProject(p);
  return p;
}

/* ---------- export helpers ---------- */
function exportEnd(p) {
  const anyReverb = p.tracks.some(t => t.fx.reverb > 0);
  let end = contentEnd(p);
  return end > 0 ? end + (anyReverb ? 2.5 : 0.25) : 0;
}
async function renderMix(engine, p, withDrums) { return engine.render({ tracks: [0, 1, 2, 3], drums: withDrums, stem: false, end: exportEnd(p) }); }
async function renderStem(engine, p, tr, end) { return engine.render({ tracks: [tr], drums: false, stem: true, end }); }
async function renderDrumStem(engine, p, end) { return engine.render({ tracks: [], drums: true, stem: true, end }); }
function bufferToWav(buf, bits) { return encodeWav(Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i)), buf.sampleRate, bits); }

let lameLoading = null;
function loadLame() {
  if (window.lamejs) return Promise.resolve();
  if (lameLoading) return lameLoading;
  lameLoading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
    s.onload = () => window.lamejs ? res() : rej(new Error('MP3 encoder failed to load.'));
    s.onerror = () => { lameLoading = null; rej(new Error('MP3 encoding needs an internet connection the first time (to load the encoder). WAV export works offline.')); };
    document.head.appendChild(s);
  });
  return lameLoading;
}
async function bufferToMp3(buf, kbps = 192) {
  await loadLame();
  if (![32000, 44100, 48000].includes(buf.sampleRate)) throw new Error('MP3 needs a 32, 44.1 or 48 kHz project sample rate.');
  const enc = new lamejs.Mp3Encoder(2, buf.sampleRate, kbps);
  const toI16 = f => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); o[i] = s < 0 ? s * 0x8000 : s * 0x7fff; } return o; };
  const L = toI16(buf.getChannelData(0)), R = toI16(buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0));
  const out = []; const block = 1152;
  for (let i = 0; i < L.length; i += block) {
    const m = enc.encodeBuffer(L.subarray(i, i + block), R.subarray(i, i + block));
    if (m.length) out.push(new Uint8Array(m));
    if (i % (block * 400) === 0) await new Promise(r => setTimeout(r, 0));
  }
  const e = enc.flush(); if (e.length) out.push(new Uint8Array(e));
  return new Blob(out, { type: 'audio/mpeg' });
}
