// background worker: walks drives, converts to wav, reads tags, detects bpm/key/note, measures sound for the map.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const K = require('./keys');
const { kindOf } = require('./classify');
const { features, VERSION: ANA } = require('./features');

// packaged binaries: electron puts them in app.asar.unpacked when built
const fix = (p) => p.replace('app.asar', 'app.asar.unpacked');
const FFMPEG = fix(require('ffmpeg-static'));
const FFPROBE = fix(require('ffprobe-static').path);

const AUDIO_EXT = new Set([
  'wav', 'wave', 'bwf', 'aif', 'aiff', 'aifc', 'flac', 'mp3', 'mp2', 'ogg', 'oga', 'opus',
  'm4a', 'aac', 'alac', 'wma', 'caf', 'w64', 'rf64', 'wv', 'ape', 'au', 'snd', 'voc', 'amr',
  'ac3', 'mka', 'tta', 'dsf', 'dff',
]);
const ZIP_EXT = new Set(['audioloop', 'musicloop']); // studio one: zip with wav/flac inside
const CANT_DECODE = new Set(['rx2', 'rex', 'rcy', 'soundx', 'ncw']); // proprietary, ffmpeg can't read

const SKIP_DIRS = new Set([
  'windows', '$recycle.bin', 'system volume information', 'node_modules', '.git',
  '$windows.~bt', '$windows.~ws', 'recovery', 'msocache',
]);

let essentia = null;
function getEssentia() {
  if (!essentia) {
    const { EssentiaWASM, Essentia } = require('essentia.js');
    essentia = new Essentia(EssentiaWASM);
  }
  return essentia;
}

const ext = (p) => path.extname(p).slice(1).toLowerCase();
const idOf = (p) => crypto.createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 16);

function run(cmd, args, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const ps = spawn(cmd, args, { windowsHide: true });
    const out = [];
    let err = '';
    ps.stdout.on('data', (d) => out.push(d));
    ps.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    ps.on('error', reject);
    ps.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `exit ${code}`));
      const buf = Buffer.concat(out);
      resolve(binary ? buf : buf.toString('utf8'));
    });
  });
}

// ---------- walking ----------

async function listRoots() {
  if (process.platform !== 'win32') return ['/'];
  const roots = [];
  for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    try { await fsp.access(`${L}:\\`); roots.push(`${L}:\\`); } catch {}
  }
  return roots;
}

async function* walk(dir, skipAbs) {
  let d;
  try { d = await fsp.opendir(dir); } catch { return; }
  const subdirs = [];
  try {
    for await (const e of d) {
      const full = path.join(dir, e.name);
      // symlinks/junctions are skipped on purpose (windows has junction loops)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
        if (skipAbs.some((s) => full.toLowerCase() === s)) continue;
        subdirs.push(full);
      } else if (e.isFile() && !e.name.startsWith('._')) { // "._" = macOS metadata next to the real file, not audio
        yield full;
      }
    }
  } catch { /* permission denied mid-listing: keep what we got */ }
  for (const sd of subdirs) yield* walk(sd, skipAbs);
}

// ---------- tags ----------

async function probe(file) {
  const out = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-select_streams', 'a:0', file]);
  const j = JSON.parse(out);
  const s = (j.streams || [])[0];
  if (!s) throw new Error('no audio stream');
  const tags = {};
  for (const src of [j.format && j.format.tags, s.tags]) {
    if (src) for (const [k, v] of Object.entries(src)) tags[k.toLowerCase()] = v;
  }
  return {
    codec: s.codec_name,
    sampleFmt: s.sample_fmt,
    bits: parseInt(s.bits_per_raw_sample || s.bits_per_sample || '0', 10),
    sampleRate: parseInt(s.sample_rate, 10),
    channels: s.channels,
    duration: parseFloat(s.duration || (j.format && j.format.duration) || '0'),
    tags,
  };
}

