'use strict';
/* ===== Pocket Four-Track — utilities: ids, formatting, WAV, ZIP ===== */

const APP_VERSION = '1.0.0';
const FORMAT_VERSION = 1;

function uid(prefix = '') {
  const a = new Uint8Array(10);
  crypto.getRandomValues(a);
  return prefix + Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const deepClone = o => JSON.parse(JSON.stringify(o));

function fmtTime(sec, tenths = true) {
  const neg = sec < 0; sec = Math.abs(sec);
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60), t = Math.floor((sec * 10) % 10);
  return (neg ? '-' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + (tenths ? '.' + t : '');
}
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function fmtBytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}
function safeFileName(s) { return (s || 'untitled').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'untitled'; }

/* ---------- WAV ---------- */
/** channels: Float32Array[]; bits: 16 | 24 | 32 (32 = IEEE float) */
function encodeWav(channels, sampleRate, bits = 16) {
  const nCh = channels.length, len = channels[0].length;
  const bps = bits / 8, blockAlign = nCh * bps, dataSize = len * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize), v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, bits === 32 ? 3 : 1, true);
  v.setUint16(22, nCh, true); v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true); v.setUint16(34, bits, true);
  ws(36, 'data'); v.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      let s = channels[c][i];
      if (bits === 32) { v.setFloat32(o, s, true); o += 4; continue; }
      s = s > 1 ? 1 : s < -1 ? -1 : s;
      if (bits === 16) { v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
      else { const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff); v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255); o += 3; }
    }
  }
  return buf;
}
/** Returns {sampleRate, channels: Float32Array[]} — supports PCM 8/16/24/32 and float 32/64. */
function decodeWav(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(o + i)); return s; };
  if (arrayBuffer.byteLength < 12 || str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('Not a WAV file');
  let o = 12, fmt = null, data = null;
  while (o + 8 <= v.byteLength) {
    const id = str(o, 4), size = v.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { format: v.getUint16(o + 8, true), ch: v.getUint16(o + 10, true), sr: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    else if (id === 'data') { data = { off: o + 8, size: Math.min(size, v.byteLength - o - 8) }; }
    o += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV is missing fmt or data chunk');
  let format = fmt.format;
  if (format === 0xFFFE) format = fmt.bits >= 32 && fmt.bits !== 24 ? 3 : 1; // extensible: best guess
  const bps = fmt.bits / 8, n = Math.floor(data.size / (bps * fmt.ch));
  const chs = Array.from({ length: fmt.ch }, () => new Float32Array(n));
  let p = data.off;
  for (let i = 0; i < n; i++) for (let c = 0; c < fmt.ch; c++) {
    let s;
    if (format === 3) s = bps === 4 ? v.getFloat32(p, true) : v.getFloat64(p, true);
    else if (bps === 1) s = (v.getUint8(p) - 128) / 128;
    else if (bps === 2) s = v.getInt16(p, true) / 32768;
    else if (bps === 3) { let x = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16); if (x & 0x800000) x |= ~0xffffff; s = x / 8388608; }
    else s = v.getInt32(p, true) / 2147483648;
    chs[c][i] = s; p += bps;
  }
  return { sampleRate: fmt.sr, channels: chs };
}

/* ---------- ZIP (store writer, store/deflate reader) ---------- */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

/** entries: [{name, data: Uint8Array|ArrayBuffer|string}] → Blob (uncompressed zip, ≤4GB) */
function zipStore(entries) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

/** ArrayBuffer → Map(name → Uint8Array). Verifies CRC. */
async function unzip(buf) {
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a valid zip archive (no end record) — the file may be incomplete.');
  const count = v.getUint16(eocd + 10, true); let p = v.getUint32(eocd + 16, true);
  const out = new Map(), dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Zip central directory is corrupted.');
    const method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true), csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), lo = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    const lnl = v.getUint16(lo + 26, true), lxl = v.getUint16(lo + 28, true);
    const start = lo + 30 + lnl + lxl;
    if (start + csize > buf.byteLength) throw new Error(`"${name}" is truncated — the backup is incomplete.`);
    let data = u8.slice(start, start + csize);
    if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot read compressed zips. Re-export the backup from Pocket Four-Track.');
      const ds = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      data = new Uint8Array(await new Response(ds).arrayBuffer());
    } else if (method !== 0) throw new Error(`Unsupported zip compression for "${name}".`);
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`"${name}" failed its integrity check — the backup is corrupted.`);
    out.set(name, data);
  }
  return out;
}

/* ---------- misc ---------- */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
/** Try Web Share with files (good on iOS), else download. */
async function saveOrShare(blob, filename, preferShare = false) {
  if (preferShare && navigator.canShare) {
    try {
      const f = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
      if (navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: filename }); return 'shared'; }
    } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  downloadBlob(blob, filename); return 'downloaded';
}

/** Deterministic PRNG (for reverb impulses & noise so export == playback). */
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/** min/max peaks per `block` samples */
function computePeaks(data, block = 512) {
  const n = Math.ceil(data.length / block), out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    let mn = 0, mx = 0; const e = Math.min(data.length, (i + 1) * block);
    for (let j = i * block; j < e; j++) { const s = data[j]; if (s < mn) mn = s; else if (s > mx) mx = s; }
    out[i * 2] = mn; out[i * 2 + 1] = mx;
  }
  return out;
}
const PEAK_BLOCK = 512;