// ACID chunk: tempo is a float32 at byte 20, flags bit 0 = one-shot
function readAcid(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') { fs.closeSync(fd); return null; }
    const size = fs.fstatSync(fd).size;
    let pos = 12;
    const ch = Buffer.alloc(8);
    while (pos + 8 <= size) {
      fs.readSync(fd, ch, 0, 8, pos);
      const id = ch.toString('ascii', 0, 4);
      const len = ch.readUInt32LE(4);
      if (id === 'acid' && len >= 24) {
        const b = Buffer.alloc(24);
        fs.readSync(fd, b, 0, 24, pos + 8);
        fs.closeSync(fd);
        const oneShot = (b.readUInt32LE(0) & 1) === 1;
        const tempo = b.readFloatLE(20);
        return { oneShot, tempo: !oneShot && tempo > 20 && tempo < 400 ? tempo : null };
      }
      pos += 8 + len + (len & 1);
    }
    fs.closeSync(fd);
  } catch {}
  return null;
}

function tagBpm(tags) {
  for (const k of ['tbpm', 'bpm', 'tempo']) {
    const v = parseFloat(tags[k]);
    if (v > 20 && v < 400) return v;
  }
  return null;
}
function tagKey(tags) {
  for (const k of ['tkey', 'initialkey', 'key']) {
    const r = K.keyFromTag(tags[k]);
    if (r) return r;
  }
  return null;
}

// ---------- studio one loops ----------

// returns { audioPath (temp file), tempo, key } — audioloop/musicloop are zip files
function unpackLoop(file, tmpDir) {
  let zip = new AdmZip(file);
  let entries = zip.getEntries();
  // musicloop can hold an audioloop inside it
  const nested = entries.find((e) => /\.audioloop$/i.test(e.entryName));
  if (nested) { zip = new AdmZip(nested.getData()); entries = zip.getEntries(); }

  let tempo = null;
  let key = null;
  for (const e of entries) {
    if (!/\.xml$/i.test(e.entryName)) continue;
    const xml = e.getData().toString('utf8');
    const t = xml.match(/\btempo\s*=\s*"([\d.]+)"/i);
    if (t && !tempo) tempo = parseFloat(t[1]);
  }
  const audio = entries
    .filter((e) => /\.(wav|flac|aif|aiff)$/i.test(e.entryName))
    .sort((a, b) => b.header.size - a.header.size)[0];
  if (!audio) throw new Error('no audio inside loop file');
  const out = path.join(tmpDir, crypto.randomBytes(6).toString('hex') + path.extname(audio.entryName));
  fs.writeFileSync(out, audio.getData());
  return { audioPath: out, tempo: tempo > 20 && tempo < 400 ? tempo : null, key };
}

// ---------- conversion ----------

const LOSSLESS = new Set(['flac', 'alac', 'wavpack', 'ape', 'tta', 'mlp', 'truehd']);

function pcmCodecFor(p) {
  if (p.codec.startsWith('pcm_')) {
    if (/f64|f32|flt|dbl/.test(p.codec) || /flt|dbl/.test(p.sampleFmt)) return 'pcm_f32le';
    if (p.bits && p.bits <= 8) return 'pcm_s16le';
    if (p.bits && p.bits <= 16) return 'pcm_s16le';
    if (p.bits && p.bits <= 24) return 'pcm_s24le';
    return 'pcm_s32le';
  }
  if (LOSSLESS.has(p.codec)) {
    if (/flt|dbl/.test(p.sampleFmt)) return 'pcm_f32le';
    if (p.bits && p.bits <= 16) return 'pcm_s16le';
    if (p.bits && p.bits <= 24) return 'pcm_s24le';
    return 'pcm_s32le';
  }
  return 'pcm_s24le'; // lossy (mp3/ogg/aac...): 24-bit holds everything the decoder puts out
}

function isPlainWav(file, p) {
  return /^(wav|wave|bwf)$/.test(ext(file)) && p.codec.startsWith('pcm_');
}

function uniqueOut(libDir, srcFile) {
  const folder = path.basename(path.dirname(srcFile)) || 'root';
  const dir = path.join(libDir, folder.replace(/[:*?"<>|]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(srcFile, path.extname(srcFile)).replace(/[:*?"<>|]/g, '_');
  let out = path.join(dir, base + '.wav');
  let n = 2;
  while (fs.existsSync(out)) out = path.join(dir, `${base} (${n++}).wav`);
  return out;
}

async function convert(src, p, outFile) {
  await run(FFMPEG, [
    '-v', 'error', '-y', '-i', src, '-map', '0:a:0', '-vn',
    '-c:a', pcmCodecFor(p), '-ar', String(p.sampleRate), '-ac', String(p.channels),
    '-rf64', 'auto', '-map_metadata', '0', outFile,
  ]);
}

// ---------- detection ----------

function snapLoopBpm(bpm, dur) {
  // trimmed loops: if a whole number of 4/4 bars fits the detected tempo, use the exact value
  for (const bars of [1, 2, 4, 8, 16, 32]) {
    const exact = (bars * 4 * 60) / dur;
    if (Math.abs(exact - bpm) / bpm < 0.03) return Math.round(exact * 100) / 100;
  }
  return Math.round(bpm * 10) / 10;
}

// first `secs` seconds as mono 44.1k floats
async function decodeMono(wavFile, secs) {
  const raw = await run(FFMPEG, ['-v', 'error', '-t', String(secs), '-i', wavFile, '-ac', '1', '-ar', '44100', '-f', 'f32le', 'pipe:1'], { binary: true });
  return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
}

// a one-shot's note: essentia's yin (fft) pitch per frame, the most common note among confident frames.
// on 476 of flah's one-shots with the note in the name: gives a note on 85%, right on 96% of those
// (the key detector, used before, was right on 88% and always answered)
function noteOf(x) {
  const e = getEssentia();
  const frame = 4096, hop = 2048; // hop 1024 was no more accurate, at twice the time
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const count = {};
  let best = null, frames = 0;
  for (let s = 0; s + frame <= x.length; s += hop) {
    const fr = x.subarray(s, s + frame);
    let rms = 0;
    for (let i = 0; i < frame; i++) rms += fr[i] * fr[i];
    if (Math.sqrt(rms / frame) < peak * 0.03) continue; // about 30 dB under the peak: tail, skip
    const v = e.arrayToVector(fr);
    const w = e.Windowing(v, true, frame, 'hann');
    const sp = e.Spectrum(w.frame, frame);
    const p = e.PitchYinFFT(sp.spectrum, frame, true, 4200, 25, 44100, 1);
    v.delete(); w.frame.delete(); sp.spectrum.delete();
    if (!(p.pitch > 0 && p.pitchConfidence >= 0.8)) continue;
    const m = Math.round(69 + 12 * Math.log2(p.pitch / 440));
    count[m] = (count[m] || 0) + 1;
    frames++;
    if (best == null || count[m] > count[best]) best = m;
  }
  return frames >= 3 ? K.PITCHES[((best % 12) + 12) % 12] : null;
}

// features for the map, plus a note for one-shots whose name doesn't state one. x = decoded audio (or null)
async function analyse(wavFile, dur, wantNote, x) {
  if (!x) x = await decodeMono(wavFile, 3);
  const head = x.subarray(0, 44100 * 3);
  return { feat: features(head, 44100, dur), note: wantNote ? noteOf(head) : undefined };
}

async function detect(samples, dur, needBpm, needKey) {
  const e = getEssentia();
  const v = e.arrayToVector(samples);
  const res = {};
  try {
    if (needBpm && dur >= 2) {
      const r = e.RhythmExtractor2013(v, 208, 'multifeature', 40);
      // essentia docs: confidence (1.5, 3.5] = good, below that = not worth showing
      if (r.bpm > 0 && r.confidence > 1.5) res.bpm = snapLoopBpm(r.bpm, dur);
      for (const k of Object.keys(r)) if (r[k] && typeof r[k].delete === 'function') r[k].delete();
    }
    if (needKey) {
      const k = e.KeyExtractor(v);
      const root = K.normRoot(k.key);
      if (root) res.key = { root, scale: k.scale === 'minor' ? 'minor' : 'major' };
    }
  } finally {
    v.delete();
  }
  return res;
}

// ---------- per file ----------

// fast "same file?" fingerprint: size + first and last 64KB. reads ~128KB instead of the whole file.
function quickHash(file, size) {
  const h = crypto.createHash('sha1').update(String(size));
  const fd = fs.openSync(file, 'r');
  try {
    const n = Math.min(65536, size);
    const a = Buffer.alloc(n);
    fs.readSync(fd, a, 0, n, 0);
    h.update(a);
    if (size > n) {
      const b = Buffer.alloc(n);
      fs.readSync(fd, b, 0, n, size - n);
      h.update(b);
    }
  } finally { fs.closeSync(fd); }
  return h.digest('hex').slice(0, 20);
}

async function processFile(file, st, libDir, tmpDir, prevWav, hashes) {
  const e = ext(file);
  const rec = {
    id: idOf(file), path: file, name: path.basename(file), folder: path.dirname(file),
    ext: e, size: st.size, mtime: st.mtimeMs,
  };
  let src = file;
  let loop = null;
  try {
    rec.qhash = quickHash(file, st.size);
    if (ZIP_EXT.has(e)) { loop = unpackLoop(file, tmpDir); src = loop.audioPath; }
    const p = await probe(src);
    rec.duration = p.duration; rec.sampleRate = p.sampleRate; rec.channels = p.channels;

    if (!loop && isPlainWav(file, p)) {
      rec.wav = file;
    } else {
      // same file already converted (maybe from another folder)? reuse that wav, no duplicate
      const have = hashes && hashes.get(rec.qhash);
      const existing = have && (await have);
      if (existing && fs.existsSync(existing)) {
        rec.wav = existing;
      } else {
        const inLib = prevWav && prevWav.toLowerCase().startsWith(path.resolve(libDir).toLowerCase());
        rec.wav = inLib ? prevWav : uniqueOut(libDir, file);
        const out = rec.wav;
        const job = convert(src, p, out).then(() => out);
        if (hashes) hashes.set(rec.qhash, job.catch(() => null));
        await job;
      }
    }

    // bpm: loop file / tag / acid chunk / filename, else detect
    const acid = readAcid(rec.wav);
    rec.acidOneShot = !!(acid && acid.oneShot);
    let bpm = (loop && loop.tempo) || tagBpm(p.tags) || (acid && acid.tempo);
    rec.bpmSrc = bpm ? 'tag' : null;
    if (!bpm) { bpm = K.bpmFromName(rec.name); if (bpm) rec.bpmSrc = 'name'; }
    let key = (loop && loop.key) || tagKey(p.tags);
    rec.keySrc = key ? 'tag' : null;
    if (!key) { key = K.keyFromName(rec.name); if (key) rec.keySrc = 'name'; }
    if (!key) { const note = K.noteFromName(rec.name); if (note) { key = { root: note, scale: null }; rec.keySrc = 'name'; } }
    const folderKey = key ? null : K.keyFromFolder(rec.folder);

    // tempo: none on short hits, it's noise there
    const short = (acid && acid.oneShot) || p.duration < 1.5;
    let x = null;
    try {
      if (!bpm && !short) {
        x = await decodeMono(rec.wav, 30);
        const d = await detect(x, p.duration, true, false);
        if (d.bpm) { bpm = d.bpm; rec.bpmSrc = 'auto'; }
      }
      rec.bpm = bpm || null;
      rec.duration = p.duration;
      // loops get a key (folder name, else the key detector). one-shots get a note: the name's, else detected.
      // a folder's key says nothing about one hit inside it
      const oneshot = kindOf(rec) === 'oneshot';
      if (!oneshot && !key && folderKey) { key = folderKey; rec.keySrc = 'folder'; }
      if (!oneshot && !short && (!key || !key.scale)) {
        if (!x) x = await decodeMono(rec.wav, 30);
        const d = await detect(x, p.duration, false, true);
        if (d.key) {
          if (key && !key.scale && key.root === d.key.root) key.scale = d.key.scale;
          else if (!key) { key = d.key; rec.keySrc = 'auto'; }
        }
      }
      const a = await analyse(rec.wav, p.duration, oneshot && !key, x);
      rec.feat = a.feat;
      rec.ana = ANA;
      if (a.note) { key = { root: a.note, scale: null }; rec.keySrc = 'auto'; }
    } catch (err) { rec.detectError = String(err.message || err); }
    rec.bpm = bpm || null;
    rec.key = key ? key.root : null;
    rec.scale = key ? key.scale : null;
  } catch (err) {
    rec.error = String(err.message || err).split(': ').pop().slice(0, 300);
  } finally {
    if (loop) fs.rm(loop.audioPath, { force: true }, () => {});
  }
  return rec;
}

// an older sample: measure it, and give one-shots a note unless their name, tags or you stated one.
// the key detector's guess (or a folder's key) on a one-shot gives way to the detected note, or to nothing
async function backfill(r) {
  const stated = r.keySrc === 'tag' || r.keySrc === 'name' || r.keySrc === 'user';
  const oneshot = kindOf(r) === 'oneshot';
  const a = await analyse(r.wav, r.duration, oneshot && !stated);
  const patch = { feat: a.feat, ana: ANA };
  if (oneshot && !stated) Object.assign(patch, { key: a.note || null, scale: null, keySrc: a.note ? 'auto' : null });
  return patch;
}

// ---------- main loop ----------

async function scan({ libDir, known, roots, hashList }) {
  const hashes = new Map(hashList || []);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-'));
  fs.mkdirSync(libDir, { recursive: true });
  const skipAbs = [path.resolve(libDir).toLowerCase()];
  const scanRoots = roots && roots.length ? roots : await listRoots();
  const stats = { seen: 0, audio: 0, done: 0, skipped: 0, failed: 0, analysed: 0, cantDecode: {} };
  const done = new Set(); // processed in full this scan
  const limit = Math.max(2, Math.min(6, os.cpus().length - 1));
  const active = new Set();
  let lastPost = 0;
  const progress = (current) => {
    const now = Date.now();
    if (now - lastPost > 250) { lastPost = now; parentPort.postMessage({ type: 'progress', stats, current }); }
  };

  // entries from before fingerprints existed: fingerprint their sources up front so copies
  // found later in this scan reuse the existing wav instead of converting again
  for (const [id, prev] of Object.entries(known)) {
    if (prev.qhash || !prev.wav || !prev.path || prev.wav === prev.path) continue;
    try {
      const st = fs.statSync(prev.path);
      const qhash = quickHash(prev.path, st.size);
      prev.qhash = qhash;
      if (!hashes.has(qhash) && fs.existsSync(prev.wav)) hashes.set(qhash, prev.wav);
      parentPort.postMessage({ type: 'patch', id, patch: { qhash } });
    } catch {}
  }

  for (const root of scanRoots) {
    for await (const file of walk(root, skipAbs)) {
      stats.seen++;
      const e = ext(file);
      if (CANT_DECODE.has(e)) { stats.cantDecode[e] = (stats.cantDecode[e] || 0) + 1; continue; }
      if (!AUDIO_EXT.has(e) && !ZIP_EXT.has(e)) { if (stats.seen % 2000 === 0) progress(file); continue; }
      stats.audio++;
      let st;
      try { st = await fsp.stat(file); } catch { continue; }
      const prev = known[idOf(file)];
      if (prev && prev.size === st.size && Math.abs(prev.mtime - st.mtimeMs) < 1 && !prev.error && (!prev.wav || fs.existsSync(prev.wav))) {
        stats.skipped++;
        // older entries have no fingerprint yet: add one without redoing the file
        if (!prev.qhash) {
          try { parentPort.postMessage({ type: 'patch', id: idOf(file), patch: { qhash: quickHash(file, st.size) } }); } catch {}
        }
        progress(file); continue;
      }
      done.add(idOf(file));
      const job = processFile(file, st, libDir, tmpDir, prev && prev.wav, hashes).then((rec) => {
        if (rec.error) stats.failed++; else stats.done++;
        parentPort.postMessage({ type: 'record', rec });
        progress(file);
      });
      active.add(job);
      job.finally(() => active.delete(job));
      if (active.size >= limit) await Promise.race(active);
    }
  }
  // samples already on the shelf that haven't been measured for the map yet (main marks them with "need")
  for (const [id, prev] of Object.entries(known)) {
    if (!prev.need || done.has(id) || !prev.wav || !fs.existsSync(prev.wav)) continue;
    const job = backfill(prev.need).then((patch) => {
      stats.analysed++;
      parentPort.postMessage({ type: 'patch', id, patch });
      progress(prev.path);
    }, () => { stats.analysed++; });
    active.add(job);
    job.finally(() => active.delete(job));
    if (active.size >= limit) await Promise.race(active);
  }
  await Promise.all(active);
  fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  parentPort.postMessage({ type: 'done', stats });
}

if (parentPort) {
  parentPort.on('message', (msg) => {
    if (msg.type === 'scan') scan(msg).catch((err) => parentPort.postMessage({ type: 'fatal', error: String(err.stack || err) }));
  });
}

module.exports = { processFile, pcmCodecFor, snapLoopBpm };
